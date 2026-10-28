import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyVerified, backupDatabases } from '../lib/backup.mjs';
import { hasTable, writeDatabases } from '../lib/database-write.mjs';
import { openReadonlyOrThrow } from '../lib/sqlite-open.mjs';
import { createWriteGuard } from '../lib/write-guard.mjs';
import { appRunning } from '../lib/tasks.mjs';
import { scanTasks as scanClaude } from '../lib/tasks-claude.mjs';
import { scanApp } from '../lib/scan.mjs';
import claude from '../lib/apps/claude.mjs';
import codex from '../lib/apps/codex.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inspector-safety-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function seed(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE items (id TEXT PRIMARY KEY); INSERT INTO items VALUES (\'keep\')');
  db.close();
}
function count(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT count(*) n FROM items').get().n; }
  finally { db.close(); }
}

for (const suffix of ['-wal', '-shm', '-journal']) {
  test(`database writes reject a linked ${suffix} before SQLite opens it`, async t => {
    const root = await fixture(t), file = path.join(root, 'data.sqlite');
    seed(file);
    const outside = path.join(root, 'outside');
    await fs.writeFile(outside, 'must remain unchanged');
    await fs.symlink(outside, file + suffix);
    let entered = false;
    await assert.rejects(writeDatabases([file], { root, backupDir: path.join(root, 'b'), label: 'test' }, () => {
      entered = true;
    }), /侧文件.*普通文件/);
    assert.equal(entered, false);
    assert.equal(await fs.readFile(outside, 'utf8'), 'must remain unchanged');
    assert.equal(await fs.readlink(file + suffix), outside);
  });
}

test('scan reports inaccessible targets instead of treating them as absent', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'parent'), 'not a directory');
  const result = await scanApp({ app: claude, targets: [{ key: 'root', kind: 'dir', path: path.join(root, 'parent', 'child') }] });
  assert.ok(result.problems.some(p => p.error === 'ENOTDIR'));
});

test('Codex live session detection includes all index versions', async t => {
  const root = await fixture(t);
  for (const version of [5, 6]) {
    const db = new DatabaseSync(path.join(root, `state_${version}.sqlite`));
    db.exec('CREATE TABLE threads (id TEXT)');
    db.prepare('INSERT INTO threads VALUES (?)').run(`thread-${version}`);
    db.close();
  }
  assert.deepEqual(await codex.liveSessions(root), new Set(['thread-5', 'thread-6']));
});

test('optional tables distinguish absent results across supported SQLite versions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE present (id TEXT); CREATE VIEW only_view AS SELECT id FROM present');
    assert.equal(hasTable(db, 'present'), true);
    assert.equal(hasTable(db, 'missing'), false);
    assert.equal(hasTable(db, 'only_view'), false);
  } finally { db.close(); }
});

test('scan connections reject SQL writes on every supported Node version', async t => {
  const root = await fixture(t), file = path.join(root, 'data.sqlite');
  seed(file);
  const db = openReadonlyOrThrow(file);
  try {
    assert.throws(() => db.exec('DELETE FROM items'), /readonly/i);
    assert.equal(db.prepare('SELECT count(*) n FROM items').get().n, 1);
  } finally { db.close(); }
});

test('verified backups preserve empty files and literal symlinks', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'source'));
  await fs.writeFile(path.join(root, 'source', 'empty'), '');
  await fs.symlink('empty', path.join(root, 'source', 'link'));
  await copyVerified(path.join(root, 'source'), path.join(root, 'copy'));
  assert.equal((await fs.stat(path.join(root, 'copy', 'empty'))).size, 0);
  assert.equal(await fs.readlink(path.join(root, 'copy', 'link')), 'empty');
});

test('consecutive database backups never overwrite a prior recovery point', async t => {
  const root = await fixture(t), file = path.join(root, 'data.sqlite'), backups = path.join(root, 'backups');
  seed(file);
  const first = await backupDatabases([file], backups, 'test');
  const db = new DatabaseSync(file); db.exec('DELETE FROM items'); db.close();
  const second = await backupDatabases([file], backups, 'test');
  assert.notEqual(first, second);
  assert.equal(count(path.join(first, 'data.sqlite')), 1);
  assert.equal(count(path.join(second, 'data.sqlite')), 0);
});

test('missing main database and unreadable sidecar both reject backups', async t => {
  const root = await fixture(t), file = path.join(root, 'data.sqlite');
  await assert.rejects(backupDatabases([file], path.join(root, 'b'), 'test'), /备份失败/);
  seed(file);
  // 存在但异常的侧文件，不能当成"不存在的侧文件"跳过。
  await fs.mkdir(file + '-wal');
  await fs.writeFile(path.join(file + '-wal', 'special'), 'not a WAL');
  // 非法源文件类型在任何库改动之前就被拒绝。
  await assert.rejects(backupDatabases([file], path.join(root, 'b'), 'test'), /备份失败/);
  await fs.rm(file + '-wal', { recursive: true });
  assert.equal(count(file), 1);
});

test('an error in the second database rolls back writes to the first', async t => {
  const root = await fixture(t), paths = ['a.sqlite', 'b.sqlite'].map(x => path.join(root, x));
  paths.forEach(seed);
  await assert.rejects(writeDatabases(paths, { backupDir: path.join(root, 'b'), label: 'test', root }, ([a, b]) => {
    a.exec('DELETE FROM items');
    b.exec('DELETE FROM missing_table');
  }), /未提交的更改已回滚/);
  assert.deepEqual(paths.map(count), [1, 1]);
});

test('a held lock in any database prevents all changes', async t => {
  const root = await fixture(t), paths = ['a.sqlite', 'b.sqlite'].map(x => path.join(root, x));
  paths.forEach(seed);
  const lock = new DatabaseSync(paths[1]); lock.exec('BEGIN IMMEDIATE');
  let entered = false;
  try {
    await assert.rejects(writeDatabases(paths, { backupDir: path.join(root, 'b'), label: 'test', root }, () => { entered = true; }));
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.equal(entered, false);
  assert.deepEqual(paths.map(count), [1, 1]);
});

test('write guard rejects overlap and releases after failure', async () => {
  const guard = createWriteGuard();
  let release;
  const running = guard(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(guard(async () => {}), { statusCode: 409 });
  release(); await running;
  await assert.rejects(guard(async () => { throw Error('failure'); }), /failure/);
  assert.equal(await guard(async () => 42), 42);
});

test('process checks distinguish no match from failed detection', async () => {
  const app = { label: 'fixture', processes: [['fixture', ['-x', 'fixture']]] };
  const noMatch = await appRunning(app, async () => { throw Object.assign(Error(), { code: 1 }); });
  assert.equal(noMatch.unknown, false); assert.equal(noMatch.running, false);
  for (const code of ['ENOENT', 'EACCES', 2]) {
    assert.equal((await appRunning(app, async () => { throw Object.assign(Error(), { code }); })).unknown, true);
  }
});

test('Claude body paths join the scan index and symlinks are not read as sessions', async t => {
  const root = await fixture(t), rel = 'projects/demo/session.jsonl';
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), JSON.stringify({ type: 'user', cwd: root, message: { content: '测试' } }) + '\n');
  await fs.symlink('session.jsonl', path.join(root, 'projects/demo/link.jsonl'));
  const tasks = await scanClaude(root);
  const scan = await scanApp({ app: claude, targets: [{ key: 'home', kind: 'dir', path: root, exists: true }] });
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0].bodyRel, rel);
  assert.ok(scan.files.some(f => f.p === tasks.tasks[0].bodyRel));
});

test('scan observes targets created after startup', async t => {
  const root = await fixture(t), target = { key: 'home', kind: 'dir', path: path.join(root, 'new'), exists: false };
  await fs.mkdir(target.path); await fs.writeFile(path.join(target.path, 'note'), 'hello');
  const scan = await scanApp({ app: claude, targets: [target] });
  assert.equal(scan.totals.files, 1);
  assert.equal(scan.targets[0].exists, true);
});

test('only verified inactive Codex releases are classified as old', async t => {
  const root = await fixture(t), base = path.join(root, 'packages/app-server-daemon');
  for (const name of ['current-version', 'old-version']) {
    await fs.mkdir(path.join(base, 'releases', name), { recursive: true });
    await fs.writeFile(path.join(base, 'releases', name, 'runtime'), 'binary');
  }
  const plan = { app: codex, targets: [{ key: 'root', kind: 'dir', path: root, exists: true }] };
  assert.ok((await scanApp(plan)).files.every(f => f.c !== 'oldRelease'));
  await fs.symlink('releases/current-version', path.join(base, 'current'));
  const scan = await scanApp(plan);
  assert.equal(scan.files.find(f => f.p.includes('old-version/runtime')).c, 'oldRelease');
  assert.notEqual(scan.files.find(f => f.p.includes('current-version/runtime')).c, 'oldRelease');
});

test('database mutations refuse ancestor symlinks outside the approved root', async t => {
  const root = await fixture(t), outside = path.join(root, 'outside'), approved = path.join(root, 'approved');
  await fs.mkdir(outside); await fs.mkdir(approved);
  const file = path.join(outside, 'data.sqlite'); seed(file);
  await fs.symlink(outside, path.join(approved, 'linked'));
  await assert.rejects(writeDatabases([path.join(approved, 'linked/data.sqlite')],
    { backupDir: path.join(root, 'b'), label: 'test', root: approved }, ([db]) => db.exec('DELETE FROM items')), /符号链接/);
  assert.equal(count(file), 1);
});

test('数据库写入必须声明目标根目录 —— 少它就不写', async t => {
  const root = await fixture(t), file = path.join(root, 'data.sqlite');
  seed(file);
  await assert.rejects(
    writeDatabases([file], { backupDir: path.join(root, 'b'), label: 'test' }, ([db]) => db.exec('DELETE FROM items')),
    /未指定写入根目录/);
  assert.equal(count(file), 1, '拒绝之后源库不得有任何改动');
});

test('database backup includes an existing rollback journal', async t => {
  const root = await fixture(t), file = path.join(root, 'data.sqlite');
  seed(file);
  await fs.writeFile(file + '-journal', 'synthetic rollback journal');
  const backup = await backupDatabases([file], path.join(root, 'backups'), 'journal');
  assert.equal(await fs.readFile(path.join(backup, 'data.sqlite-journal'), 'utf8'), 'synthetic rollback journal');
});
