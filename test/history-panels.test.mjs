/**
 * 历史会话面板的接口层：四个 app 各扫各的库，形状必须一致。
 *
 * 这些接口要读会话库（走的是 worker 链路），所以夹具不用空目录，而是用 node:sqlite
 * 把最小可用的会话库建出来 —— 做法与 codex-tasks.test.mjs 同源。
 * 所有库都在临时 HOME 下，绝不碰真实数据。
 *
 * 这里专门盯四件容易回归的事：
 *   - 四个 app 的会话行与 byState 满足同一份契约（见文件末尾的契约组）
 *   - Cursor 的 workspaceStorage/<uuid>/workspace.json 能把 UUID 还原成路径，
 *     解析不了时退回 UUID 而不是猜
 *   - 按行清理的四道闸：静态拒绝 → 进程探测 → 备份 → 事务+自检
 *   - 只读的 Cursor 在任何进程检查之前就被静态拒绝
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
import { STATES, REASONS } from '../lib/tasks-shape.mjs';

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
  await fs.mkdir(path.join(home, '.dsh'), { recursive: true });
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

/* ── 每家各来一条：契约测试要有行可断言 ─────────────────── */

/** 在同一个临时 HOME 下把四个 app 的最小会话都造出来。 */
async function seedAll(home) {
  seedZcode(home);

  // Codex：一条归档线程 + 磁盘上的 rollout 正文
  const codexUuid = '01ab0000-0000-0000-0000-0000000000aa';
  const codexRel = `sessions/2026/10/01/rollout-2026-10-01T00-00-00-${codexUuid}.jsonl`;
  await fs.mkdir(path.dirname(path.join(home, '.codex', codexRel)), { recursive: true });
  await fs.writeFile(path.join(home, '.codex', codexRel), '正文'.repeat(64));
  const codexDb = new DatabaseSync(path.join(home, '.codex', 'state_5.sqlite'));
  codexDb.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, rollout_path TEXT,
    created_at INTEGER, updated_at INTEGER, archived INTEGER, archived_at INTEGER,
    is_pinned INTEGER, tokens_used INTEGER, model TEXT, model_provider TEXT,
    history_mode TEXT, thread_source TEXT, preview TEXT)`);
  codexDb.prepare('INSERT INTO threads VALUES (?, ?, NULL, ?, ?, 1, 2, 1, 3, 0, 0, ?, ?, ?, ?, ?)')
    .run(codexUuid, 'Codex 的会话', WS, path.join(home, '.codex', codexRel), 'gpt', 'openai', 'paginated', 'user', 'p');
  codexDb.close();

  // Claude：正文就是 .jsonl，第一行带 cwd / 时间 / 模型
  const slug = '-tmp-agent-inspector-ws-test';
  await fs.mkdir(path.join(home, '.claude', 'projects', slug), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'projects', slug, 'claude-sess-1.jsonl'),
    JSON.stringify({ type: 'user', cwd: WS, timestamp: '2026-10-01T00:00:00Z',
      message: { content: 'Claude 的会话' }, model: 'claude-x' }) + '\n');

  // Cursor：一条界面里的会话 + 一组没有会话头的残骸气泡
  const cursorDb = new DatabaseSync(path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  cursorDb.exec('CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, value TEXT)');
  cursorDb.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
  const cursorId = 'dddd4444-5555-6666-7777-888899990000';
  const orphanId = 'ffff1111-2222-3333-4444-555566667777';
  cursorDb.prepare('INSERT INTO composerHeaders VALUES (?, ?, 1, 2, 0, 0, 3, ?)')
    .run(cursorId, 'nowhere-uuid', JSON.stringify({ type: 'head', composerId: cursorId, name: 'Cursor 的会话标题' }));
  cursorDb.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`bubbleId:${cursorId}:b1`, '正文');
  cursorDb.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`bubbleId:${orphanId}:b1`, '没人认领的正文');
  cursorDb.close();

  await seedDsh(home);
}

/**
 * DeepSeek Harness：一个会话 = 一个目录（正文 + 空锁），
 * 元数据在 storages/ 下那两份未压缩 JSON 里 —— 不写投影的那条用来验兜底路径。
 */
async function seedDsh(home) {
  const root = path.join(home, '.dsh');
  const slug = '--tmp-agent-inspector-ws-test--';
  const withProj = 'session-1111aaaa-0000-0000-0000-000000000001';
  const noProj = 'session-2222bbbb-0000-0000-0000-000000000002';

  for (const id of [withProj, noProj]) {
    const dir = path.join(root, 'sessions', slug, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), 'z'.repeat(512));
    await fs.writeFile(path.join(dir, 'session.lock'), '');
  }

  // 正文开头（兜底路径要解压它）
  const zlib = await import('node:zlib');
  /* 这条会话故意不给投影，用来验兜底路径。正文写成真 zstd 还是垃圾都行：
     这条测试只关心"行与 byState 的契约"，标题从投影来还是从 id 来不影响判据。
     `zstdCompressSync` 要到 Node 22.15 / 23.8 才有，而 CI 矩阵里有 22.5 ——
     那一档造不出压缩数据，退回一段解不开的字节即可。 */
  const lines = [
    { type: 'session', version: 4, id: noProj, createdAt: 1790000000000, cwd: WS, agentPreset: 'standard' },
    { type: 'user/message', data: { content: [{ type: 'text', text: '没有投影的会话' }], source: { kind: 'user' } } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  const body = typeof zlib.zstdCompressSync === 'function'
    ? zlib.zstdCompressSync(Buffer.from(lines, 'utf8'))
    : Buffer.from(lines, 'utf8');
  await fs.writeFile(path.join(root, 'sessions', slug, noProj, 'session.v4.jsonl.zstd'), body);

  // 工作区索引：一条归档、一条置顶
  await fs.mkdir(path.join(root, 'storages'), { recursive: true });
  await fs.writeFile(path.join(root, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['w1'],
      archivedSessionIds: [withProj],
      pinnedSessionIds: [noProj],
      defaultWorkspaceId: 'w1',
    },
    tables: {
      workspaces: {
        w1: { path: WS, title: 'ws', sessionIds: [withProj, noProj], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
      },
    },
  }));

  // 只给第一条写投影：第二条必须走解压兜底
  await fs.mkdir(path.join(root, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  await fs.writeFile(path.join(root, 'storages', 'session_projcache', 'sessions', `${withProj}.json`),
    JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1790000000000, cwd: WS, isSeeded: false, inheritedEventCount: 0 },
        rows: {
          title: { ver: 1, seq: 9, val: '有投影的会话' },
          agentPreset: { ver: 1, seq: 9, val: 'standard' },
          sessionStats: { ver: 1, seq: 9, val: { turns: 1, steps: 7 } },
          modelSelection: { ver: 1, seq: 9, val: { lastUsed: { provider: 'magpie', model: 'deepseek-v4.1-flash' } } },
        },
      },
    }));
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
  db.exec('CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, value TEXT)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
  // workspaceStorage 里没有这个 uuid —— 映不出来
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, 1, 2, 0, 0, 3, NULL)').run(composerId, 'nowhere-uuid');
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
  // 两家的空跑现在报同一套形状：逐库逐表数组（不再有 ZCode 专用的 counts 对象）
  assert.ok(Array.isArray(dz.body.perDb), 'ZCode 空跑也报逐库逐表数组');
  assert.ok(Array.isArray(dc.body.perDb), 'Codex 空跑报逐库逐表数组');
  assert.equal(dz.body.counts, undefined, '同一件事只该有一种形状');
  assert.ok(dz.body.perDb.some((r) => r.table === 'session' && r.count >= 1), '会话表至少一行');
  assert.ok(dz.body.perDb.some((r) => r.table === 'message' && r.count >= 1), '消息表至少一行');
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
    /* 级联：会话删掉之后，它的 rollout 正文也不该留在盘上 ——
       以前留着，于是"删了会话"在磁盘上等于什么都没发生，用户还得去
       文件清单再清一遍。这条断言就是那个行为的守门人。 */
    assert.equal(pc.body.files.length, 1, '正文文件应随会话一起删除');
    assert.equal(pc.body.files[0].rel, wsBody);
    await assert.rejects(fs.access(path.join(f.home, '.codex', wsBody)),
      '正文文件删完就不该还在');
    // 删之前必须备份过 —— 没有备份的级联删除是不可接受的
    assert.ok(pc.body.backup, '级联删除必须给出备份位置');
  }
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
  db.exec('CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, value TEXT)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
  const cid = 'dddd4444-5555-6666-7777-888899990000';
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, 1, 2, 0, 0, 3, NULL)').run(cid, uuid);
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

test('Cursor 键族按首个分隔符归并，内容寻址的 hash 不各占一族', async (t) => {
  const f = await fixture(t);
  const ide = f.cursorIde;
  const dbPath = path.join(ide, 'User', 'globalStorage', 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, value TEXT)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
  const cid = 'dddd4444-5555-6666-7777-888899990000';
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, 1, 2, 0, 0, 3, NULL)').run(cid, 'ws');
  const put = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  // 三种键写法并存：冒号分隔、点号分隔（内容寻址的 hash）、斜杠分隔
  put.run(`bubbleId:${cid}:b1`, 'a'.repeat(64));
  put.run('agentKv:blob:1', 'b'.repeat(64));
  put.run('composer.content.' + 'f'.repeat(64), 'c'.repeat(64));
  put.run('composer.content.' + 'e'.repeat(64), 'd'.repeat(64));
  put.run('composer.content.' + 'd'.repeat(64), 'e'.repeat(64));
  put.run('slashMenuItems/v7/local.glass', 'f'.repeat(16));
  db.close();

  const { status, body } = await f.get('/api/tasks?app=cursor');
  assert.equal(status, 200, JSON.stringify(body));

  const families = body.composition.map((c) => c.family);
  // 三个 composer.content.* 必须合成一族，而不是三个各含一个 hash 的族
  assert.equal(families.filter((x) => x === 'composer').length, 1, `族列表：${families.join(', ')}`);
  assert.ok(!families.some((x) => x.startsWith('composer.content.')), 'hash 不该被当成族名');
  assert.ok(families.includes('slashMenuItems'), '斜杠分隔的键也要归族');

  // 归并后，那一族要装下全部三条
  const contentRow = body.composition.find((c) => c.family === 'composer');
  assert.equal(contentRow.count, 3);
  assert.equal(contentRow.bytes, 64 * 3);
});

test('Cursor 会话标题取自 composerHeaders.value 的 name，不是拼出来的 UUID', async (t) => {
  const f = await fixture(t);
  const dbPath = path.join(f.cursorIde, 'User', 'globalStorage', 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, value TEXT)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');

  const named = '11111111-1111-1111-1111-111111111111';
  const subbed = '22222222-2222-2222-2222-222222222222';
  const bare = '33333333-3333-3333-3333-333333333333';
  const ins = db.prepare('INSERT INTO composerHeaders VALUES (?, ?, 1, 2, 0, 0, 3, ?)');
  // 正常：Cursor 起了名
  ins.run(named, 'ws', JSON.stringify({ type: 'head', name: 'Write-off time synchronization' }));
  // 只有改动摘要：拿摘要当标题，总比 UUID 强
  ins.run(subbed, 'ws', JSON.stringify({ type: 'head', subtitle: 'Edited QueryLoanAccrual.java' }));
  // 两者都没有：不该冒充成正常标题
  ins.run(bare, 'ws', JSON.stringify({ type: 'head' }));
  db.close();

  const { status, body } = await f.get('/api/tasks?app=cursor');
  assert.equal(status, 200, JSON.stringify(body));

  const byId = new Map(body.tasks.map((x) => [x.id, x]));
  assert.equal(byId.get(named).title, 'Write-off time synchronization');
  assert.equal(byId.get(subbed).title, 'Edited QueryLoanAccrual.java');
  // 无名的那条：用带前缀的占位，并且要能被认出来
  assert.match(byId.get(bare).title, /^（无标题）/);
  assert.ok(!byId.get(named).title.includes(named.slice(0, 8)), '有名字的会话不该再露 UUID');

  // 无名的条数要报上去，前端才能主动交代一句
  assert.equal(body.untitled, 1);
});

/* ── 契约组：各家的行与统计必须是同一套 ─────────────────── */

/** 每行的核心 13 个字段与类型。只断言"存在 + 值域"，不断言字段集合完全相等 ——
 *  各家可以有附加字段，但缺一个键就会一路以 undefined 画到界面上。 */
const ROW_FIELDS = {
  id: 'string', title: 'string', workspace: 'string', state: 'string',
  pinned: 'boolean', model: 'string', typeLabel: 'string',
  createdAt: 'number', updatedAt: 'number', bytes: 'number', rows: 'number', children: 'number',
};

test('每个 app 的会话行与 byState 遵循同一份契约', async (t) => {
  const f = await fixture(t);
  await seedAll(f.home);

  for (const app of ['zcode', 'codex', 'claude', 'cursor', 'dsh']) {
    const { status, body } = await f.get('/api/tasks?app=' + app);
    assert.equal(status, 200, `${app}: ${JSON.stringify(body)}`);
    assert.ok(body.tasks.length > 0, `${app} 造了会话就要读得出来`);
    assert.equal(body.totals.count, body.tasks.length, `${app} 的总数要等于行数`);

    for (const row of body.tasks) {
      for (const [field, type] of Object.entries(ROW_FIELDS)) {
        assert.equal(typeof row[field], type, `${app} 的行缺少 ${field}（值：${JSON.stringify(row[field])}）`);
      }
      // 必填的两个字段不能是空串 —— 空串会画成一张没有名字、也选不中的卡片
      assert.notEqual(row.id, '', `${app} 的行必须有 id`);
      assert.notEqual(row.title, '', `${app} 的行必须有标题`);
      assert.ok(STATES.includes(row.state), `${app} 的 state 越界：${row.state}`);
      assert.ok(row.reason === null || REASONS.includes(row.reason), `${app} 的 reason 越界：${row.reason}`);
      // 可选但恒定存在的两个字段
      assert.ok(row.bodyRel === null || typeof row.bodyRel === 'string', `${app} 的 bodyRel 类型不对`);
      assert.equal(typeof row.residual, 'boolean', `${app} 的 residual 要是布尔`);
    }

    // byState：每条恰好三个键、键取自 state（不是 reason）、只留真实存在的桶。
    // 拿 reason 当键的钮点了永远筛不出东西：'wsMissing' 不在状态表里，
    // 界面上渲染成字面量 undefined。
    for (const g of body.totals.byState) {
      assert.deepEqual(Object.keys(g).sort(), ['bytes', 'count', 'state'], `${app} 的 byState 条目形状不对`);
      assert.ok(STATES.includes(g.state), `${app} 的 byState 键必须是 state：${g.state}`);
      assert.ok(g.count > 0, `${app} 不该输出空桶`);
      assert.equal(typeof g.bytes, 'number', `${app} 的 byState.bytes 要是数字`);
    }
    // 核心回归钉：各段体积之和 == 总量。Codex 的投影双算与 Claude 的旧键空间都会在这里红。
    assert.equal(body.totals.byState.reduce((s, g) => s + g.bytes, 0), body.totals.bytes,
      `${app} 的 byState 体积合计必须等于 totals.bytes`);
  }
});

test('缺库时每个 app 都返回完整信封，不静默', async (t) => {
  const f = await fixture(t);   // 只建了目录，一个会话库都没有
  for (const app of ['zcode', 'codex', 'claude', 'cursor', 'dsh']) {
    const { status, body } = await f.get('/api/tasks?app=' + app);
    assert.equal(status, 200, `${app}: ${JSON.stringify(body)}`);
    assert.deepEqual(body.tasks, [], `${app} 缺库时没有会话`);
    assert.ok(Array.isArray(body.totals.byState), `${app} 的 byState 要是数组`);
    assert.ok(Array.isArray(body.db.dbs), `${app} 的 db.dbs 要是数组`);
    assert.equal(typeof body.db.total, 'number', `${app} 的 db.total 要是数字`);
    assert.ok(body.problems.length > 0, `${app} 缺库必须报出来 —— 静默看起来就像"装了但空的"`);
    assert.equal(typeof body.scanMs, 'number', `${app} 的 scanMs 要是数字`);
  }
});

test('能力位由后端单源给出：各家都可写，可回灌只有 Cursor', async (t) => {
  const f = await fixture(t);
  /* "库由 IDE 独占写入、没有外键可依"只说明"不能靠外键删"，不等于"不能删"。
     现在 Cursor 走可达性分析那条路径（lib/cursor-purge.mjs），所以各家都可写。 */
  const readOnly = { zcode: false, codex: false, claude: false, cursor: false, dsh: false };
  for (const [app, expected] of Object.entries(readOnly)) {
    const { status, body } = await f.get('/api/tasks?app=' + app);
    assert.equal(status, 200, app);
    assert.equal(body.readOnly, expected, `${app} 的 readOnly`);
    assert.equal(body.canRecover, app === 'cursor', `${app} 的 canRecover 只有 Cursor 为真`);
    if (expected) assert.ok((body.readOnlyNote || '').length > 0, `${app} 只读必须给出理由`);
  }

  // /api/scan 的 app 视图也要带 canRecover —— 前端在 /api/tasks 到达之前就要决定面板显隐
  const scan = await f.get('/api/scan');
  const cursorView = scan.body.apps.find((a) => a.app === 'cursor');
  assert.ok(cursorView, 'scan 里要有 cursor');
  for (const a of scan.body.apps) {
    assert.equal(typeof a.canRecover, 'boolean', `${a.app} 的 scan 视图缺 canRecover`);
    assert.equal(a.canRecover, a.app === 'cursor', `${a.app} 的 canRecover`);
  }
});

/* ── 全域删除边界 ─────────────────────────────────────────── */

test('全域删除边界：未知 app 与空 app 仍是客户端错误', async (t) => {
  const f = await fixture(t);
  seedZcode(f.home);
  const cache = path.join(f.home, '.zcode', 'v2', 'cache');
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, 'x.bin'), 'x');

  assert.equal((await f.post('/api/purge', { app: 'nosuchtool', paths: ['v2/cache'], confirm: '彻底删除' })).status, 400);
  assert.equal((await f.post('/api/purge', { app: '', paths: ['v2/cache'], confirm: '彻底删除' })).status, 400);
  // 合法 app + 合法路径照旧能删（全域视图的勾选最终走的是这条路）
  const ok = await f.post('/api/purge', { app: 'zcode', target: 'root', paths: ['v2/cache'], confirm: '彻底删除' });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal(ok.body.deleted.length, 1);
  await assert.rejects(fs.access(path.join(f.home, '.zcode', 'v2', 'cache')));
});

test('ZCode 的级联把会话的四类文件也带走，而不只是库行', async (t) => {
  /* 这一条守的是级联的**完整性**：ZCode 的会话正文在库里，但运行期会在
     cli/ 下留四类文件（子 Agent transcript / 产物 / 贴图 / 命令日志）。
     以前删会话只删库行，这些文件全留在盘上变成孤儿 —— 用户得去文件清单
     再清一遍，而"我删了这条会话"在人的理解里就是"关于它的东西都没了"。 */
  const f = await fixture(t);
  seedZcode(f.home);
  const sess = 'sess_a';
  const files = {
    transcript: path.join(f.home, '.zcode', 'cli', 'agents', sess, 'transcript.jsonl'),
    artifact: path.join(f.home, '.zcode', 'cli', 'artifacts', sess, 'out.bin'),
    media: path.join(f.home, '.zcode', 'cli', 'image-cache', sess, 'a.png'),
    log: path.join(f.home, '.zcode', 'cli', 'exec', sess, 'call_1-stdout.log'),
  };
  for (const [name, p] of Object.entries(files)) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, name.repeat(10));
  }

  // 先看计划：列表里这一行的「所属内容」应该已经列出这四类
  const before = await f.get('/api/tasks?app=zcode');
  const row = before.body.tasks.find((x) => x.id === sess);
  assert.ok(row, '这条会话要在列表里');
  const roles = new Set((row.contents?.files || []).map((x) => x.role));
  assert.deepEqual([...roles].sort(), ['artifact', 'log', 'media', 'transcript'],
    '四类文件都要在设计清单里，少一类就是删完留孤儿');

  const res = await f.post('/api/tasks/purge', { app: 'zcode', ids: [sess], confirm: '清理' });
  if (res.status === 409) {
    assert.match(res.body.error, /正在运行/);
    return;   // 进程闸生效也算通过（这台机器可能开着 ZCode）
  }
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.files.length, 4, '四类文件都要被处理');
  for (const [name, p] of Object.entries(files)) {
    await assert.rejects(fs.access(p), `${name} 应该已经不在了`);
  }
});

test('活跃会话的清理要升级确认串：轻词被拒、重词放行', async (t) => {
  /* 放开活跃会话之后，"删掉后应用历史会少几项"这件事只能靠确认串兜住。
     这一条守的是服务端那半边：界面说重词，服务端就必须只认重词 ——
     否则绕过界面直接打接口，一句「清理」就能删掉还在用的会话。 */
  const f = await fixture(t);
  seedZcode(f.home);
  /* sess_b 要成为**真正的活跃会话**（reason=manual），工作区目录必须真的存在 ——
     否则它会被判成 wsMissing，走的是轻词，这条测试就验不到升级逻辑了。
     建在临时 HOME 里，不碰任何真实路径。 */
  const ws = path.join(f.home, 'ws');
  await fs.mkdir(ws, { recursive: true });
  const db = new DatabaseSync(path.join(f.home, '.zcode', 'v2', 'tasks-index.sqlite'));
  db.exec("UPDATE tasks SET workspace_path='" + ws + "' WHERE task_id='sess_b'");
  db.close();
  const ids = ['sess_b'];

  /* 确认串的校验排在进程闸**之前**（服务端刻意这么排：先算清这批要什么词，
     再问应用退没退）。所以这一步在任何环境下都该是 400，不受"应用正开着"影响。 */
  const light = await f.post('/api/tasks/purge', { app: 'zcode', ids, confirm: '清理' });
  assert.equal(light.status, 400, '含活跃会话时轻词必须被拒：' + JSON.stringify(light.body));
  assert.match(light.body.error, /删除活跃会话/);
  assert.match(light.body.error, /主列表/, '要说清为什么拒');

  // 数据一条都不能少
  const still = await f.get('/api/tasks?app=zcode');
  assert.ok(still.body.tasks.some((x) => x.id === 'sess_b'), '被拒时不能删掉任何东西');

  const heavy = await f.post('/api/tasks/purge', { app: 'zcode', ids, confirm: '删除活跃会话' });
  /* 重词这步会撞上进程闸：这台机器可能正开着 ZCode（CI 上不会）。
     409 也是正确行为 —— 闸生效本身就该被验证，不该假装它跑过。 */
  if (heavy.status === 409) {
    assert.match(heavy.body.error, /正在运行/, '进程闸拒绝时要说清是谁在跑');
    return;
  }
  assert.equal(heavy.status, 200, JSON.stringify(heavy.body));
  const gone = await f.get('/api/tasks?app=zcode');
  assert.ok(!gone.body.tasks.some((x) => x.id === 'sess_b'), '重词放行，活跃会话被删');
});
