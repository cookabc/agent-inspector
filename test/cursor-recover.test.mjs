/**
 * Cursor 孤儿会话：扫描与回灌。
 *
 * 回灌是这个工具里唯一一条会写 state.vscdb 的路径，所以测试盯得细一点：
 *   - 扫描只认"composerHeaders 里没有、transcript 还在"的会话
 *   - 空跑不写库、不备份
 *   - 真写：三组行（composerHeaders / composerData / bubbleId）都补上，先备份、后自检
 *   - 再跑一次是幂等的，已存在的会话一律跳过
 *   - 服务端闸门：确认串不对直接 400；空跑在 Cursor 开着时也允许
 *
 * 夹具全部在临时目录里，绝不碰真实 Cursor 数据。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { scanOrphans, reimportOrphans, workspacePath } from '../lib/cursor-recover.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));

const ORPHAN = 'orphan-1111-2222-3333';
const KNOWN = 'known-aaaa-bbbb-cccc';
const EMPTY = 'empty-9999-8888-7777';
const SLUG = 'Users-someone-Developer-demo';
const WORKSPACE = '/tmp/agent-inspector-ws-cursor';

/** 一条完整的 transcript：时间戳、<user_query>、工具调用、turn_ended。 */
const TRANSCRIPT = [
  { role: 'user', message: { content: [{ type: 'text', text:
    '<timestamp>Tuesday, May 19, 2026, 3:43 PM (UTC+8)</timestamp><user_query>请帮我修一下构建脚本</user_query>' }] } },
  { role: 'assistant', message: { content: [
    { type: 'text', text: '好的，我先看构建脚本。' },
    { type: 'tool_use', name: 'read_file', input: { path: 'scripts/build.sh' } },
  ] } },
  { role: 'user', message: { content: [{ type: 'text', text: '顺便把 CI 也改了' }] } },
  { type: 'turn_ended', status: 'success' },
].map((x) => JSON.stringify(x)).join('\n') + '\n';

function seedDb(ideDir) {
  const dir = path.join(ideDir, 'User', 'globalStorage');
  const dbPath = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE composerHeaders (
    composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
    isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER,
    subagentTypeName TEXT, value TEXT)`);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');

  const header = {
    type: 'head', composerId: KNOWN, name: '模板会话',
    createdAt: 1, lastUpdatedAt: 2,
    workspaceIdentifier: {
      id: 'ws-1',
      uri: { $mid: 1, fsPath: WORKSPACE, external: `file://${WORKSPACE}`, path: WORKSPACE, scheme: 'file' },
    },
  };
  db.prepare('INSERT INTO composerHeaders VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(KNOWN, 'ws-1', 1, 2, 0, 0, 2, null, '', JSON.stringify(header));
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)')
    .run(`composerData:${KNOWN}`, JSON.stringify({
      _v: 18, composerId: KNOWN, name: '模板会话', conversationMap: {}, fullConversationHeadersOnly: [],
    }));
  // 模板气泡：loadTemplates 只取 text 长度 > 20 的
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)')
    .run(`bubbleId:${KNOWN}:u1`, JSON.stringify({
      type: 1, bubbleId: 'u1', text: '模板里的用户气泡，这一段足够长，可以被当成模板使用。',
      context: { fileSelections: [], selectedCode: [] }, unifiedMode: 2,
    }));
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)')
    .run(`bubbleId:${KNOWN}:a1`, JSON.stringify({
      type: 2, bubbleId: 'a1', text: '模板里的助手气泡，这一段同样足够长，可以被当成模板使用。',
      context: { fileSelections: [], selectedCode: [] }, unifiedMode: 2,
    }));
  db.close();
  return dbPath;
}

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-cursor-'));
  const home = path.join(temp, 'home');
  const cli = path.join(home, '.cursor');
  const ide = path.join(home, 'Library', 'Application Support', 'Cursor');
  await fs.mkdir(path.join(ide, 'User', 'globalStorage'), { recursive: true });
  await fs.mkdir(path.join(home, 'backups'), { recursive: true });

  const transcripts = path.join(cli, 'projects', SLUG, 'agent-transcripts');
  for (const id of [ORPHAN, KNOWN]) {
    await fs.mkdir(path.join(transcripts, id), { recursive: true });
    await fs.writeFile(path.join(transcripts, id, `${id}.jsonl`), TRANSCRIPT);
  }
  // 只有元数据的 transcript：没有可回灌的正文，扫描应跳过而不是列成 0 条会话
  await fs.mkdir(path.join(transcripts, EMPTY), { recursive: true });
  await fs.writeFile(path.join(transcripts, EMPTY, `${EMPTY}.jsonl`),
    JSON.stringify({ type: 'turn_ended', status: 'error' }) + '\n');

  const dbPath = seedDb(ide);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  return { temp, home, cli, ide, dbPath, backupDir: path.join(home, 'backups') };
}

function counts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const out = {
    headers: db.prepare('SELECT count(*) n FROM composerHeaders').get().n,
    composer: db.prepare("SELECT count(*) n FROM cursorDiskKV WHERE key LIKE 'composerData:%'").get().n,
    bubbles: db.prepare("SELECT count(*) n FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").get().n,
  };
  db.close();
  return out;
}

/* ── 扫描 ─────────────────────────────────────────────────── */

test('scanOrphans lists only transcripts without a composerHeader', async (t) => {
  const f = await fixture(t);
  const scan = await scanOrphans(f.cli, f.ide);

  assert.equal(scan.total, 1);
  assert.equal(scan.headers, 1);
  assert.equal(scan.transcripts, 3);
  assert.match(scan.problems.join('\n'), /1 个 transcript 没有任何正文/);

  const s = scan.sessions[0];
  assert.equal(s.id, ORPHAN);
  assert.equal(s.title, '请帮我修一下构建脚本');
  assert.equal(s.messages, 3);              // 2 条用户 + 1 条助手
  assert.equal(s.userMessages, 2);
  assert.equal(s.assistantMessages, 1);
  assert.equal(s.tools, 1);
  assert.equal(s.bubbles, 3);
  assert.equal(s.errors, 0);
  // "Tuesday, May 19, 2026, 3:43 PM (UTC+8)" → UTC 07:43
  assert.equal(s.date, Date.UTC(2026, 4, 19, 7, 43));
  assert.equal(s.workspaceSlug, SLUG);
  assert.equal(s.workspaceResolved, false);  // 夹具里的目录不存在
  assert.ok(s.bytes > 0);
});

test('workspacePath refuses to guess when no split exists on disk', () => {
  assert.equal(workspacePath('Users-nobody-Desktop-definitely-not-here'), null);
});

/* ── 回灌 ─────────────────────────────────────────────────── */

test('dry run reports counts without writing or backing up', async (t) => {
  const f = await fixture(t);
  const before = counts(f.dbPath);
  const res = await reimportOrphans(f.cli, f.ide, [ORPHAN], { backupDir: f.backupDir, dryRun: true });

  assert.equal(res.imported, 1);
  assert.equal(res.bubbles, 3);
  assert.equal(res.backup, null);
  assert.deepEqual(counts(f.dbPath), before);
  assert.deepEqual(await fs.readdir(f.backupDir), []);
});

test('reimport inserts header, composer and bubbles, then is idempotent', async (t) => {
  const f = await fixture(t);
  const res = await reimportOrphans(f.cli, f.ide, [ORPHAN], { backupDir: f.backupDir });

  assert.equal(res.imported, 1);
  assert.equal(res.bubbles, 3);
  assert.equal(res.integrity, 'ok');

  // 备份先落盘，且里面有一份完整的库
  assert.ok(res.backup && res.backup.startsWith(f.backupDir));
  const backed = await fs.readdir(res.backup);
  assert.ok(backed.includes('state.vscdb'));
  assert.equal(counts(path.join(res.backup, 'state.vscdb')).headers, 1);

  const after = counts(f.dbPath);
  assert.equal(after.headers, 2);
  assert.equal(after.composer, 2);
  assert.equal(after.bubbles, 5);           // 模板 2 条 + 回灌 3 条

  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  assert.equal(db.prepare('SELECT value FROM composerHeaders WHERE composerId = ?').get(ORPHAN).value.includes('构建脚本'), true);
  const composer = JSON.parse(db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${ORPHAN}`).value);
  assert.equal(composer.composerId, ORPHAN);
  assert.equal(composer.fullConversationHeadersOnly.length, 3);
  assert.equal(composer.status, 'completed');
  const first = JSON.parse(db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
    .get(`bubbleId:${ORPHAN}:${composer.fullConversationHeadersOnly[0].bubbleId}`).value);
  assert.equal(first.type, 1);
  assert.equal(first.text, '请帮我修一下构建脚本');
  db.close();

  // 第二次：没有可补的，计数不变，也不产生新备份
  const backupsBefore = (await fs.readdir(f.backupDir)).length;
  const again = await reimportOrphans(f.cli, f.ide, [ORPHAN], { backupDir: f.backupDir });
  assert.equal(again.imported, 0);
  assert.deepEqual(counts(f.dbPath), after);
  assert.equal((await fs.readdir(f.backupDir)).length, backupsBefore);
});

/* ── 服务端闸门 ───────────────────────────────────────────── */

async function serverFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-cursor-srv-'));
  const home = path.join(temp, 'home');
  const cli = path.join(home, '.cursor');
  const ide = path.join(home, 'Library', 'Application Support', 'Cursor');
  await fs.mkdir(path.join(ide, 'User', 'globalStorage'), { recursive: true });
  await fs.mkdir(path.join(home, '.Trash'), { recursive: true });
  const transcripts = path.join(cli, 'projects', SLUG, 'agent-transcripts');
  await fs.mkdir(path.join(transcripts, ORPHAN), { recursive: true });
  await fs.writeFile(path.join(transcripts, ORPHAN, `${ORPHAN}.jsonl`), TRANSCRIPT);
  seedDb(ide);

  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));

  const child = spawn(process.execPath, ['--experimental-sqlite', 'server.mjs', '--port', String(port), '--no-open'], {
    cwd: project,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (!output.includes(base) && Date.now() < deadline) await once(child.stdout, 'data').catch(() => {});
  assert.match(output, new RegExp(`http://127\\.0\\.0\\.1:${port}`), '服务没起来：\n' + output);

  t.after(async () => {
    child.kill();
    await fs.rm(temp, { recursive: true, force: true });
  });

  const request = (method, route, body = null) => new Promise((resolve, reject) => {
    const req = http.request(base + route, {
      method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` },
    }, (response) => {
      let raw = '';
      response.on('data', (c) => { raw += c; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body)); else req.end();
  });

  return { base, get: (r) => request('GET', r), post: (r, b) => request('POST', r, b), dbPath: path.join(ide, 'User', 'globalStorage', 'state.vscdb') };
}

test('GET /api/tasks/cursor/orphans returns the orphan list and confirm word', async (t) => {
  const s = await serverFixture(t);
  const res = await s.get('/api/tasks/cursor/orphans');
  assert.equal(res.status, 200);
  assert.equal(res.body.appId, 'cursor');
  assert.equal(res.body.total, 1);
  assert.equal(res.body.sessions[0].id, ORPHAN);
  assert.equal(res.body.confirmWord, '回灌');
  assert.equal(typeof res.body.app.running, 'boolean');
});

test('POST /api/tasks/cursor/recover refuses a wrong confirm word before touching the DB', async (t) => {
  const s = await serverFixture(t);
  const before = counts(s.dbPath);
  const res = await s.post('/api/tasks/cursor/recover', { ids: [ORPHAN], confirm: '随便' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /确认串/);
  assert.deepEqual(counts(s.dbPath), before);
});

test('POST /api/tasks/cursor/recover dry run is allowed even while Cursor runs', async (t) => {
  const s = await serverFixture(t);
  const before = counts(s.dbPath);
  const res = await s.post('/api/tasks/cursor/recover', { ids: [ORPHAN], dryRun: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.bubbles, 3);
  assert.deepEqual(counts(s.dbPath), before);
});
