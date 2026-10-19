import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));

/**
 * 每个 (app, target) 对应的落盘位置 —— 全部在临时 HOME 之下，
 * 这样测试可以同时对五个 app 的删除边界下手，而不会碰到真实数据。
 */
const LOC = {
  'zcode/root': '.zcode',
  'codex/root': '.codex',
  'claude/home': '.claude',
  'claude/dotfile': '',                       // 单文件目标：<home>/.claude.json
  'cursor/cli': '.cursor',
  'cursor/ide': 'Library/Application Support/Cursor',
  'gemini/root': '.gemini',
};

// 每个 app 里必须"删不掉"的东西：库、凭据、配置
const PROTECTED = {
  'zcode/root': ['cli/db', 'cli/db/db.sqlite', 'cli/usage.json', 'cli/config.json',
                 'v2/credentials.json', 'v2/tasks-index.sqlite', 'v2/config.json'],
  'codex/root': ['auth.json', 'config.toml', 'state_5.sqlite', 'logs_2.sqlite',
                 'session_index.jsonl', 'rules/default.toml'],
  'claude/home': ['.credentials.json', 'settings.json', 'sessions.sqlite'],
  'claude/dotfile': ['.claude.json'],
  'cursor/cli': ['mcp.json', 'cli-config.json'],
  'cursor/ide': ['User/globalStorage/state.vscdb', 'User/globalStorage/conversation-search.db',
                 'User/settings.json', 'ai-tracking/events.sqlite'],
  'gemini/root': ['antigravity/conversation_summaries.db', 'jetski-standalone-oauth-token',
                  'config/config.json'],
};

/** 每个 app 里明确可删的安全内容，用来确认保护没有一刀切。 */
const SAFE = {
  'zcode/root': 'v2/cache/nested/item.json',
  'codex/root': 'cache/x/img.png',
  'claude/home': 'cache/x/blob.bin',
  'cursor/cli': 'projects/ws/keep.log',
  'cursor/ide': 'logs/window1/main.log',
  'gemini/root': 'antigravity/cache/x/marketplace.json',
};

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-test-'));
  const home = path.join(temp, 'home');
  await fs.mkdir(path.join(home, '.Trash'), { recursive: true });
  for (const rel of Object.values(LOC)) {
    if (rel) await fs.mkdir(path.join(home, rel), { recursive: true });
  }
  await fs.writeFile(path.join(home, '.claude.json'), 'keep me');

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
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await fs.rm(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(output || 'Server startup timed out')); }, 10000);
    const check = () => { if (output.includes(base)) { cleanup(); resolve(); } };
    const stopped = () => { cleanup(); reject(new Error(output)); };
    function cleanup() { clearTimeout(timer); child.stdout.off('data', check); child.off('exit', stopped); }
    child.stdout.on('data', check);
    child.once('exit', stopped);
    check();
  });

  const dirOf = (app, target) => {
    const key = `${app}/${target || 'root'}`;
    const rel = LOC[key];
    if (rel === undefined) throw new Error(`测试没登记这个目标：${key}`);
    return rel ? path.join(home, rel) : home;   // 单文件目标的"父目录"就是 HOME
  };
  const absOf = (app, target, rel) =>
    (LOC[`${app}/${target || 'root'}`] === '' && rel === '.claude.json')
      ? path.join(home, '.claude.json')
      : path.join(dirOf(app, target), rel);
  const write = async (app, target, rel, value = 'keep me') => {
    const file = absOf(app, target, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
    return file;
  };
  // A raw client preserves Host / Fetch Metadata headers for boundary tests.
  const post = (route, body, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request(base + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
  const get = (route) => new Promise((resolve, reject) => {
    http.get(base + route, { headers: { Accept: 'application/json' } }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
  return { temp, home, base, dirOf, absOf, write, post, get };
}

const allProtected = [];
for (const [key, list] of Object.entries(PROTECTED)) {
  const [app, target] = key.split('/');
  for (const rel of list) allProtected.push({ app, target, rel });
}

for (const route of ['/api/purge', '/api/trash']) {
  for (const { app, target, rel } of allProtected) {
    test(`${route} refuses ${app}:${target}/${rel}, including force`, async t => {
      const f = await fixture(t);
      const file = await f.write(app, target, rel);
      const result = await f.post(route, { app, target, paths: [rel], confirm: '彻底删除', force: true });
      assert.ok([400, 403].includes(result.status), JSON.stringify(result));
      assert.equal(await fs.readFile(file, 'utf8'), 'keep me');
    });
  }

  // 父目录也删不掉：保护要一直查到后代
  test(`${route} refuses a parent directory that contains protected content`, async t => {
    const f = await fixture(t);
    const sibling = await f.write('zcode', 'root', 'v2/settings.json');
    const credentials = await f.write('zcode', 'root', 'v2/credentials.json');
    const result = await f.post(route, { app: 'zcode', paths: ['v2'], confirm: '彻底删除', force: true });
    assert.equal(result.status, 403, JSON.stringify(result));
    assert.equal(await fs.readFile(credentials, 'utf8'), 'keep me');
    assert.equal(await fs.readFile(sibling, 'utf8'), 'keep me');   // 整批拒绝，不留半成品
  });

  for (const spec of [{ app: 'zcode', target: 'root' }, { app: 'codex', target: 'root' }]) {
    test(`${route} refuses paths through an ancestor symlink (${spec.app})`, async t => {
      const f = await fixture(t);
      const outside = path.join(f.temp, 'outside-' + spec.app);
      await fs.mkdir(outside);
      const canary = path.join(outside, 'canary.txt');
      await fs.writeFile(canary, 'outside');
      await fs.symlink(outside, path.join(f.dirOf(spec.app, spec.target), 'linked'));
      const result = await f.post(route, {
        app: spec.app, target: spec.target, paths: ['linked/canary.txt'], confirm: '彻底删除',
      });
      assert.ok([400, 403].includes(result.status), JSON.stringify(result));
      assert.equal(await fs.readFile(canary, 'utf8'), 'outside');
    });
  }
}

/** 扫描根对每个 app 都不是可操作对象。 */
for (const { app, target } of [{ app: 'zcode', target: 'root' }, { app: 'codex', target: 'root' },
                               { app: 'claude', target: 'home' }, { app: 'cursor', target: 'ide' }]) {
  test(`${app}:${target} refuses the scan root itself`, async t => {
    const f = await fixture(t);
    const result = await f.post('/api/purge', { app, target, paths: ['.'], confirm: '彻底删除' });
    assert.equal(result.status, 400);
    await fs.access(f.dirOf(app, target));            // 根目录原样还在
  });
}

test('a mixed batch is rejected before deleting any safe file', async t => {
  const f = await fixture(t);
  const safe = await f.write('zcode', 'root', 'cli/log/old.log');
  await f.write('zcode', 'root', 'v2/credentials.json');
  const result = await f.post('/api/purge', {
    app: 'zcode', paths: ['cli/log/old.log', 'v2'], confirm: '彻底删除',
  });
  assert.equal(result.status, 403);
  assert.equal(await fs.readFile(safe, 'utf8'), 'keep me');
});

test('safe nested cache directories can still be permanently deleted', async t => {
  const f = await fixture(t);
  await f.write('zcode', 'root', 'v2/cache/nested/item.json');
  const protectedFile = await f.write('zcode', 'root', 'v2/provider_config.json');
  const result = await f.post('/api/purge', { app: 'zcode', paths: ['./v2/cache/'], confirm: '彻底删除' });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.deleted.length, 1);
  assert.equal(result.body.failed.length, 0);
  await assert.rejects(fs.access(path.join(f.dirOf('zcode', 'root'), 'v2/cache')));
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'keep me');
});

for (const [key, rel] of Object.entries(SAFE)) {
  const [app, target] = key.split('/');
  test(`${app}:${target} still deletes ordinary content`, async t => {
    const f = await fixture(t);
    const file = await f.write(app, target, rel);
    const result = await f.post('/api/purge', { app, target, paths: [rel.split('/')[0]], confirm: '彻底删除' });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.failed.length, 0);
    await assert.rejects(fs.access(file));
  });
}

test('foreign origins and simple cross-site POSTs cannot delete files', async t => {
  const f = await fixture(t);
  const file = await f.write('zcode', 'root', 'cli/log/old.log');
  const body = { app: 'zcode', paths: ['cli/log/old.log'], confirm: '彻底删除' };
  for (const headers of [
    { Origin: 'https://example.org' }, { Origin: 'null' },
    { 'Content-Type': 'text/plain' }, { 'Sec-Fetch-Site': 'cross-site' },
    { Host: 'attacker.example' },
  ]) {
    const result = await f.post('/api/purge', body, headers);
    assert.ok([403, 415].includes(result.status), JSON.stringify(result));
    assert.equal(await fs.readFile(file, 'utf8'), 'keep me');
  }
  const result = await f.post('/api/purge', body, { Origin: f.base });
  assert.equal(result.status, 200);
  assert.equal(result.body.deleted.length, 1);
});

test('unknown app and target are client errors', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/purge', { app: 'gemini', paths: ['cache'], confirm: '彻底删除' })).status, 400);
  assert.equal((await f.post('/api/purge', { paths: ['cache'], confirm: '彻底删除' })).status, 400);
  assert.equal((await f.post('/api/purge', { app: 'zcode', target: 'nope', paths: ['v2/cache'], confirm: '彻底删除' })).status, 400);
  // cursor 的 ide 目标不在 zcode 的分类表里，反过来也一样
  assert.equal((await f.post('/api/purge', { app: 'zcode', target: 'ide', paths: ['v2/cache'], confirm: '彻底删除' })).status, 400);
});

test('a single-file target accepts only itself', async t => {
  const f = await fixture(t);
  const dot = path.join(f.home, '.claude.json');
  for (const rel of ['nested.json', '.claude.json/backup', 'x/y']) {
    const result = await f.post('/api/purge', { app: 'claude', target: 'dotfile', paths: [rel], confirm: '彻底删除' });
    assert.equal(result.status, 400, JSON.stringify(result));
  }
  assert.equal(await fs.readFile(dot, 'utf8'), 'keep me');
});

test('missing scan targets refuse writes but still list', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.home, '.codex'), { recursive: true, force: true });
  const result = await f.post('/api/purge', { app: 'codex', paths: ['cache'], confirm: '彻底删除' });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /不存在/);
});

test('malformed bodies and non-string paths return client errors', async t => {
  const f = await fixture(t);
  for (const body of [null, [], { paths: [null], confirm: '彻底删除' }, { app: 'zcode', paths: [123], confirm: '彻底删除' },
                      { app: 'zcode', paths: [], confirm: '彻底删除' }]) {
    assert.equal((await f.post('/api/purge', body)).status, 400, JSON.stringify(body));
  }
});

test('traversal, absolute paths, direct links and links within root are rejected', async t => {
  const f = await fixture(t);
  const root = f.dirOf('zcode', 'root');
  const file = await f.write('zcode', 'root', 'cli/log/old.log');
  await fs.symlink(path.join(root, 'cli'), path.join(root, 'alias'));
  for (const rel of ['../outside', file, 'alias', 'alias/log/old.log', 'cli/log/../log/old.log']) {
    const result = await f.post('/api/purge', { app: 'zcode', paths: [rel], confirm: '彻底删除' });
    assert.equal(result.status, 400, rel);
    assert.equal(await fs.readFile(file, 'utf8'), 'keep me');
  }
});

test('safe files can still move to the isolated wastebasket', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const file = await f.write('zcode', 'root', 'cli/log/old.log');
  const result = await f.post('/api/trash', { app: 'zcode', paths: ['cli/log/old.log'] });
  assert.equal(result.status, 200);
  assert.equal(result.body.moved.length, 1);
  await assert.rejects(fs.access(file));
  assert.equal(await fs.readFile(path.join(f.home, '.Trash/old.log'), 'utf8'), 'keep me');
});

for (const route of ['/api/purge', '/api/trash']) {
  // 大小写别名：macOS 默认文件系统不区分大小写，正则是区分的。
  // realpath 还原真实名称之后，规则必须仍然命中，否则 "V2/CREDENTIALS.JSON" 能绕开保护。
  const aliases = [
    { app: 'zcode', target: 'root', rel: 'V2/CREDENTIALS.JSON' },
    { app: 'codex', target: 'root', rel: 'AUTH.JSON' },
    { app: 'claude', target: 'home', rel: '.CREDENTIALS.JSON' },
    { app: 'claude', target: 'dotfile', rel: '.CLAUDE.JSON' },
    { app: 'cursor', target: 'ide', rel: 'User/globalStorage/STATE.VSCDB' },
  ];
  for (const { app, target, rel } of aliases) {
    test(`${route} protects case aliases on case-insensitive filesystems: ${app}/${rel}`, async t => {
      const f = await fixture(t);
      const canonical = {
        'zcode/V2/CREDENTIALS.JSON': 'v2/credentials.json',
        'codex/AUTH.JSON': 'auth.json',
        'claude/.CREDENTIALS.JSON': '.credentials.json',
        'claude/.CLAUDE.JSON': '.claude.json',
        'cursor/User/globalStorage/STATE.VSCDB': 'User/globalStorage/state.vscdb',
      }[`${app}/${rel}`];
      const file = await f.write(app, target, canonical);
      try { await fs.access(f.absOf(app, target, rel)); }
      catch { t.skip('The fixture filesystem is case-sensitive'); return; }
      const result = await f.post(route, { app, target, paths: [rel], confirm: '彻底删除', force: true });
      assert.equal(result.status, 403, JSON.stringify(result));
      assert.equal(await fs.readFile(file, 'utf8'), 'keep me');
    });
  }
}

test('/api/apps lists all five apps with their targets', async t => {
  const f = await fixture(t);
  const { body } = await f.get('/api/apps');
  assert.deepEqual(body.apps.map(a => a.id), ['zcode', 'codex', 'claude', 'cursor', 'gemini']);
  for (const a of body.apps) assert.ok(a.targets.length, a.id);
  assert.equal(body.apps.find(a => a.id === 'cursor').writable, false, 'Cursor 只读');
  assert.equal(body.apps.find(a => a.id === 'claude').writable, true);
  assert.equal(body.apps.find(a => a.id === 'gemini').writable, false, 'Gemini 摘要库只读');
});

/**
 * 按行清理的能力是静态的：不能因为 Cursor 恰好在跑就报 409"先退出应用"，
 * 那会让人以为退出了就能删 —— 实际上这个工具对 Cursor 根本没有写路径。
 */
for (const [app, status, why] of [
  ['cursor', 403, '只读'],
  ['claude', 400, '正文是文件'],
]) {
  test(`/api/tasks/purge refuses ${app} before even checking processes`, async t => {
    const f = await fixture(t);
    const result = await f.post('/api/tasks/purge', { app, ids: ['whatever'] });
    assert.equal(result.status, status, JSON.stringify(result));
    assert.doesNotMatch(result.body.error, /正在运行/, why);
  });
}

test('/api/tasks/orphans is a ZCode-only entry', async t => {
  const f = await fixture(t);
  for (const app of ['codex', 'claude', 'cursor']) {
    const result = await f.post('/api/tasks/orphans', { app, dryRun: true });
    assert.equal(result.status, 400, app + ' ' + JSON.stringify(result));
  }
});

test('every history panel scans and reports its own shape', async t => {
  const f = await fixture(t);
  for (const app of ['zcode', 'codex', 'claude', 'cursor', 'gemini']) {
    const { status, body } = await f.get('/api/tasks?app=' + app);
    assert.equal(status, 200, app);
    assert.ok(Array.isArray(body.tasks), app);
    assert.equal(typeof body.writable, 'boolean', app);
    assert.ok(body.app, app);
  }
});