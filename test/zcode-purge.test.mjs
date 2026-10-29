import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { purgeTasks } from '../lib/tasks-zcode.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inspector-zcode-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'cli/db'), { recursive: true });
  await fs.mkdir(path.join(root, 'v2'));
  const main = path.join(root, 'cli/db/db.sqlite'), index = path.join(root, 'v2/tasks-index.sqlite');
  const db = new DatabaseSync(main);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id), data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT REFERENCES message(id), data TEXT);
    INSERT INTO session VALUES ('root', NULL), ('child', 'root');
    INSERT INTO message VALUES ('m', 'child', '正文');
    INSERT INTO part VALUES ('p', 'child', 'm', '附件');`);
  db.close();
  const ti = new DatabaseSync(index);
  ti.exec(`CREATE TABLE tasks (task_id TEXT PRIMARY KEY, workspace_path TEXT, archived INTEGER, deleted INTEGER);
    CREATE TABLE task_group_members (task_id TEXT REFERENCES tasks(task_id));`);
  ti.prepare('INSERT INTO tasks VALUES (?, ?, ?, 0)').run('root', root, 1);
  ti.prepare('INSERT INTO tasks VALUES (?, ?, ?, 0)').run('child', root, 1);
  ti.exec("INSERT INTO task_group_members VALUES ('child')"); ti.close();
  return { root, main, index, backupDir: path.join(root, 'backups') };
}
function rows(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(`SELECT count(*) n FROM ${table}`).get().n; } finally { db.close(); }
}

test('ZCode preview includes descendants and works without optional tables', async t => {
  const f = await fixture(t);
  const result = await purgeTasks(f.root, ['root'], { dryRun: true });
  assert.equal(result.perDb.find(x => x.table === 'tasks').count, 2);
  assert.equal(result.perDb.find(x => x.table === 'part').count, 1);
  assert.equal(rows(f.main, 'session'), 2);
});

test('ZCode removes descendants from both body and index databases', async t => {
  const f = await fixture(t);
  const result = await purgeTasks(f.root, ['root'], { backupDir: f.backupDir });
  assert.equal(result.integrity, 'ok');
  assert.equal(rows(f.main, 'session'), 0); assert.equal(rows(f.main, 'message'), 0);
  assert.equal(rows(f.index, 'tasks'), 0); assert.equal(rows(f.index, 'task_group_members'), 0);
  assert.equal(rows(path.join(result.backup, 'db.sqlite'), 'session'), 2);
});

test('an active child no longer blocks an archived parent (it is reported instead)', async t => {
  /* 以前活跃子会话会整组挡住清理。现在放开：删父会连活跃子会话一起带走，
     这是用户点"删这一族"时想要的；代价是行上必须标出 activeDescendants、
     抽屉里点名。这里验适配器层不再拦。 */
  const f = await fixture(t), db = new DatabaseSync(f.index);
  db.exec("UPDATE tasks SET archived=0 WHERE task_id='child'"); db.close();
  const r = await purgeTasks(f.root, ['root'], { backupDir: f.backupDir });
  assert.equal(r.integrity, 'ok');
  assert.equal(rows(f.main, 'session'), 0, '父与活跃子会话一起被删');
});

test('index DELETE failure rolls back body deletion', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.index);
  db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"); db.close();
  await assert.rejects(purgeTasks(f.root, ['root'], { backupDir: f.backupDir }), /fixture failure/);
  assert.equal(rows(f.main, 'session'), 2); assert.equal(rows(f.index, 'tasks'), 2);
});
