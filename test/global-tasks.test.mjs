/**
 * 全域聚合与按项目横切。
 *
 * 这些接口要读会话库（/api/projects 走的是与 /api/tasks 同一条 worker 链路），
 * 所以夹具不用空目录，而是用 node:sqlite 把最小可用的会话库建出来 ——
 * 做法与 codex-tasks.test.mjs 同源。所有库都在临时 HOME 下，绝不碰真实数据。
 *
 * 这里专门盯三件容易回归的事：
 *   - /api/summary 的"可回收"口径必须与前端"推荐清理"一致（recommend && !recommendDefaultOff）
 *   - 两个工具写成同一个 cwd 的会话必须归并成一个项目
 *   - Cursor 的 workspaceStorage/<uuid>/workspace.json 必须能把 UUID 还原成路径，
 *     解析不了时退回 UUID 而不是猜
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
import { projectsFrom } from '../lib/projects.mjs';
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

/** ZCode：会话库里一条 deleted、一条 active，任务索引各一行。 */
function seedZcode(home) {
  const main = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  const db = new DatabaseSync(main);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT)');
  db.exec('CREATE TABLE message (session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE part (session_id TEXT, data TEXT)');
  db.exec("INSERT INTO session VALUES ('sess_a', NULL, 'ZCode 的已删会话', '" + WS + "', 1, 2, 'interactive')");
  db.exec("INSERT INTO session VALUES ('sess_b', NULL, 'ZCode 的活跃会话', '" + WS + "', 1, 2, 'interactive')");
  db.exec("INSERT INTO message VALUES ('sess_a', '" + 'x'.repeat(2048) + "')");
  db.exec("INSERT INTO message VALUES ('sess_b', '" + 'y'.repeat(1024) + "')");
  db.close();

  const index = path.join(home, '.zcode', 'v2', 'tasks-index.sqlite');
  const ti = new DatabaseSync(index);
  ti.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT, workspace_path TEXT, workspace_key TEXT, archived INTEGER, deleted INTEGER, pinned INTEGER, created_at INTEGER, updated_at INTEGER, model TEXT, mode TEXT, task_status TEXT, title_overridden INTEGER)');
  ti.exec("INSERT INTO tasks VALUES ('sess_a', 'ZCode 的已删会话', '" + WS + "', '" + WS + "', 0, 1, 0, 1, 2, 'm', 'build', 'completed', 0)");
  ti.exec("INSERT INTO tasks VALUES ('sess_b', 'ZCode 的活跃会话', '" + WS + "', '" + WS + "', 0, 0, 0, 1, 2, 'm', 'build', 'completed', 0)");
  ti.close();
}

/* ── projectsFrom 纯函数 ──────────────────────────────────── */

test('同一绝对路径的会话归并成一个项目，并保留每个工具的一份', () => {
  const { projects, totals } = projectsFrom([{
    appId: 'zcode', appLabel: 'ZCode', tasks: [
      { id: '1', workspace: WS, workspaceKey: WS, bytes: 3000, state: 'active', reason: null },
      { id: '2', workspace: WS, workspaceKey: WS, bytes: 7000, state: 'deleted', reason: 'deleted' },
    ],
  }, {
    appId: 'codex', appLabel: 'Codex', tasks: [
      { id: '3', workspace: WS, workspaceKey: WS, bytes: 5000, state: 'archived', reason: 'archived' },
    ],
  }]);

  assert.equal(projects.length, 1, '同路径必须归并');
  const p = projects[0];
  assert.equal(p.sessions, 3);
  assert.equal(p.bytes, 15000);
  assert.deepEqual(p.apps.map((a) => a.appId), ['zcode', 'codex'], '两个工具各一行，按体积排');
  assert.equal(p.apps[0].sessions, 2);
  assert.equal(totals.projects, 1);
});

test('不能归并的会话单独成桶，不猜项目', () => {
  const { projects, unresolvable } = projectsFrom([{
    appId: 'cursor', appLabel: 'Cursor', tasks: [
      { id: '1', workspace: 'deadbeef-uuid', workspaceKey: 'deadbeef-uuid', workspaceOpaque: true, bytes: 100 },
      { id: '2', workspace: '', workspaceKey: '(不在会话头里)', bytes: 200 },
    ],
  }]);
  assert.equal(projects.length, 0);
  assert.equal(unresolvable.length, 2);
  // 桶的 key 带上形态前缀：UUID 与空工作区不会混成一个
  assert.deepEqual(unresolvable.map((u) => u.key).sort(), ['none', 'opaque:deadbeef-uuid']);
});

test('Claude 回落 slug 与 Cursor 的 UUID 也不会互相串', () => {
  const { projects, unresolvable } = projectsFrom([
    { appId: 'claude', appLabel: 'Claude Code', tasks: [{ id: '1', workspace: '', workspaceKey: '-Users-x-proj', bytes: 1 }] },
    { appId: 'cursor', appLabel: 'Cursor', tasks: [{ id: '2', workspace: 'uuid-1', workspaceKey: 'uuid-1', workspaceOpaque: true, bytes: 1 }] },
  ]);
  assert.equal(projects.length, 0);
  assert.equal(unresolvable.length, 2);
});

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

/* ── 接口层面 ─────────────────────────────────────────────── */

test('/api/summary 的形状：grand 与 scan 一致，reclaimable 不超过总量', async (t) => {
  const f = await fixture(t);
  seedZcode(f.home);

  const scan = await f.get('/api/scan');
  const summary = await f.get('/api/summary');
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body.grand, scan.body.grand, '两个接口的总量必须同源');

  assert.ok(summary.body.reclaimable <= summary.body.grand.bytes);
  assert.ok(summary.body.reclaimable >= 0);
  assert.ok(summary.body.reclaimableExtra >= 0, '默认没勾的可清量单列，不混进推荐');
  assert.ok(Array.isArray(summary.body.apps));

  // 每个 app 一行，installed 反映这台机器上有没有落盘
  for (const a of summary.body.apps) {
    assert.equal(typeof a.reclaimable, 'number', a.id);
    assert.equal(typeof a.installed, 'boolean', a.id);
  }
  const zcode = summary.body.apps.find((a) => a.id === 'zcode');
  assert.equal(zcode.installed, true);
  // Claude 的目录虽是空的，但 ~/.claude.json 这个单文件目标在 —— 装了
  const claude = summary.body.apps.find((a) => a.id === 'claude');
  assert.equal(claude.installed, true, '单文件目标存在就算装了这个工具');
});

test('/api/summary 的可回收口径就是 recommend 且未默认排除', async (t) => {
  const f = await fixture(t);
  seedZcode(f.home);

  const summary = await f.get('/api/summary');
  const scan = await f.get('/api/scan');
  let expect = 0;
  for (const a of scan.body.apps) {
    for (const c of a.catalog) {
      if (c.recommend && !c.recommendDefaultOff) expect += c.bytes;
    }
  }
  assert.equal(summary.body.reclaimable, expect, '与按 catalog 现算的对不上');
});

test('/api/projects 把两个工具同一 cwd 的会话归并，读不到的就是空', async (t) => {
  const f = await fixture(t);
  seedZcode(f.home);

  const d = await f.get('/api/projects');
  assert.equal(d.status, 200);
  // 夹具只给 ZCode 播了种子，Codex/Claude/Cursor 的目录都是空的
  assert.equal(d.body.totals.projects, 1, 'ZCode 那两条会话同一个工作区');
  assert.equal(d.body.projects[0].sessions, 2);
  assert.deepEqual(d.body.projects[0].apps.map((a) => a.appId), ['zcode']);
  assert.equal(d.body.projects[0].path, WS);
  // ZCode 的 deleted 会话必须带 reason —— 否则项目明细里没人知道它可清理
  assert.equal(d.body.projects[0].tasks.some((x) => x.reason === 'deleted'), true);
});

test('/api/projects 的条目带 app 归属，项目桶不泄漏到 unresolvable', async (t) => {
  const f = await fixture(t);
  seedZcode(f.home);
  const d = await f.get('/api/projects');
  for (const t2 of d.body.projects[0].tasks) {
    assert.ok(t2.appId && t2.appLabel, `${t2.id} 缺 app 归属`);
  }
  assert.equal(d.body.unresolvable.length, 0, '都有绝对路径，不该有无法归并的桶');
});

/* ── Cursor 反查的接口级验证 ──────────────────────────────── */

test('反查生效时 /api/projects 把 Cursor 会话归并进真实项目', async (t) => {
  const f = await fixture(t);
  const ide = f.cursorIde;
  const uuid = '11112222-3333-4444-5555-666677778888';

  // workspaceStorage/<uuid>/workspace.json：Cursor 的真实形态
  await fs.mkdir(path.join(ide, 'User', 'workspaceStorage', uuid), { recursive: true });
  await fs.writeFile(path.join(ide, 'User', 'workspaceStorage', uuid, 'workspace.json'),
    JSON.stringify({ folder: 'file://' + WS }));

  // state.vscdb：composerHeaders 是界面可见的会话头，composerId 是 36 位
  const composerId = 'cccc3333-4444-5555-6666-777788889999';
  const db = new DatabaseSync(path.join(ide, 'User', 'globalStorage', 'state.vscdb'));
  db.exec('CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, 1, 2, 0, 0, 3)').run(composerId, uuid);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`bubbleId:${composerId}:b1`, '对话正文'.repeat(64));
  db.close();

  seedZcode(f.home);   // ZCode 也占同一个工作区 —— 归并应当跨两个工具

  const d = await f.get('/api/projects');
  assert.equal(d.status, 200);
  const hit = d.body.projects.find((p) => p.path === WS);
  assert.ok(hit, `应出现项目 ${WS}，实际：${JSON.stringify(d.body.projects.map((p) => p.path))}`);
  const ids = hit.apps.map((a) => a.appId).sort();
  assert.deepEqual(ids, ['cursor', 'zcode'], 'Cursor 的会话应归并进同一项目');
});

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

  const d = await f.get('/api/projects');
  assert.equal(d.status, 200);
  assert.equal(d.body.projects.length, 0, '没有可归并的项目');
  assert.equal(d.body.unresolvable.length, 1);
  assert.match(d.body.unresolvable[0].label, /nowhere-uuid/);

  // 单 app 的会话视图也要把"这是不透明 UUID"标出来
  const tasks = await f.get('/api/tasks?app=cursor');
  assert.equal(tasks.body.tasks.length, 1, '只有一条会话，不该分出残骸');
  assert.equal(tasks.body.tasks[0].workspaceKey, 'nowhere-uuid');
  assert.equal(tasks.body.tasks[0].workspaceOpaque, true);
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
