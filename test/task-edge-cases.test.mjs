import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { scanTasks as claude } from '../lib/tasks-claude.mjs';
import { scanTasks as dsh } from '../lib/tasks-dsh.mjs';
import { scanTasks as cursor } from '../lib/tasks-cursor.mjs';
import { scanTasks as zcode, previewPurge } from '../lib/tasks-zcode.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-task-edges-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const put = async (rel, data) => {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true }); await fs.writeFile(abs, data);
    return abs;
  };
  return { root, put };
}

for (const [name, scan, dir] of [['Claude', claude, 'projects'], ['DSH', dsh, 'sessions']]) {
  test(`${name} 目录实际为普通文件时报告读取失败`, async t => {
    const { root, put } = await fixture(t); await put(dir, 'not a directory');
    const result = await scan(root);
    assert.equal(result.tasks.length, 0);
    assert.ok(result.problems.some(p => p.includes('ENOTDIR')));
  });
}

test('Claude 忽略非对象记录后仍能读取后面的标题和工作区', async t => {
  const { root, put } = await fixture(t);
  await put('projects/ws/id.jsonl', 'null\n[]\n' + JSON.stringify({
    cwd: root, type: 'user', message: { content: '保留标题' },
  }) + '\n');
  const result = await claude(root);
  assert.equal(result.tasks[0].workspace, root);
  assert.equal(result.tasks[0].title, '保留标题');
});

test('DSH 畸形索引集合不丢失会话，且明确报告状态不可用', async t => {
  const { root, put } = await fixture(t);
  await put('sessions/ws/session-one/session.v4.jsonl.zstd', 'body');
  await put('storages/workspace.json', JSON.stringify({ global: {
    archivedSessionIds: {}, pinnedSessionIds: 'session-one',
  }, tables: { workspaces: { one: { path: root, sessionIds: {} } } } }));
  const result = await dsh(root);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].pinned, false);
  assert.ok(result.problems.some(p => p.includes('索引') && p.includes('格式')));
});

test('DSH 无效投影回落正文，并跳过非对象与畸形消息', {
  skip: typeof zlib.zstdCompressSync !== 'function',
}, async t => {
  const { root, put } = await fixture(t);
  await put('storages/session_projcache/sessions/session-one.json', 'null');
  const records = [null, [], { type: 'user/message', data: { source: { kind: 'user' }, content: {} } },
    { type: 'session', cwd: root }, { type: 'user/message', data: {
      source: { kind: 'user' }, content: [null, { type: 'text', text: '正文标题' }],
    } }];
  await put('sessions/ws/session-one/session.v4.jsonl.zstd', zlib.zstdCompressSync(records.map(JSON.stringify).join('\n')));
  const result = await dsh(root);
  assert.equal(result.tasks[0].title, '正文标题');
  assert.equal(result.tasks[0].workspace, root);
  assert.ok(result.problems.some(p => p.includes('投影解析失败')));
});

test('Cursor 非 UUID 会话键在列表和清理图中归属一致', async t => {
  const { root, put } = await fixture(t);
  const file = await put('User/globalStorage/state.vscdb', '');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE composerHeaders(composerId TEXT, workspaceId TEXT, createdAt INTEGER,
    lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, value TEXT);
    CREATE TABLE cursorDiskKV(key TEXT, value TEXT);
    INSERT INTO composerHeaders VALUES ('A', '', 0, 0, 0, 0, 0, '{}');
    INSERT INTO cursorDiskKV VALUES ('bubbleId:A:b1', 'hello'), ('checkpointId:A:c1', 'check');`);
  db.close();
  const result = cursor(root);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].id, 'A');
  assert.equal(result.tasks[0].bytes, 5);
  assert.equal(result.tasks[0].children, 1);
});

async function zcodeFixture(t, sessions, index) {
  const f = await fixture(t);
  const main = await f.put('cli/db/db.sqlite', '');
  const db = new DatabaseSync(main);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT,
    time_created INTEGER, time_updated INTEGER, task_type TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT);`);
  for (const [id, parent] of sessions) {
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, 1, 2, ?)').run(id, parent, id, f.root, 'interactive');
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(id, id, 'body');
  }
  db.close();
  const ti = new DatabaseSync(await f.put('v2/tasks-index.sqlite', ''));
  ti.exec(`CREATE TABLE tasks(task_id TEXT, title TEXT, workspace_path TEXT, archived INTEGER,
    deleted INTEGER, pinned INTEGER, created_at INTEGER, updated_at INTEGER, model TEXT);`);
  for (const [id, archived] of index) ti.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, 0, 0, 1, 2, ?)')
    .run(id, id, f.root, archived, 'm');
  ti.close();
  return f;
}

test('ZCode 父记录丢失的会话仍显示并计入体积', async t => {
  const { root } = await zcodeFixture(t, [['lost-child', 'missing'], ['child', 'lost-child']], []);
  const result = zcode(root);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].id, 'lost-child');
  assert.equal(result.tasks[0].children, 1);
  assert.equal(result.tasks[0].bytes, 8);
});

test('ZCode 活跃子会话阻止整组清理，列表与预览一致', async t => {
  const { root } = await zcodeFixture(t, [['parent', null], ['child', 'parent']], [['parent', 1], ['child', 0]]);
  const result = zcode(root);
  assert.equal(result.tasks[0].reason, null);
  assert.throws(() => previewPurge(root, ['parent']), /仍在 ZCode 主列表/);
});

test('ZCode 无根循环被报告，不能伪装成没有会话', async t => {
  const { root } = await zcodeFixture(t, [['A', 'B'], ['B', 'A']], []);
  const result = zcode(root);
  assert.ok(result.problems.some(p => p.includes('2') && p.includes('循环')));
});

test('按行清理分发拒绝只读能力和未知适配器', async () => {
  const { rowPurgeBlocked, purgeTasks } = await import('../lib/tasks.mjs');
  assert.equal(rowPurgeBlocked({ label: 'readonly', history: 'zcode-db', writable: false }).status, 403);
  await assert.rejects(purgeTasks({ label: 'unknown', history: 'new-db' }, [{ path: '/synthetic' }], ['id']), /未知/);
});
