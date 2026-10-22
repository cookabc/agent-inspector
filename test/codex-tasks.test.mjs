test('Codex 的历史视图把三个库和磁盘正文对齐', async (t) => {
  const f = await fixture(t);
  const d = await scanTasks(f.root);

  const ids = d.tasks.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, '列表里不能有重复编号，否则界面选不中');
  assert.equal(d.totals.count, 3);

  const residual = d.tasks.find((x) => x.state === 'untracked');
  assert.ok(residual, '没有索引行认领的 rollout 文件要作为残骸出现');
  assert.ok(residual.id.startsWith('file:'), `残骸的编号用文件路径：${residual.id}`);
  assert.equal(residual.residual, true);
  // threads 的时间戳是 Unix 秒；原样交给前端会全部显示成 1970 年
  const archived = d.tasks.find((x) => x.id === ARCHIVED_ID);
  assert.equal(archived.createdAt, 1000);
  assert.equal(archived.updatedAt, 3000, '归档时间优先，单位换成毫秒');
  // 正文合计必须等于磁盘上 rollout 文件的总和 —— 少算的那块在界面上永远找不回来
  assert.equal(d.totals.bytes, d.db.bodies.bytes);
  // byState 只承载真实存在的状态桶：没有 deleted 这种永远为空的条目；
  // 各段体积加起来必须正好是总量 —— 把投影体积重复算进去会在这里暴露。
  assert.ok(d.totals.byState.every((g) => g.state !== 'deleted'), 'Codex 不该有 deleted 桶');
  assert.equal(d.totals.byState.reduce((s, g) => s + g.bytes, 0), d.totals.bytes);
});

test('空跑逐库清点，在没有 threads 表的库里也不会炸', async (t) => {
  const f = await fixture(t);
  const r = await purgeTasks(f.root, [ARCHIVED_ID], { dryRun: true, backupDir: f.backup });

  const seen = new Set(r.perDb.map((x) => x.name));
  assert.deepEqual([...seen].sort(), ['logs_2.sqlite', 'state_5.sqlite', 'thread_history_1.sqlite']);
  assert.equal(r.perDb.find((x) => x.name === 'logs_2.sqlite').count, 5);
  assert.equal(r.bodyBytes, 4096);
  // 空跑不改任何东西
  assert.equal(count(path.join(f.root, 'state_5.sqlite'), 'SELECT count(*) c FROM threads'), 2);
  await fs.access(path.join(f.root, f.rel.archivedBody));
});

test('删除跨三个库清干净，正文文件留给文件那条线', async (t) => {
  const f = await fixture(t);
  const r = await purgeTasks(f.root, [ARCHIVED_ID], { backupDir: f.backup });

  assert.equal(count(path.join(f.root, 'state_5.sqlite'), 'SELECT count(*) c FROM threads'), 1);
  assert.equal(count(path.join(f.root, 'state_5.sqlite'), 'SELECT count(*) c FROM thread_spawn_edges'), 0,
    'thread_spawn_edges 没声明外键，靠手动兜底');
  assert.equal(count(path.join(f.root, 'thread_history_1.sqlite'), 'SELECT count(*) c FROM thread_items'), 1);
  assert.equal(count(path.join(f.root, 'logs_2.sqlite'), 'SELECT count(*) c FROM logs'), 1);

  // 结构表还在 —— 删的是行，不是库
  await fs.access(path.join(f.root, 'state_5.sqlite'));

  // 正文不在库里，这次不该被抹掉
  await fs.access(path.join(f.root, f.rel.archivedBody));
  assert.equal(r.bodyBytes, 0);

  for (const b of r.integrity) {
    assert.equal(b.integrity, 'ok', `${b.name} 完整性检查没过`);
    assert.equal(b.fkViolations, 0);
  }
  assert.equal(r.integrity.length, 3);

  const backed = await fs.readdir(r.backup);
  for (const need of ['state_5.sqlite', 'thread_history_1.sqlite', 'logs_2.sqlite']) {
    assert.ok(backed.includes(need), `动手前必须先备份 ${need}`);
  }

  // 删完索引，正文就变成谁也不认领的残骸，交给文件清理那条线
  const after = await scanTasks(f.root);
  const left = after.tasks.filter((x) => x.state === 'untracked').map((x) => x.bodyRel).sort();
  assert.deepEqual(left, [f.rel.archivedBody, f.rel.residualBody].sort());
  assert.equal(after.totals.bytes, after.db.bodies.bytes);
});

test('仍在主列表里、正文也还在的会话不许从这里消失', async (t) => {
  const f = await fixture(t);
  await assert.rejects(purgeTasks(f.root, [ACTIVE_ID], { backupDir: f.backup }), (err) => {
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /仍在 Codex 主列表/);
    return true;
  });
  assert.equal(count(path.join(f.root, 'state_5.sqlite'), 'SELECT count(*) c FROM threads'), 2);
});

test('残骸编号混进删除请求时不动任何行', async (t) => {
  const f = await fixture(t);
  const d = await scanTasks(f.root);
  const residual = d.tasks.find((x) => x.state === 'untracked');
  const r = await purgeTasks(f.root, [residual.id], { backupDir: f.backup });
  assert.equal(r.perDb.reduce((s, x) => s + x.deleted, 0), 0);
  assert.equal(count(path.join(f.root, 'state_5.sqlite'), 'SELECT count(*) c FROM threads'), 2);
  // 残骸文件不在这次删除里 —— 它归文件清理那条线
  await fs.access(path.join(f.root, f.rel.residualBody));
});

const SEG_ID = '01aa0000-0000-0000-0000-0000000000ee';
const ORIG_ID = '01aa0000-0000-0000-0000-0000000000ff';

/* ── 分页续段的血统 ─────────────────────────────────────── */

/**
 * Codex 把一条长会话按上下文压缩点切成多段 rollout 文件。
 * 续段的首行带 history_base，写着"我从第 N 个 ordinal 起接"。
 *
 * 为什么这个判据要紧：删掉续段，整条会话永久不可恢复，而 Codex 报的是
 * "invalid paginated history lineage ... missing source rollout" ——
 * 看起来像别处坏了，几乎不可能联想到"自己删了个文件"。
 * 所以续段必须是 locked（请勿删除），只有原始段可以按文件清。
 */
test('续段（首行带 history_base）被锁住，原始段仍可清', async (t) => {
  const { root } = await fixture(t);
  const seg = path.join(root, 'sessions/2026/10/04/rollout-2026-10-04T00-00-00-' + SEG_ID + '.jsonl');
  await fs.mkdir(path.dirname(seg), { recursive: true });
  // 首行就是真实形状：history_base.end_ordinal_exclusive 指着前一段的结尾
  await fs.writeFile(seg, JSON.stringify({
    timestamp: '2026-10-04T00:00:00.000Z',
    ordinal: 4990,
    type: 'session_meta',
    payload: {
      session_id: SEG_ID,
      history_mode: 'paginated',
      history_base: { thread_id: SEG_ID, end_ordinal_exclusive: 4990, end_byte_offset: 66878152 },
    },
  }) + '\n' + 'x'.repeat(500) + '\n');

  const app = (await import('../lib/apps/codex.mjs')).default;
  const { scanTarget } = await import('../lib/scan.mjs');
  const scan = await scanTarget(app, { key: 'root', kind: 'dir', path: root });
  const segFile = scan.files.find((f) => f.p.endsWith(`${SEG_ID}.jsonl`));
  assert.ok(segFile, '续段文件要被扫到');
  assert.equal(segFile.c, 'transcriptSegment', '续段要单独一档');

  const cat = scan.catalog.find((c) => c.id === 'transcriptSegment');
  assert.ok(cat, '分类表里要有 transcriptSegment');
  assert.equal(cat.verdict, 'never', '续段不能按文件删 —— 删了整条会话就废了');
  assert.equal(cat.locked, true, '要锁住勾选框');
});

test('原始段（首行没有 history_base）保持可清', async (t) => {
  const { root } = await fixture(t);
  const orig = path.join(root, 'sessions/2026/10/05/rollout-2026-10-05T00-00-00-' + ORIG_ID + '.jsonl');
  await fs.mkdir(path.dirname(orig), { recursive: true });
  await fs.writeFile(orig, JSON.stringify({
    timestamp: '2026-10-05T00:00:00.000Z', ordinal: 0, type: 'session_meta',
    payload: { session_id: ORIG_ID, history_mode: 'paginated' },
  }) + '\n' + 'y'.repeat(500) + '\n');

  const app = (await import('../lib/apps/codex.mjs')).default;
  const { scanTarget } = await import('../lib/scan.mjs');
  const scan = await scanTarget(app, { key: 'root', kind: 'dir', path: root });
  const f = scan.files.find((x) => x.p.endsWith(`${ORIG_ID}.jsonl`));
  assert.equal(f.c, 'transcript', '原始段仍是普通会话正文');
});

test('rolloutLineage 判不出时返回 null，绝不猜', async (t) => {
  const { rolloutLineage } = await import('../lib/apps/codex.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-lineage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // 文件不存在
  assert.equal(rolloutLineage(path.join(dir, 'nope.jsonl')), null);
  // 首行不是 JSON
  const bad = path.join(dir, 'bad.jsonl');
  await fs.writeFile(bad, 'not json at all\n');
  assert.equal(rolloutLineage(bad), null);
  // 空文件
  const empty = path.join(dir, 'empty.jsonl');
  await fs.writeFile(empty, '');
  assert.equal(rolloutLineage(empty), null);
  // history_base 里没有 end_ordinal_exclusive
  const partial = path.join(dir, 'partial.jsonl');
  await fs.writeFile(partial, JSON.stringify({ payload: { history_base: { thread_id: 'x' } } }) + '\n');
  const r = rolloutLineage(partial);
  assert.equal(r.continuation, false, '缺 end_ordinal_exclusive 时不能当成续段');
});

/**
 * Codex 的行级清理：三个库按 thread id 串起来，删除要一次跨完。
 *
 * 这里专门盯着两件在真机上出过事的地方：
 *   - history / logs 库里**没有** threads 表，任何无条件拼 `FROM threads` 的 SQL 会在
 *     第一条语句上失败，于是整批删除连索引都删不动；
 *   - 正文是 sessions/ 下的 rollout 文件，行删完文件还在，界面必须把它当残骸交给文件那条线。
 * 夹具用临时目录和临时库，绝不碰机器上真正的 ~/.codex。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { purgeTasks, scanTasks } from '../lib/tasks-codex.mjs';

const ARCHIVED_ID = '01aaa111-1111-4111-8111-111111111111';
const ACTIVE_ID = '01bbb222-2222-4222-8222-222222222222';
const RESIDUAL_ID = '01ccc333-3333-4333-8333-333333333333';

const THREAD_DDL = `id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, rollout_path TEXT,
  created_at INTEGER, updated_at INTEGER, archived INTEGER, archived_at INTEGER,
  is_pinned INTEGER, tokens_used INTEGER, model TEXT, model_provider TEXT,
  history_mode TEXT, thread_source TEXT, preview TEXT`;
const THREAD_NAMES = THREAD_DDL.split(',').map((s) => s.trim().split(' ')[0]);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-codex-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const ws = path.join(root, 'workspace');
  await fs.mkdir(ws, { recursive: true });

  const archivedBody = 'sessions/2026/10/01/rollout-2026-10-01T00-00-00-' + ARCHIVED_ID + '.jsonl';
  const activeBody = 'sessions/2026/10/02/rollout-2026-10-02T00-00-00-' + ACTIVE_ID + '.jsonl';
  const residualBody = 'sessions/2026/10/03/rollout-2026-10-03T00-00-00-' + RESIDUAL_ID + '.jsonl';
  for (const [rel, text] of [[archivedBody, 'a'.repeat(4096)], [activeBody, 'b'.repeat(2048)],
    [residualBody, 'c'.repeat(1024)]]) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  }

  const index = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  index.exec(`CREATE TABLE threads (${THREAD_DDL})`);
  index.exec('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)');
  index.exec('CREATE TABLE _sqlx_migrations (version INTEGER)');
  const ins = index.prepare(
    `INSERT INTO threads (${THREAD_NAMES.join(',')}) VALUES (${THREAD_NAMES.map(() => '?').join(',')})`);
  ins.run(ARCHIVED_ID, '归档的那条', null, ws, path.join(root, archivedBody), 1, 2, 1, 3, 0, 10, 'gpt', 'openai', 'paginated', 'user', 'p1');
  ins.run(ACTIVE_ID, '还在列表里', null, ws, path.join(root, activeBody), 1, 4, 0, null, 0, 20, 'gpt', 'openai', 'paginated', 'user', 'p2');
  index.exec(`INSERT INTO thread_spawn_edges VALUES ('${ARCHIVED_ID}', 'whatever')`);
  index.close();

  // 投影库和日志库都没有 threads 表 —— 这正是回归点
  const hist = new DatabaseSync(path.join(root, 'thread_history_1.sqlite'));
  hist.exec('CREATE TABLE thread_items (thread_id TEXT, item_json TEXT)');
  hist.exec('CREATE TABLE thread_turns (thread_id TEXT)');
  hist.prepare('INSERT INTO thread_items VALUES (?, ?)').run(ARCHIVED_ID, JSON.stringify({ x: 'y'.repeat(500) }));
  hist.prepare('INSERT INTO thread_items VALUES (?, ?)').run(ACTIVE_ID, JSON.stringify({ x: 'z'.repeat(500) }));
  hist.prepare('INSERT INTO thread_turns VALUES (?)').run(ARCHIVED_ID);
  hist.close();

  const logs = new DatabaseSync(path.join(root, 'logs_2.sqlite'));
  logs.exec('CREATE TABLE logs (thread_id TEXT, line TEXT)');
  const lin = logs.prepare('INSERT INTO logs VALUES (?, ?)');
  for (let i = 0; i < 5; i++) lin.run(ARCHIVED_ID, `line ${i}`);
  lin.run(ACTIVE_ID, 'still here');
  logs.close();

  return { root, backup: path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-backups-')), 'run'), rel: { archivedBody, activeBody, residualBody } };
}

const count = (dbFile, sql) => {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try { return db.prepare(sql).get().c; } finally { db.close(); };
}
