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

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-inspector-test-'));
  const root = path.join(temp, 'root');
  const home = path.join(temp, 'home');
  await fs.mkdir(root);
  await fs.mkdir(path.join(home, '.Trash'), { recursive: true });
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [
    '--experimental-sqlite', 'server.mjs', '--root', root,
    '--port', String(port), '--no-open',
  ], { cwd: project, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const write = async (rel, value = 'keep me') => {
    const file = path.join(root, rel);
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
  return { temp, root, home, base, write, post };
}

for (const route of ['/api/purge', '/api/trash']) {
  for (const rel of ['.', 'v2', 'cli', 'cli/db', './v2/credentials.json', 'v2//credentials.json', 'cli/config.json']) {
    test(`${route} refuses protected path ${rel}, including force`, async t => {
      const f = await fixture(t);
      const credentials = await f.write('v2/credentials.json');
      const config = await f.write('cli/config.json');
      const db = await f.write('cli/db/db.sqlite');
      const result = await f.post(route, { paths: [rel], confirm: '彻底删除', force: true });
      assert.ok([400, 403].includes(result.status), JSON.stringify(result));
      for (const file of [credentials, config, db]) assert.equal(await fs.readFile(file, 'utf8'), 'keep me');
    });
  }

  test(`${route} refuses paths through an ancestor symlink`, async t => {
    const f = await fixture(t);
    const outside = path.join(f.temp, 'outside');
    await fs.mkdir(outside);
    const canary = path.join(outside, 'canary.txt');
    await fs.writeFile(canary, 'outside');
    await fs.symlink(outside, path.join(f.root, 'linked'));
    const result = await f.post(route, { paths: ['linked/canary.txt'], confirm: '彻底删除' });
    assert.ok([400, 403].includes(result.status), JSON.stringify(result));
    assert.equal(await fs.readFile(canary, 'utf8'), 'outside');
  });
}

test('a mixed batch is rejected before deleting any safe file', async t => {
  const f = await fixture(t);
  const safe = await f.write('cli/log/old.log');
  await f.write('v2/settings.json');
  const result = await f.post('/api/purge', { paths: ['cli/log/old.log', 'v2'], confirm: '彻底删除' });
  assert.equal(result.status, 403);
  assert.equal(await fs.readFile(safe, 'utf8'), 'keep me');
});

test('safe nested cache directories can still be permanently deleted', async t => {
  const f = await fixture(t);
  await f.write('v2/cache/nested/item.json');
  const protectedFile = await f.write('v2/provider_config.json');
  const result = await f.post('/api/purge', { paths: ['./v2/cache/'], confirm: '彻底删除' });
  assert.equal(result.status, 200);
  assert.equal(result.body.deleted.length, 1);
  assert.equal(result.body.failed.length, 0);
  await assert.rejects(fs.access(path.join(f.root, 'v2/cache')));
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'keep me');
});

test('foreign origins and simple cross-site POSTs cannot delete files', async t => {
  const f = await fixture(t);
  const file = await f.write('cli/log/old.log');
  const body = { paths: ['cli/log/old.log'], confirm: '彻底删除' };
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

test('malformed bodies and non-string paths return client errors', async t => {
  const f = await fixture(t);
  for (const body of [null, [], { paths: [null], confirm: '彻底删除' }, { paths: [123], confirm: '彻底删除' }]) {
    assert.equal((await f.post('/api/purge', body)).status, 400);
  }
});

test('traversal, absolute paths, direct links and links within root are rejected', async t => {
  const f = await fixture(t);
  const file = await f.write('cli/log/old.log');
  await fs.symlink(path.join(f.root, 'cli'), path.join(f.root, 'alias'));
  for (const rel of ['../outside', file, 'alias', 'alias/log/old.log', 'cli/log/../log/old.log']) {
    assert.equal((await f.post('/api/purge', { paths: [rel], confirm: '彻底删除' })).status, 400);
    assert.equal(await fs.readFile(file, 'utf8'), 'keep me');
  }
});

test('safe files can still move to the isolated wastebasket', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const file = await f.write('cli/log/old.log');
  const result = await f.post('/api/trash', { paths: ['cli/log/old.log'] });
  assert.equal(result.status, 200);
  assert.equal(result.body.moved.length, 1);
  await assert.rejects(fs.access(file));
  assert.equal(await fs.readFile(path.join(f.home, '.Trash/old.log'), 'utf8'), 'keep me');
});

for (const route of ['/api/purge', '/api/trash']) {
  for (const rel of ['V2/CREDENTIALS.JSON', 'V2', 'CLI/DB']) {
    test(`${route} protects case aliases on case-insensitive filesystems: ${rel}`, async t => {
      const f = await fixture(t);
      const credentials = await f.write('v2/credentials.json');
      const database = await f.write('cli/db/db.sqlite');
      try { await fs.access(path.join(f.root, rel)); }
      catch { t.skip('The fixture filesystem is case-sensitive'); return; }
      const result = await f.post(route, { paths: [rel], confirm: '彻底删除', force: true });
      assert.equal(result.status, 403, JSON.stringify(result));
      for (const file of [credentials, database]) assert.equal(await fs.readFile(file, 'utf8'), 'keep me');
    });
  }
}
