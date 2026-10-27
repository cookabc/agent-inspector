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
 * 这样测试可以同时对四个 app 的删除边界下手，而不会碰到真实数据。
 */
const LOC = {
  'zcode/root': '.zcode',
  'codex/root': '.codex',
  'claude/home': '.claude',
  'claude/dotfile': '',                       // 单文件目标：<home>/.claude.json
  'cursor/cli': '.cursor',
  'cursor/ide': 'Library/Application Support/Cursor',
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
};

/** 每个 app 里明确可删的安全内容，用来确认保护没有一刀切。 */
const SAFE = {
  'zcode/root': 'v2/cache/nested/item.json',
  'codex/root': 'cache/x/img.png',
  'claude/home': 'cache/x/blob.bin',
  'cursor/cli': 'projects/ws/keep.log',
  'cursor/ide': 'logs/window1/main.log',
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

  const child = spawn(process.execPath, ['--experimental-sqlite', 'server.mjs', '--port', String(port), '--backup-dir', path.join(temp, 'backups'), '--no-open'],
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
  // 裸客户端保留 Host / Fetch Metadata 头，用来测边界。
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
  assert.equal((await f.post('/api/purge', { app: 'nosuchtool', paths: ['cache'], confirm: '彻底删除' })).status, 400);
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

  // 软链接本身 vs 路径里夹着软链接，是两回事：前者换条路径也删不了，
  // 后者改选真实路径就行。报错必须分得开，否则人会对着同一条再试一遍。
  const itself = await f.post('/api/purge', { app: 'zcode', paths: ['alias'], confirm: '彻底删除' });
  assert.equal(itself.status, 400);
  assert.match(itself.body.error, /本身是符号链接/, itself.body.error);
  const through = await f.post('/api/purge', { app: 'zcode', paths: ['alias/log/old.log'], confirm: '彻底删除' });
  assert.equal(through.status, 400);
  assert.match(through.body.error, /路径里有符号链接/, through.body.error);

  // 扫描结果要把软链接标出来，界面才能不把它画成可勾条目
  const scan = await f.get('/api/scan');
  const alias = scan.body.apps.find((a) => a.app === 'zcode').files.find((x) => x.p === 'alias');
  assert.ok(alias, '软链接应该出现在文件清单里');
  assert.equal(alias.link, true, '软链接要带 link 标记');
  const plain = scan.body.apps.find((a) => a.app === 'zcode').files.find((x) => x.p === 'cli/log/old.log');
  assert.equal(plain.link, undefined, '普通文件不该带 link 标记');
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

/**
 * 按行清理的能力是静态的：不能因为目标恰好在跑就报 409"先退出应用"，
 * 那会让人以为退出了就能删 —— 真正没有写路径的只有 Claude Code（正文是文件）。
 *
 * Cursor 不在只读表里：它有写路径 —— 按会话删 + 连带删掉
 * 只被这些会话引用的 blob（lib/cursor-purge.mjs）。所以它落在这里的行为
 * 变成"确认串不对" —— 说明静态闸门已经放行，走到了后面的校验。
 */
for (const [app, status, why] of [
  ['claude', 400, '正文是文件'],
]) {
  test(`/api/tasks/purge refuses ${app} before even checking processes`, async t => {
    const f = await fixture(t);
    const result = await f.post('/api/tasks/purge', { app, ids: ['whatever'] });
    assert.equal(result.status, status, JSON.stringify(result));
    assert.doesNotMatch(result.body.error, /正在运行/, why);
  });
}

test('Cursor 不再被静态拒绝：缺确认串时报的是确认串，不是"只读"', async t => {
  const f = await fixture(t);
  /* 用 dryRun 绕开进程探测 —— 这条测试要证明的是"静态能力闸门已放行"，
     不该因为跑测试的这台机器恰好开着 Cursor 就变成 409。
     dryRun 是只读的，服务端本来就允许它在应用运行时跑。 */
  const result = await f.post('/api/tasks/purge', { app: 'cursor', ids: ['whatever'], dryRun: true });
  assert.notEqual(result.status, 403, JSON.stringify(result));
  assert.doesNotMatch(result.body.error || '', /只读|没有写路径/);
});

test('every history panel scans and reports its own shape', async t => {
  const f = await fixture(t);
  // 从注册表读，不手写 —— 手写的列表会让新加的工具悄悄逃过这轮检查
  const { APPS } = await import('../lib/apps/index.mjs');
  for (const app of APPS.map((a) => a.id)) {
    const { status, body } = await f.get('/api/tasks?app=' + app);
    assert.equal(status, 200, app);
    assert.ok(Array.isArray(body.tasks), app);
    assert.equal(typeof body.writable, 'boolean', app);
    assert.equal(typeof body.readOnly, 'boolean', app);
    assert.equal(typeof body.canRecover, 'boolean', app);
    assert.ok(body.app, app);
    // 返回信封恒定：哪怕库不存在，下面这些也必须在 —— 前端按字段名取值
    assert.ok(Array.isArray(body.totals.byState), `${app} 的 totals.byState 要是数组`);
    assert.equal(typeof body.totals.bytes, 'number', app);
    assert.ok(Array.isArray(body.db.dbs), `${app} 的 db.dbs 要是数组`);
    assert.equal(typeof body.db.total, 'number', `${app} 的 db.total 要是数字`);
    assert.ok(Array.isArray(body.problems), `${app} 的 problems 要是数组`);
    assert.equal(typeof body.scanMs, 'number', `${app} 的 scanMs 要是数字`);
  }
});

/**
 * 删除路径必须和扫描视图用同一套分类。
 *
 * 实测 bug（2026-10-22，代价是删掉了真实数据）：Codex 的分页续段在扫描视图里
 * 被 refineCategory 判成 transcriptSegment（locked，界面显示"请勿删除"），
 * 但删除者走的是 isProtected → app.classify，那里没有 refineCategory，
 * 于是同一路径在删除时被判成可清的 transcript。删整个 sessions/ 目录时，
 * 里面的续段被一起 rm 掉了。
 *
 * 判据：带 history_base 的 rollout 文件，无论单删还是作为目录的一部分删，
 * 都必须被 403 拦住。
 */
test('分页续段：单删与被目录连带删都必须被拒', async (t) => {
  const f = await fixture(t);
  // 在 fixture 的临时 HOME 里造一条续段
  const segId = '01a142d6-811a-7b22-b4f9-021a20e9fa91';
  const rel = `sessions/2026/10/21/rollout-2026-10-21T18-37-24-${segId}.jsonl`;
  const abs = path.join(f.home, '.codex', rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify({
    timestamp: '2026-10-21T10:37:24.157Z', ordinal: 4990, type: 'session_meta',
    payload: {
      session_id: segId, history_mode: 'paginated',
      history_base: { thread_id: segId, end_ordinal_exclusive: 4990, end_byte_offset: 66878152 },
    },
  }) + '\n');

  // ① 单删这个文件
  const one = await f.post('/api/purge', { app: 'codex', target: 'root', paths: [rel], confirm: '彻底删除' });
  assert.equal(one.status, 403, `续段不该被单删：${JSON.stringify(one.body)}`);
  assert.match(one.body.error, /受保护/);

  // ② 删它所在的目录（递归检查必须也拦住）
  const dir = path.dirname(rel);
  const many = await f.post('/api/purge', { app: 'codex', target: 'root', paths: [dir], confirm: '彻底删除' });
  assert.equal(many.status, 403, `续段不该被目录连带删：${JSON.stringify(many.body)}`);

  // 文件还在
  await fs.access(abs);

  // ③ 普通文件仍可删，且留下备份
  const okAbs = path.join(f.home, '.codex', 'cache', 'ok.txt');
  await fs.mkdir(path.dirname(okAbs), { recursive: true });
  await fs.writeFile(okAbs, 'hello');
  const ok = await f.post('/api/purge', { app: 'codex', target: 'root', paths: ['cache/ok.txt'], confirm: '彻底删除' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.deleted[0].backup, '彻底删除必须留下备份路径');
  const bpath = ok.body.deleted[0].backup;
  assert.ok(await fs.readFile(bpath, 'utf8'), '备份文件要有内容');
});

test('empty files can be purged and retain a verified empty backup', async t => {
  const f = await fixture(t);
  const abs = await f.write('codex', 'root', 'cache/empty', '');
  const r = await f.post('/api/purge', { app: 'codex', target: 'root', paths: ['cache/empty'], confirm: '彻底删除' });
  assert.equal(r.status, 200);
  assert.equal(r.body.failed.length, 0);
  assert.equal((await fs.stat(r.body.deleted[0].backup)).size, 0);
  await assert.rejects(fs.stat(abs), { code: 'ENOENT' });
});

test('repeated file purges preserve both versions of a path', async t => {
  const f = await fixture(t);
  const body = { app: 'codex', target: 'root', paths: ['cache/reused'], confirm: '彻底删除' };
  await f.write('codex', 'root', 'cache/reused', 'first');
  const first = await f.post('/api/purge', body);
  await f.write('codex', 'root', 'cache/reused', 'second');
  const second = await f.post('/api/purge', body);
  const a = first.body.deleted[0].backup, b = second.body.deleted[0].backup;
  assert.notEqual(a, b);
  assert.equal(await fs.readFile(a, 'utf8'), 'first');
  assert.equal(await fs.readFile(b, 'utf8'), 'second');
});

test('session endpoints reject malformed IDs and non-boolean dryRun', async t => {
  const f = await fixture(t);
  for (const route of ['/api/tasks/purge', '/api/tasks/cursor/recover']) {
    for (const ids of [null, {}, 'id', [1], [''], []]) {
      const r = await f.post(route, { app: 'codex', ids, dryRun: true });
      assert.equal(r.status, 400, `${route}: ${JSON.stringify(ids)}`);
    }
    const r = await f.post(route, { app: 'codex', ids: ['id'], dryRun: 'false' });
    assert.equal(r.status, 400);
  }
});

test('file writes invalidate session caches', async t => {
  const f = await fixture(t);
  await f.write('claude', 'home', 'projects/ws/one.jsonl', '{"type":"user","message":{"content":"fixture"}}\n');
  const before = await (await fetch(f.base + '/api/tasks?app=claude')).json();
  assert.equal(before.tasks.length, 1);
  const r = await f.post('/api/purge', { app: 'claude', target: 'home', paths: ['projects/ws/one.jsonl'], confirm: '彻底删除' });
  assert.equal(r.body.failed.length, 0);
  const after = await (await fetch(f.base + '/api/tasks?app=claude')).json();
  assert.equal(after.tasks.length, 0);
});

test('overlapping deletion paths are rejected before touching files', async t => {
  const f = await fixture(t);
  const file = await f.write('codex', 'root', 'cache/item', 'keep');
  const r = await f.post('/api/purge', { app: 'codex', paths: ['cache', 'cache/item'], confirm: '彻底删除' });
  assert.equal(r.status, 400);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});

test('oversized requests return a readable 413 response', async t => {
  const f = await fixture(t);
  const r = await f.post('/api/purge', { padding: 'x'.repeat(9 * 1024 * 1024) });
  assert.equal(r.status, 413);
  assert.match(r.body.error, /请求体过大/);
});

test('overlapping HTTP write requests cannot both mutate files', async t => {
  const f = await fixture(t);
  const paths = ['cache/first.bin', 'cache/second.bin'];
  for (const rel of paths) await f.write('codex', 'root', rel, Buffer.alloc(4 * 1024 * 1024, 7));
  const results = await Promise.all(paths.map(rel => f.post('/api/purge', {
    app: 'codex', paths: [rel], confirm: '彻底删除',
  })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const refused = results.findIndex(r => r.status === 409);
  assert.equal((await fs.stat(f.absOf('codex', 'root', paths[refused]))).size, 4 * 1024 * 1024);
});

/* ── 响应形状 ───────────────────────────────────────────────
   这一组是补上来的。

   背景：把 server 里四份手写缓存收进 lib/cache.mjs 时，我把
   `Promise.all(...)` 直接交给了缓存，漏掉外层 `{ apps: [...] }` 包装 ——
   /api/audit 于是返回裸数组，前端的 `d.apps` 是 undefined，安全审计
   一整屏空白。**335 条单元测试全绿**，因为测试只覆盖了 createCache
   本身，没有一条检查路由实际吐出的形状；最后是 UI 基线对比抓到的。

   教训：缓存/中间层这类"原样存取"的抽象，最容易在搬运时丢掉包装。
   所以每个有形状契约的接口都要有一条断言，锁住顶层字段。 */

test('GET /api/audit 返回 { apps: [...] }，不是裸数组', async t => {
  const f = await fixture(t);
  const r = await f.get('/api/audit');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.apps), `期望 body.apps 是数组，实际 ${typeof r.body.apps}`);
  // 每个 app 一份，且字段齐全 —— 前端按同一套字段渲染
  for (const a of r.body.apps) {
    for (const k of ['app', 'label', 'supported', 'totals', 'hits', 'problems']) {
      assert.ok(k in a, `audit 的 ${a.app} 缺字段 ${k}`);
    }
    assert.deepEqual(Object.keys(a.totals).sort(), ['high', 'info', 'medium']);
  }
});

test('GET /api/scan 返回 { apps, grand } 这套骨架', async t => {
  const f = await fixture(t);
  const r = await f.get('/api/scan');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.apps));
  assert.ok(r.body.grand && typeof r.body.grand.bytes === 'number');
  // 前端靠这三个开关决定摆不摆"移入废纸篓"/"在 Finder 中显示"
  assert.equal(typeof r.body.canTrash, 'boolean');
  assert.equal(typeof r.body.canReveal, 'boolean');
  // 确认串随扫描下发（lib/confirm-words.mjs 是唯一来源）
  assert.ok(r.body.confirm && r.body.confirm.FILES && r.body.confirm.SESSION && r.body.confirm.RECOVER);
});

test('GET /api/tasks 带上能力位与 app 元信息', async t => {
  const f = await fixture(t);
  const r = await f.get('/api/tasks?app=zcode');
  assert.equal(r.status, 200);
  for (const k of ['tasks', 'totals', 'appId', 'appLabel', 'history', 'fileBased', 'writable', 'readOnly', 'canRecover']) {
    assert.ok(k in r.body, `缺字段 ${k}`);
  }
  assert.equal(r.body.appId, 'zcode');
  assert.ok(Array.isArray(r.body.tasks));
});

test('GET /api/tasks/all 明确标只读', async t => {
  const f = await fixture(t);
  const r = await f.get('/api/tasks/all');
  assert.equal(r.status, 200);
  assert.equal(r.body.readOnly, true, '跨工具视图不许给删除入口');
  assert.equal(r.body.appId, 'all');
  assert.ok(Array.isArray(r.body.tasks));
  assert.ok(Array.isArray(r.body.tools));
});

/* ── 静态文件 ───────────────────────────────────────────────
   前缀检查的判据必须带上路径分隔符。URL 解析器已经把点段归一化掉、
   且 pathname 不做百分号解码，所以这里锁的是最终行为：任何写法都
   读不到 public/ 之外的源码文件。 */

function rawGet(base, route) {
  return new Promise((resolve, reject) => {
    http.get(base + route, response => {
      let raw = '';
      response.on('data', c => { raw += c; });
      response.on('end', () => resolve({ status: response.statusCode, text: raw, type: response.headers['content-type'] }));
      response.on('error', reject);
    }).on('error', reject);
  });
}

test('静态文件：页面资源正常返回，源码从任何路径写法都读不到', async t => {
  const f = await fixture(t);

  const index = await rawGet(f.base, '/');
  assert.equal(index.status, 200);
  assert.match(index.type, /text\/html/);
  assert.match(index.text, /<html/);

  const css = await rawGet(f.base, '/style.css');
  assert.equal(css.status, 200);
  assert.match(css.type, /text\/css/);

  // 百分号编码的点段不解码，按字面文件名 404 —— 不是把源码吐出去
  for (const route of ['/%2e%2e/server.mjs', '/..%2fserver.mjs', '/%2e%2e%2fserver.mjs']) {
    const r = await rawGet(f.base, route);
    assert.equal(r.status, 404, `${route} 应当 404`);
    assert.ok(!r.text.includes('createWriteGuard'), `${route} 不该读到源码内容`);
  }
  // 客户端会把点段归一化成 /server.mjs —— 同样 404（public/ 下没有它）
  const normalized = await rawGet(f.base, '/../../server.mjs');
  assert.equal(normalized.status, 404);
  assert.ok(!normalized.text.includes('createWriteGuard'));
});
