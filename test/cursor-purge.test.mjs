/**
 * Cursor 的按会话清理：可达性分析、独占 blob、删除闸门。
 *
 * 这些测试全部在临时目录里用 node:sqlite 现造一个 state.vscdb，绝不碰真实数据。
 *
 * 要验证的核心命题只有一条：**删掉会话 A 时，只删只被 A 引用的 blob；
 * 还被 B 引用的 blob 必须留下。** 这条错了就是数据丢失，方向与"清理不干净"相反，
 * 而且事后无法从库里恢复 —— 上一版这个工具在真实库上就踩过一次，
 * 报的是 Conversation data missing。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { analyzePurge, purgeSessions, unframe } from '../lib/cursor-purge.mjs';

const IDE_REL = path.join('User', 'globalStorage', 'state.vscdb');

/* ── 夹具 ─────────────────────────────────────────────────── */

/** Cursor 把二进制存成十进制字节串；造数据时得按同样的形态写进去。 */
const frame = (buf) => [...buf].join(',');

/**
 * 内容寻址的 key 是 **sha256 的 64 位十六进制**。
 * 这一点必须照真：代码只认 64 位 hex（32 字节的二进制边界也是按它算的），
 * 用短 hex 造夹具会让"引用"永远匹配不上，测出来的全是假阴性。
 */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const hexOf = sha256;

async function makeDb(t, spec) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-cursorpurge-'));
  const ide = path.join(root, 'Cursor');
  await fs.mkdir(path.join(ide, 'User', 'globalStorage'), { recursive: true });
  const dbPath = path.join(ide, IDE_REL);

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER,
      checkpointAt INTEGER, subagentTypeName TEXT, value TEXT);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `);

  for (const b of spec.blobs) {
    const key = `${b.ns || 'agentKv:blob'}:${hexOf(b.content)}`;
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, frame(b.content));
  }
  for (const s of spec.sessions) {
    db.prepare(`INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt,
      isArchived, isSubagent, recency, checkpointAt, subagentTypeName, value)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0, '', '{}')`)
      .run(s.id, 'ws', 1, 1, s.archived ? 1 : 0);
    for (const [i, text] of (s.messages || []).entries()) {
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
        .run(`bubbleId:${s.id}:${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`, text);
    }
    if (s.data !== undefined) {
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
        .run(`composerData:${s.id}`, s.data);
    }
  }
  db.close();

  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { ide, dbPath, root };
}

/** 读回库里所有的 key，用来断言"什么被删了、什么还在"。 */
function keysOf(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT key FROM cursorDiskKV').all().map((r) => r.key);
  } finally { db.close(); }
}

/* ── unframe ──────────────────────────────────────────────── */

test('unframe：十进制字节串能还原成原字节，普通文本原样返回', () => {
  const raw = Buffer.from('hello 世界', 'utf8');
  assert.deepEqual(Buffer.from(unframe(frame(raw))), raw);
  // 普通 JSON 不是字节串，不能被误当成字节数组切开
  assert.equal(unframe('{"a":1,"b":2}').toString('utf8'), '{"a":1,"b":2}');
  assert.equal(unframe('').toString('utf8'), '');
});

/* ── 独占 blob ────────────────────────────────────────────── */

test('只被一个会话引用的 blob 算独占；被两个会话引用的不算', async (t) => {
  const shared = Buffer.from('shared payload');
  const onlyA = Buffer.from('only A payload');
  const onlyB = Buffer.from('only B payload');

  const { ide } = await makeDb(t, {
    // A 提到 shared 与 onlyA；B 提到 shared 与 onlyB
    blobs: [{ content: shared }, { content: onlyA }, { content: onlyB }],
    sessions: [
      { id: 'A', messages: [`refs ${hexOf(shared)} and ${hexOf(onlyA)}`] },
      { id: 'B', messages: [`refs ${hexOf(shared)} and ${hexOf(onlyB)}`] },
    ],
  });

  const r = analyzePurge(ide);
  const a = r.sessions.find((s) => s.id === 'A');
  const b = r.sessions.find((s) => s.id === 'B');

  assert.equal(a.exclusiveBlobs, 1, 'A 只独占 onlyA');
  assert.equal(a.exclusiveBytes, onlyA.length);
  assert.equal(b.exclusiveBlobs, 1, 'B 只独占 onlyB');
  // shared 谁都不独占
  assert.notEqual(a.exclusiveBytes, shared.length + onlyA.length);
});

test('二进制里嵌着的 hash 也算引用（文本正则看不见的那条通道）', async (t) => {
  /* 构造：outer 的**原始字节**里直接嵌着 inner 的 sha256 字节。
     纯文本扫描永远看不到这条边 —— 历史事故正是漏了它：删掉"看起来无人引用"
     的 inner，Cursor 立刻报 Conversation data missing。

     有了这条边之后，inner 的归属集合与 outer 相同（都只有 A 能到），
     所以两个都算 A 独占 —— 删 A 时一起带走，这是对的：
     如果只有 outer 被认出来，inner 会变成悬空引用。 */
  const inner = Buffer.from('inner blob content');
  const outer = Buffer.concat([
    Buffer.from([0xff, 0x00, 0x7f]),
    Buffer.from(sha256(inner), 'hex'),      // 32 字节原始 hash
    Buffer.from('tail'),
  ]);

  const { ide } = await makeDb(t, {
    blobs: [{ content: inner }, { content: outer }],
    sessions: [{ id: 'A', messages: [`refs ${hexOf(outer)}`] }],
  });

  const r = analyzePurge(ide);
  const a = r.sessions.find((s) => s.id === 'A');
  assert.equal(a.exclusiveBlobs, 2,
    'outer 被直接引用，inner 通过二进制边可达 —— 两者都只属于 A');
  assert.equal(a.exclusiveBytes, inner.length + outer.length);

  // 反过来验证：如果没有二进制边，inner 会变成"无主"（不属于任何会话），
  // 而"无主"的 blob 是不删的 —— 这正是不敢简单按"没人引用"删的原因。
  assert.equal(r.orphanBlobs, 0, '二进制边认出来后，不该再有无主 blob');
});

test('toolCallId 关联也算引用（blob 里写着工具调用 id）', async (t) => {
  const uuid = '82b48a0e-3fa6-466d-a8da-74b793461234';
  const payload = Buffer.from(JSON.stringify({ role: 'tool', toolCallId: `0_tool_${uuid}`, content: [] }));

  const { ide } = await makeDb(t, {
    blobs: [{ content: payload }],
    // 会话的气泡里也有同一个 id（形态可以不同，取 UUID 主体再比）
    sessions: [{ id: 'A', messages: [JSON.stringify({ toolCallId: `call-${uuid}-0` })] }],
  });

  const r = analyzePurge(ide);
  const a = r.sessions.find((s) => s.id === 'A');
  assert.equal(a.exclusiveBlobs, 1, '靠 id 关联上的 blob 也算 A 独占');
});

/* ── 空跑 ─────────────────────────────────────────────────── */

test('空跑只报数字，一行都不写', async (t) => {
  const onlyA = Buffer.from('payload only A');
  const { ide, dbPath } = await makeDb(t, {
    blobs: [{ content: onlyA }],
    sessions: [{ id: 'A', messages: [`refs ${hexOf(onlyA)}`] }],
  });

  const before = keysOf(dbPath).sort();
  const r = await purgeSessions(ide, ['A'], { dryRun: true });

  assert.equal(r.dryRun, true);
  assert.equal(r.sessions, 1);
  assert.equal(r.blobs, 1);
  assert.equal(r.freed, onlyA.length + r.sessionBytes);
  assert.deepEqual(keysOf(dbPath).sort(), before, '空跑不许改库');
});

/* ── 真删 ─────────────────────────────────────────────────── */

test('删除一个会话：带走它独占的 blob，留下另一个人还在用的', async (t) => {
  const shared = Buffer.from('shared between A and B');
  const onlyA = Buffer.from('only A');
  const onlyB = Buffer.from('only B');

  const { ide, dbPath } = await makeDb(t, {
    blobs: [{ content: shared }, { content: onlyA }, { content: onlyB }],
    sessions: [
      { id: 'A', messages: [`refs ${hexOf(shared)} ${hexOf(onlyA)}`] },
      { id: 'B', messages: [`refs ${hexOf(shared)} ${hexOf(onlyB)}`] },
    ],
  });

  const backupDir = path.join(t.dirRoot || (await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-bk-'))), 'bk');
  const r = await purgeSessions(ide, ['A'], { backupDir });

  const after = keysOf(dbPath);
  assert.ok(!after.some((k) => k === `agentKv:blob:${hexOf(onlyA)}`), 'onlyA 应当被删');
  assert.ok(after.some((k) => k === `agentKv:blob:${hexOf(shared)}`), 'shared 必须留下（B 还在用）');
  assert.ok(after.some((k) => k === `agentKv:blob:${hexOf(onlyB)}`), 'onlyB 必须留下');
  assert.ok(!after.some((k) => k.startsWith('bubbleId:A:')), 'A 的气泡应当被删');
  assert.ok(after.some((k) => k.startsWith('bubbleId:B:')), 'B 的气泡必须留下');

  assert.equal(r.integrity, 'ok');
  assert.equal(r.dangling, 0, '删完不许有悬空引用');
  // 备份里留着删之前的库
  const bkFiles = await fs.readdir(backupDir + (r.backup ? `/${path.basename(r.backup)}` : ''));
  assert.ok(bkFiles.some((f) => f.startsWith('state.vscdb')), '备份目录里要有 state.vscdb');
});

test('删完再删一次是幂等的：第二次没东西可删', async (t) => {
  const onlyA = Buffer.from('payload');
  const { ide } = await makeDb(t, {
    blobs: [{ content: onlyA }],
    sessions: [{ id: 'A', messages: [`refs ${hexOf(onlyA)}`] }],
  });
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-bk2-'));

  const first = await purgeSessions(ide, ['A'], { backupDir });
  assert.ok(first.sessionRows > 0);

  const second = await purgeSessions(ide, ['A'], { backupDir });
  assert.equal(second.sessionRows, 0, '第二次没有行可删');
  assert.equal(second.dangling, 0);
});

test('空 id 列表是 400，不碰库', async (t) => {
  const { ide } = await makeDb(t, { blobs: [], sessions: [] });
  await assert.rejects(() => purgeSessions(ide, [], { dryRun: true }), /没有选中任何会话/);
});

test('归档会话自己名下没有数据时不会误删别人的 blob', async (t) => {
  const keep = Buffer.from('keep me');
  const { ide, dbPath } = await makeDb(t, {
    blobs: [{ content: keep }],
    sessions: [
      { id: 'live', messages: [`refs ${hexOf(keep)}`] },
      { id: 'arch', archived: true, messages: [] },
    ],
  });
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-bk3-'));
  await purgeSessions(ide, ['arch'], { backupDir });
  const after = keysOf(dbPath);
  assert.ok(after.some((k) => k === `agentKv:blob:${hexOf(keep)}`), '活会话的 blob 不能被归档会话的删除带走');
});
