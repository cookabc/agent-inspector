/**
 * 历史会话面板的接口层：五个 app 各扫各的库，形状必须一致。
 *
 * 这些接口要读会话库（走的是 worker 链路），所以夹具不用空目录，而是用 node:sqlite
 * 把最小可用的会话库建出来 —— 做法与 codex-tasks.test.mjs 同源。
 * 所有库都在临时 HOME 下，绝不碰真实数据。
 *
 * 这里专门盯四件容易回归的事：
 *   - 五个 app 的会话行与 byState 满足同一份契约（见文件末尾的契约组）
 *   - Cursor 的 workspaceStorage/<uuid>/workspace.json 能把 UUID 还原成路径，
 *     解析不了时退回 UUID 而不是猜
 *   - 按行清理的四道闸：静态拒绝 → 进程探测 → 备份 → 事务+自检
 *   - 只读的两家（Cursor / Gemini）在任何进程检查之前就被静态拒绝
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
import { workspaceFolders } from '../lib/apps/cursor.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));

const WS = '/tmp/agent-inspector-ws-test';   // 会话里写的 cwd（不用真实目录）

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-agg-'));
  const home = path.join(temp, 'home');
  await fs.mkdir(path.join(home, '.Trash'), { recursive: true });
  await fs.mkdir(path.join(home, '.zcode', 'cli', 'db'), { recursive: true });
  await fs.mkdir(path.join(home, '.zcode', 'v2'), { recursive: true });
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.mkdir(path.join(home, '.cursor'), { recursive: true });
  await fs.mkdir(path.join(home, '.gemini', 'antigravity'), { recursive: true });
  const cursorIde = path.join(home, 'Library', 'Application Support', 'Cursor');
  await fs.mkdir(path.join(cursorIde, 'User', 'globalStorage'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude.json'), '{}');

  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));

  const child = spawn(process.execPath, ['--experimental-sqlite', 'server.mjs', '--port', String(port), '--no-open'],
    { cwd: project, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
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
    }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body)); else req.end();
  });
  const get = (route) => request('GET', route);
  const post = (route, body) => request('POST', route, body);

  return { temp, home, base, get, post, cursorIde };
}

/* ── 夹具数据 ─────────────────────────────────────────────── */

/** ZCode：会话库里一条 deleted、一条 active，任务索引各一行。
 *  除 session/message/part 外还要建齐 purge 会碰到的全部表 ——
 *  逐表 DELETE 用的是"库里有啥清啥"的探测，但 previewPurge 的
 *  COUNTED_TABLES 是固定清单，缺一张表整个删除就 500。 */
function seedZcode(home) {
  const main = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  const db = new DatabaseSync(main);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT)');
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
  // part 引用 message（真实 schema 里有 ON DELETE CASCADE，孤儿检查也数它）
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE model_usage (session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE turn_usage (session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE tool_usage (session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE todo (session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE session_entry (session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE session_input (session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE session_target (session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE session_task_link (child_session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE input_history (session_id TEXT, data TEXT)');
  db.exec("INSERT INTO session VALUES ('sess_a', NULL, 'ZCode 的已删会话', '" + WS + "', 1, 2, 'interactive')");
  db.exec("INSERT INTO session VALUES ('sess_b', NULL, 'ZCode 的活跃会话', '" + WS + "', 1, 2, 'interactive')");
  db.exec("INSERT INTO message VALUES ('msg_a', 'sess_a', '" + 'x'.repeat(2048) + "')");
  db.exec("INSERT INTO message VALUES ('msg_b', 'sess_b', '" + 'y'.repeat(1024) + "')");
  db.close();

  const index = path.join(home, '.zcode', 'v2', 'tasks-index.sqlite');
  const ti = new DatabaseSync(index);
  ti.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT, workspace_path TEXT, workspace_key TEXT, archived INTEGER, deleted INTEGER, pinned INTEGER, created_at INTEGER, updated_at INTEGER, model TEXT, mode TEXT, task_status TEXT, title_overridden INTEGER)');
  ti.exec("INSERT INTO tasks VALUES ('sess_a', 'ZCode 的已删会话', '" + WS + "', '" + WS + "', 0, 1, 0, 1, 2, 'm', 'build', 'completed', 0)");
  ti.exec("INSERT INTO tasks VALUES ('sess_b', 'ZCode 的活跃会话', '" + WS + "', '" + WS + "', 0, 0, 0, 1, 2, 'm', 'build', 'completed', 0)");
  ti.close();
}

/* ── Cursor 工作区反查 ────────────────────────────────────── */

test('workspaceFolders 把 workspace.json 的 folder 还原成绝对路径', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-wsmap-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const ide = path.join(temp, 'Cursor');
  const wsBase = path.join(ide, 'User', 'workspaceStorage');

  const mk = async (uuid, folder) => {
    const dir = path.join(wsBase, uuid);
    await fs.mkdir(dir, { recursive: true });
    if (folder !== undefined) await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ folder }));
  };

  await mk('u1', 'file:///tmp/agent-inspector-ws-test');
  await mk('u2', 'file:///tmp/agent-inspector-ws-test/%E4%B8%AD%E6%96%87');   // percent-encoded
  await mk('u3', 'vscode-remote://ssh-remote+box/srv/app');                  // 远端工作区：本地无路径
  await mk('u4', 'not a url');
  await mk('u5');                                                            // 没有 workspace.json（empty-window 那样）
  await fs.mkdir(path.join(wsBase, 'u6'), { recursive: true });
  await fs.writeFile(path.join(wsBase, 'u6', 'workspace.json'), 'not json');

  const m = await workspaceFolders(ide);
  assert.deepEqual([...m.entries()].sort(), [
    ['u1', '/tmp/agent-inspector-ws-test'],
    ['u2', '/tmp/agent-inspector-ws-test/中文'],
  ], '只有能解析成本机绝对路径的才映射；远端、坏 URL、缺文件、坏 JSON 全部跳过');
});

/* ── Cursor 反查的接口级验证 ──────────────────────────────── */

test('反查不到时 Cursor 会话保持 UUID，不猜项目', async (t) => {
  const f = await fixture(t);
  const ide = f.cursorIde;
  // composerId 必须是 36 位（Cursor 存的就是 UUID/ULID 这种长度）：
  // tasks-cursor.mjs 靠 substr(key, 10, 36) 从 bubbleId:<id>:<气泡> 里切回 id，
  // 用短 id 会切出带冒号的串、跟会话头对不上，平白多出一个"残骸"桶。
  const composerId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const db = new DatabaseSync(path.join(ide, 'User', 'globalStorage', 'state.vscdb'));
  db.exec('CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
  // workspaceStorage 里没有这个 uuid —— 映不出来
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, 1, 2, 0, 0, 3)').run(composerId, 'nowhere-uuid');
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`bubbleId:${composerId}:b1`, '正文');
  db.close();

  // 反查不到就原样保留 UUID —— 不猜一个项目出来
  const tasks = await f.get('/api/tasks?app=cursor');
  assert.equal(tasks.body.tasks.length, 1, '只有一条会话，不该分出残骸');
  assert.equal(tasks.body.tasks[0].workspace, 'nowhere-uuid');
});

/* ── 行级清理：四道闸 ─────────────────────────────────────── */

test('逐 app 的可清会话，过 /api/tasks/purge 的四道闸', async (t) => {
  const f = await fixture(t);
  seedZcode(f.home);          // ZCode：sess_a（deleted=1 可清）+ sess_b（active 不可清），同一 cwd

  // Codex：同 cwd 的一条 archived 线程 —— 归并进同一项目，也能按行清
  const codexUuid = '01ab0000-0000-0000-0000-000000000001';
  const wsBody = `sessions/2026/10/01/rollout-2026-10-01T00-00-00-${codexUuid}.jsonl`;
  await fs.mkdir(path.join(f.home, '.codex', 'sessions', '2026', '10', '01'), { recursive: true });
  await fs.writeFile(path.join(f.home, '.codex', wsBody), '正文'.repeat(64));
  const codexDb = new DatabaseSync(path.join(f.home, '.codex', 'state_5.sqlite'));
  codexDb.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, rollout_path TEXT,
    created_at INTEGER, updated_at INTEGER, archived INTEGER, archived_at INTEGER,
    is_pinned INTEGER, tokens_used INTEGER, model TEXT, model_provider TEXT,
    history_mode TEXT, thread_source TEXT, preview TEXT)`);
  codexDb.prepare('INSERT INTO threads VALUES (?, ?, NULL, ?, ?, 1, 2, 1, 3, 0, 0, ?, ?, ?, ?, ?)')
    .run(codexUuid, 'Codex 的归档会话', WS, path.join(f.home, '.codex', wsBody), 'gpt', 'openai', 'paginated', 'user', 'p');
  codexDb.close();

  // 1) 两个工具各自的可清会话 —— 判定只看 reason，不看 state
  const [tz, tc] = await Promise.all([
    f.get('/api/tasks?app=zcode'),
    f.get('/api/tasks?app=codex'),
  ]);
  const zcodeIds = tz.body.tasks.filter((x) => x.reason != null).map((x) => x.id);
  const codexIds = tc.body.tasks.filter((x) => x.reason != null).map((x) => x.id);
  assert.equal(zcodeIds.length, 2,
    'ZCode 两条可清：deleted 一条、active 但工作区目录不存在（wsMissing）一条');
  assert.equal(codexIds.length, 1, 'Codex 一条归档线程');

  // 2) 逐 app 批次真的能各自走完四道闸：dryRun 两个 app，互不干扰

  const [dz, dc] = await Promise.all([
    f.post('/api/tasks/purge', { app: 'zcode', ids: zcodeIds, dryRun: true }),
    f.post('/api/tasks/purge', { app: 'codex', ids: codexIds, dryRun: true }),
  ]);
  assert.equal(dz.status, 200, JSON.stringify(dz.body));
  assert.equal(dc.status, 200, JSON.stringify(dc.body));
  assert.ok(dz.body.counts, 'ZCode 空跑报逐表行数');
  assert.ok(Array.isArray(dc.body.perDb), 'Codex 空跑报逐库逐表数组');
  assert.ok(dz.body.counts.session >= 1);
  assert.ok(dc.body.perDb.some((r) => r.count > 0));

  // 3) 真删：逐批调用（编排由前端做），两边的行都消失、正文文件留下。
  //    但这台机器可能正开着 ZCode/Codex —— 进程闸会正确拒绝（409）。
  //    闸生效本身就是一次验证：跳过真删断言，不假装它跑过。
  const pz = await f.post('/api/tasks/purge', { app: 'zcode', ids: zcodeIds, confirm: '清理' });
  if (pz.status === 409) {
    assert.match(pz.body.error, /正在运行/, '进程闸拒绝时必须说清是谁在跑');
  } else {
    assert.equal(pz.status, 200, JSON.stringify(pz.body));
    assert.ok(pz.body.freed >= 0);
    const afterZ = await f.get('/api/tasks?app=zcode');
    assert.equal(afterZ.body.tasks.length, 0, '两条可清会话都已删除');
  }
  const pc = await f.post('/api/tasks/purge', { app: 'codex', ids: codexIds, confirm: '清理' });
  if (pc.status === 409) {
    assert.match(pc.body.error, /正在运行/);
  } else {
    assert.equal(pc.status, 200, JSON.stringify(pc.body));
    assert.ok(pc.body.freed >= 0);
    const afterC = await f.get('/api/tasks?app=codex');
    assert.equal(afterC.body.tasks.filter((x) => x.state === 'archived').length, 0, '归档线程已清');
    // 正文文件在磁盘上（Codex 的行级删除不碰文件 —— 那是文件线的活）
    await fs.access(path.join(f.home, '.codex', wsBody));
  }
});

/* ── Gemini / Antigravity：第五个工具 ────────────────────── */

test('Gemini 摘要库只读列出会话，工作区 URI 还原成路径', async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(path.join(f.home, '.gemini', 'antigravity', 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '',
    step_count INTEGER NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL,
    last_user_input_time datetime NOT NULL, workspace_uris TEXT NOT NULL, status TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '', agent_name TEXT NOT NULL DEFAULT '',
    parent_conversation_id TEXT NOT NULL DEFAULT '', nesting_depth INTEGER NOT NULL DEFAULT 0,
    battle_id TEXT NOT NULL DEFAULT '', winning_conversation_id TEXT NOT NULL DEFAULT '',
    not_fully_idle numeric NOT NULL DEFAULT false, killed numeric NOT NULL DEFAULT false,
    app_data_dir TEXT NOT NULL DEFAULT '', raw_summary blob, group_id TEXT NOT NULL DEFAULT '')`);
  // 两条会话：一条带 file:// 工作区（应还原成路径）、一条坏了的 URI（留空不猜）
  db.prepare(`INSERT INTO conversation_summaries
    (conversation_id, title, step_count, last_modified_time, last_user_input_time, workspace_uris, nesting_depth, killed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('conv-1', 'Gemini 的会话', 12, '2026-10-18 10:00:00', '2026-10-18 10:00:00',
      JSON.stringify(['file://' + WS]), 0, 0);
  db.prepare(`INSERT INTO conversation_summaries
    (conversation_id, title, step_count, last_modified_time, last_user_input_time, workspace_uris, nesting_depth, killed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('conv-2', '坏的 URI', 1, '2026-10-18 09:00:00', '2026-10-18 09:00:00', 'not-json', 0, 0);
  db.close();

  // 单 app 视图：只读、无 reason（正文在云端，删摘要 = 半删）
  const tasks = await f.get('/api/tasks?app=gemini');
  assert.equal(tasks.status, 200);
  assert.equal(tasks.body.readOnly, true);
  assert.equal(tasks.body.tasks.length, 2);
  const withWs = tasks.body.tasks.find((x) => x.id === 'conv-1');
  assert.equal(withWs.workspace, WS);
  assert.equal(withWs.reason, null);
  // 坏 URI 的会话留空，不猜
  assert.equal(tasks.body.tasks.find((x) => x.id === 'conv-2').workspace, '');

  // 行级删除在任何进程检查之前就被静态拒绝
  const purge = await f.post('/api/tasks/purge', { app: 'gemini', ids: ['conv-1'] });
  assert.equal(purge.status, 403);
  assert.match(purge.body.error, /半删/);
});

test('Gemini 分类规则：摘要库锁定、缓存可清、CLI 经典布局归对类', async (t) => {
  const f = await fixture(t);
  // 夹具里放几个真实形态的文件
  await fs.mkdir(path.join(f.home, '.gemini', 'antigravity', 'cache', 'm'), { recursive: true });
  await fs.writeFile(path.join(f.home, '.gemini', 'antigravity', 'cache', 'm', 'marketplace.json'), '{}');
  await fs.writeFile(path.join(f.home, '.gemini', 'jetski-standalone-oauth-token'), 'tok');
  const summary = path.join(f.home, '.gemini', 'antigravity', 'conversation_summaries.db');
  await fs.writeFile(summary, 'SQLite format 3');

  const scan = await f.get('/api/scan');
  const g = scan.body.apps.find((a) => a.app === 'gemini');
  assert.ok(g, 'scan 里有 gemini');
  assert.equal(g.installed !== false, true, '夹具装了 .gemini');
  // 分类表里每个 id 只能出现一次 —— shared(key, ...) 的 id 取自第一个参数，
  // 写成 shared('database', ...) 挂在 summaryIndex 下会静默产生两个 database、丢掉 summaryIndex。
  const ids = g.catalog.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `分类表 id 重复：${ids.join(', ')}`);
  const idx = g.catalog.find((c) => c.id === 'summaryIndex');
  assert.ok(idx, '摘要库要有自己的分类 id');
  assert.equal(idx.locked, true);
  assert.equal(g.files.find((x) => x.p === 'antigravity/conversation_summaries.db').c, 'summaryIndex');

  // 摘要库是本机唯一的会话入口：整文件锁定，'彻底删除' 也拒绝，且不留半成品
  const del = await f.post('/api/purge', { app: 'gemini', paths: ['antigravity/conversation_summaries.db'], confirm: '彻底删除', force: true });
  assert.equal(del.status, 403, JSON.stringify(del.body));
  assert.equal(await fs.readFile(summary, 'utf8'), 'SQLite format 3');
  // 也不能靠删父目录绕过
  const viaParent = await f.post('/api/purge', { app: 'gemini', paths: ['antigravity'], confirm: '彻底删除', force: true });
  assert.equal(viaParent.status, 403, JSON.stringify(viaParent.body));
  assert.equal(await fs.readFile(summary, 'utf8'), 'SQLite format 3');

  // 凭据受保护
  const proj = await f.post('/api/purge', { app: 'gemini', paths: ['jetski-standalone-oauth-token'], confirm: '彻底删除' });
  assert.equal(proj.status, 403, JSON.stringify(proj.body));

  // 但不是一刀切：缓存照样能清
  const cache = await f.post('/api/purge', { app: 'gemini', paths: ['antigravity/cache'], confirm: '彻底删除' });
  assert.equal(cache.status, 200, JSON.stringify(cache.body));
  await assert.rejects(fs.access(path.join(f.home, '.gemini', 'antigravity', 'cache')));
});

test('并发读多个 app 的会话库时不互相踩临时副本', async (t) => {
  const f = await fixture(t);
  const ide = f.cursorIde;
  const uuid = '99998888-7777-6666-5555-444433332222';
  await fs.mkdir(path.join(ide, 'User', 'workspaceStorage', uuid), { recursive: true });
  await fs.writeFile(path.join(ide, 'User', 'workspaceStorage', uuid, 'workspace.json'),
    JSON.stringify({ folder: 'file://' + WS }));

  // WAL 模式的库（带 -wal/-shm）打不开只读时会走 copyAside 那条路 ——
  // 多个 worker 并发时，各自的临时目录前缀必须不同，否则会互相覆盖/删除。
  const dbPath = path.join(ide, 'User', 'globalStorage', 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
  const cid = 'dddd4444-5555-6666-7777-888899990000';
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, 1, 2, 0, 0, 3)').run(cid, uuid);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`bubbleId:${cid}:b1`, '正文');
  db.close();

  seedZcode(f.home);

  // 同时打两次 Cursor（撞缓存）+ 一次 ZCode：只要任何一个 worker 删了别人的副本，
  // 这里就会出问题（读不到会话或报错）。
  const [c1, c2, z1] = await Promise.all([
    f.get('/api/tasks?app=cursor'),
    f.get('/api/tasks?app=cursor'),
    f.get('/api/tasks?app=zcode'),
  ]);
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c2.status, 200, JSON.stringify(c2.body));
  assert.equal(z1.status, 200, JSON.stringify(z1.body));

  assert.equal(c1.body.tasks.length, 1, 'Cursor 的会话要能在并发下读到');
  assert.equal(c1.body.tasks[0].workspace, WS, 'workspace.json 的反查也要活着');
  // 两次结果必须一致 —— 副本被抽走会导致其中一次少数据
  assert.equal(c1.body.tasks.length, c2.body.tasks.length);
  assert.equal(c1.body.totals.bytes, c2.body.totals.bytes);
});

test('全域删除边界：未知 app 与空 app 仍是客户端错误', async (t) => {
  const f = await fixture(t);
  seedZcode(f.home);
  const cache = path.join(f.home, '.zcode', 'v2', 'cache');
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, 'x.bin'), 'x');

  assert.equal((await f.post('/api/purge', { app: 'gemini', paths: ['v2/cache'], confirm: '彻底删除' })).status, 400);
  assert.equal((await f.post('/api/purge', { app: '', paths: ['v2/cache'], confirm: '彻底删除' })).status, 400);
  // 合法 app + 合法路径照旧能删（全域视图的勾选最终走的是这条路）
  const ok = await f.post('/api/purge', { app: 'zcode', target: 'root', paths: ['v2/cache'], confirm: '彻底删除' });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal(ok.body.deleted.length, 1);
  await assert.rejects(fs.access(path.join(f.home, '.zcode', 'v2', 'cache')));
});
