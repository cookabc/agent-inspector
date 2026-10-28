/**
 * 「删掉这条会话会带走什么」—— 五种工具的枚举契约。
 *
 * 这些测试全部在临时 HOME 里真造文件/真建库，不用 mock：
 * 这一层的价值就是"路径算得对不对"，而路径对不对只有真文件能证明。
 * mock 掉的 fs 会让测试通过、线上删错。
 *
 * 判据统一是三条：
 *   1. 该带走的都列出来了（漏 = 删完留孤儿）
 *   2. 不该带走的没列（多 = 删了别人的东西）
 *   3. 汇总口径一致（removableBytes 等于列出来的可删项之和）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { emptyContents, pushFile, addTree, removableBytes, rowCount, hasAnything } from '../lib/session-contents.mjs';
import { CONTENT_ROLES } from '../lib/tasks-shape.mjs';
import { sessionContents as zcodeContents } from '../lib/tasks-zcode.mjs';
import { sessionContents as codexContents } from '../lib/tasks-codex.mjs';
import { sessionContents as claudeContents } from '../lib/tasks-claude.mjs';
import { sessionContents as dshContents } from '../lib/tasks-dsh.mjs';
import { sessionContents as cursorContents } from '../lib/tasks-cursor.mjs';

async function tmpRoot(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `zci-content-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFile(root, rel, bytes) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, 'x'.repeat(bytes));
  return abs;
}

/* ── 形状本身 ─────────────────────────────────────────────── */

test('空清单不假装有内容', () => {
  const c = emptyContents();
  assert.equal(hasAnything(c), false, '空清单必须让界面整块不出现');
  assert.equal(removableBytes(c), 0);
  assert.equal(rowCount(c), 0);
});

test('数据层逐条保留路径：删错一个就是一个文件，不能提前合并', () => {
  const c = emptyContents();
  pushFile(c, { rel: 'a/1.png', role: 'media', bytes: 100 });
  pushFile(c, { rel: 'a/2.png', role: 'media', bytes: 250 });
  assert.equal(c.files.length, 2, '数据层必须逐条留着 —— 展示层压缩是另一回事');
  assert.equal(removableBytes(c), 350);
});

test('目录枚举只算文件、跳过空目录，读不到就把原因记进 problems', async (t) => {
  const root = await tmpRoot(t, 'tree');
  await writeFile(root, 'd/a.txt', 10);
  await writeFile(root, 'd/sub/b.txt', 20);
  await fs.mkdir(path.join(root, 'd/empty'), { recursive: true });

  const c = emptyContents();
  const problems = [];
  addTree(c, { root, rel: 'd', role: 'log', problems });
  assert.equal(problems.length, 0);
  assert.equal(c.files[0].bytes, 30);
  assert.equal(c.files[0].count, 2, '空目录不算条目');
});

/* ── ZCode ────────────────────────────────────────────────── */

test('ZCode：四类 sess_ 目录 + 模型 IO 回放都要进清单', async (t) => {
  const root = await tmpRoot(t, 'zcode');
  const id = 'sess_abc-123';
  await writeFile(root, `cli/agents/${id}/transcript.jsonl`, 100);
  await writeFile(root, `cli/artifacts/${id}/out.zip`, 200);
  await writeFile(root, `cli/image-cache/${id}/img1.png`, 300);
  await writeFile(root, `cli/image-cache/${id}/img2.png`, 50);
  await writeFile(root, `cli/exec/${id}/call_1-stdout.log`, 400);
  await writeFile(root, `cli/rollout/model-io-${id}.jsonl`, 500);

  const c = zcodeContents(root, [{ id }]).get(id);
  const byRole = Object.fromEntries(c.files.map((f) => [f.role, f]));
  assert.equal(byRole.transcript.bytes, 100);
  assert.equal(byRole.artifact.bytes, 200);
  assert.equal(byRole.media.bytes, 350, '两张贴图合并成一条');
  assert.equal(byRole.media.count, 2);
  assert.equal(byRole.log.bytes, 400);
  assert.equal(byRole.body.bytes, 500, 'model-io 回放归 body');
  assert.equal(removableBytes(c), 1550);
  assert.equal(c.dbRows.length, 0, '库行不由这个函数算（要开库）');
});

test('ZCode：会话 id 前缀必须完整匹配，sess_ 不能截断', async (t) => {
  const root = await tmpRoot(t, 'zcode-prefix');
  // 名字相近的另一条会话不能被算进来
  await writeFile(root, 'cli/image-cache/sess_abc-123-extra/img.png', 999);
  await writeFile(root, 'cli/image-cache/sess_abc-123/img.png', 10);
  const c = zcodeContents(root, [{ id: 'sess_abc-123' }]).get('sess_abc-123');
  assert.equal(c.files.length, 1);
  assert.equal(c.files[0].bytes, 10, '只算完全匹配 sess_abc-123 的那份');
});

/* ── Codex ────────────────────────────────────────────────── */

test('Codex：同一 thread 的全部分页段一起进清单', async (t) => {
  const root = await tmpRoot(t, 'codex');
  const id = '11111111-2222-3333-4444-555555555555';
  await writeFile(root, `sessions/2026/10/27/rollout-2026-10-27T10-00-00-${id}.jsonl`, 700);
  await writeFile(root, `sessions/2026/10/27/rollout-2026-10-27T11-00-00-${id}_deadbeef.jsonl`, 300);
  await writeFile(root, `archived_sessions/rollout-2026-10-26T09-00-00-${id}.jsonl`, 500);

  const c = codexContents(root, [{ id }]).get(id);
  assert.equal(c.files.length, 3, '三段各占一条：真出事时要能看见删哪三个文件');
  assert.equal(removableBytes(c), 1500);
  assert.deepEqual(c.files.map((f) => f.role), ['body', 'body', 'body']);
  assert.ok(c.notes.some((n) => n.text.includes('3 段 rollout')), '分段要在详情里说出来');
});

test('Codex：残骸行（file:<rel>）的正文就是它自己那一份', async (t) => {
  const root = await tmpRoot(t, 'codex-residual');
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await writeFile(root, `sessions/2026/10/27/rollout-2026-10-27T10-00-00-${id}.jsonl`, 900);
  const row = { id: `file:sessions/2026/10/27/rollout-2026-10-27T10-00-00-${id}.jsonl`, residual: true,
    bodyRel: `sessions/2026/10/27/rollout-2026-10-27T10-00-00-${id}.jsonl` };
  const c = codexContents(root, [row]).get(row.id);
  assert.equal(removableBytes(c), 900, '残骸也要能算出自己的正文体积');
});

/* ── Claude ───────────────────────────────────────────────── */

test('Claude：一个会话就是一个 .jsonl', async (t) => {
  const root = await tmpRoot(t, 'claude');
  await writeFile(root, 'projects/-Users-me-proj/sess-1.jsonl', 640);
  const c = claudeContents(root, [{ id: 'sess-1', bodyRel: 'projects/-Users-me-proj/sess-1.jsonl', bytes: 640 }]).get('sess-1');
  assert.equal(c.files.length, 1);
  assert.equal(c.files[0].role, 'body');
  assert.equal(removableBytes(c), 640);
});

test('Claude：正文文件已消失时不报错，清单留给上层提示', async (t) => {
  const root = await tmpRoot(t, 'claude-missing');
  const problems = [];
  const c = claudeContents(root, [{ id: 'gone', bodyRel: 'projects/x/gone.jsonl', bytes: 100 }], problems).get('gone');
  assert.equal(problems.length, 0, 'ENOENT 是预期状态，不该算问题');
  assert.equal(c.files[0].bytes, 100, '退回行上的 bytes，界面不会显示 0');
});

/* ── DSH ──────────────────────────────────────────────────── */

test('DSH：会话目录（含 lock）+ 投影都要进清单，workspace.json 只能提示', async (t) => {
  const root = await tmpRoot(t, 'dsh');
  const id = 'session-8da86cc8-9b12-418f-84cb-c1dce7bbe9c0';
  const bodyRel = `sessions/--Users-me--/${id}/session.v4.jsonl.zstd`;
  await writeFile(root, bodyRel, 800);
  await writeFile(root, `sessions/--Users-me--/${id}/session.lock`, 0);
  await writeFile(root, `storages/session_projcache/sessions/${id}.json`, 120);

  const c = dshContents(root, [{ id, bodyRel }]).get(id);
  const byRole = Object.fromEntries(c.files.map((f) => [f.role, f]));
  assert.equal(byRole.body.bytes, 800, '会话目录整体只算正文那一个带内容的文件');
  assert.ok(byRole.projection, '投影要删，否则下次启动还会显示一个空壳');
  assert.equal(byRole.projection.bytes, 120);
  assert.ok(c.notes.some((n) => n.text.includes('workspace.json')), '悬空 id 必须说清');
  assert.ok(c.files.every((f) => f.removable !== false), '文件和投影都可删');
});

/* ── Cursor ───────────────────────────────────────────────── */

test('Cursor：库外 transcript 进清单，搜索索引只提示不删', async (t) => {
  const root = await tmpRoot(t, 'cursor');
  const id = 'abcd1234-0000-0000-0000-000000000000';
  await writeFile(root, `projects/-Users-me-proj/agent-transcripts/${id}/${id}.jsonl`, 450);

  const c = cursorContents(root, [{ id }]).get(id);
  const tr = c.files.find((f) => f.role === 'transcript');
  assert.equal(tr.bytes, 450);
  assert.ok(c.notes.some((n) => n.text.includes('conversation-search.db')), '搜索索引残留必须说清');
});

test('Cursor：没有 transcript 的会话清单为空，不会画出假条目', async (t) => {
  const root = await tmpRoot(t, 'cursor-empty');
  const c = cursorContents(root, [{ id: 'no-such' }]).get('no-such');
  assert.equal(c.files.length, 0);
  assert.equal(removableBytes(c), 0);
});

/* ── 跨层枚举契约 ─────────────────────────────────────────── */

test('五个工具的枚举函数签名一致，且只产出 CONTENT_ROLES 里的角色', async (t) => {
  const root = await tmpRoot(t, 'roles');
  const id = 'sess_roles';
  await writeFile(root, `cli/image-cache/${id}/a.png`, 5);
  await writeFile(root, `storages/session_projcache/sessions/${id}.json`, 5);

  const enums = [
    ['zcode', zcodeContents, root, { id }],
    ['codex', codexContents, root, { id }],
    ['claude', claudeContents, root, { id, bodyRel: 'projects/x/a.jsonl' }],
    ['dsh', dshContents, root, { id, bodyRel: `sessions/x/${id}/session.v4.jsonl.zstd` }],
    ['cursor', cursorContents, root, { id }],
  ];
  for (const [name, fn, r, row] of enums) {
    const map = fn(r, [row], []);
    assert.ok(map instanceof Map, `${name} 要返回 Map<id, contents>`);
    const c = map.get(row.id);
    assert.ok(c, `${name} 必须给出这一行的清单（哪怕是空清单）`);
    for (const f of c.files) {
      assert.ok(CONTENT_ROLES.includes(f.role), `${name} 用了未登记的角色：${f.role}`);
      assert.equal(typeof f.bytes, 'number');
      assert.equal(typeof f.removable, 'boolean');
    }
    assert.equal(removableBytes(c), c.files.filter((f) => f.removable).reduce((s, f) => s + f.bytes, 0));
  }
});

test('五种工具里凡是「会话正文」分类都必须标 sessionOnly', async () => {
  /* 会话正文不进文件清单，判据是这个标记 —— 所以它必须五家一致。
     漏一家，那家的会话正文就会以可勾条目的形式出现在「磁盘与其他」里，
     而"在清单里挑几个正文文件删掉"正是会留下残骸的做法。 */
  const apps = ['zcode', 'codex', 'claude', 'dsh', 'cursor'];
  const { getApp } = await import('../lib/apps/index.mjs');
  const found = [];
  for (const id of apps) {
    const app = getApp(id);
    for (const meta of Object.values(app.CATEGORIES)) {
      // 只认这三档：普通正文、归档正文、分页续段
      if (['transcript', 'archivedSession', 'transcriptSegment'].includes(meta.id)) {
        assert.equal(meta.sessionOnly, true, `${id} 的 ${meta.id} 没标 sessionOnly —— 它会漏进文件清单`);
        found.push(`${id}:${meta.id}`);
      }
    }
  }
  assert.ok(found.length >= 5, `至少要覆盖五家的正文类，实际 ${found.length}：${found.join(',')}`);
});
