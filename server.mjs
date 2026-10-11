#!/usr/bin/env node
/**
 * zcode-inspector —— 本地服务
 *
 *   node server.mjs [--port 4173] [--root ~/.zcode] [--no-open]
 *
 * 只做四件事：
 *   GET  /api/scan     扫描并返回索引（gzip）
 *   POST /api/trash    移入废纸篓（可恢复）
 *   POST /api/purge    彻底删除（需显式确认串）
 *   POST /api/reveal   在 Finder 中显示
 *
 * 所有写操作都先把路径解析到 root 之内，越界一律拒绝。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';

/* 自己的模块用动态 import：本地这几个都依赖内置的 node:sqlite，
   而它是 Node 22.5 才有的。更早的版本上静态 import 会在任何提示之前直接崩掉，
   用户只看到一句 "Cannot find module 'node:sqlite'"。这里接住它，说人话。 */
let scan, CATEGORIES, classify, appRunning;
try {
  [{ scan }, { CATEGORIES, classify }, { appRunning }] = await Promise.all([
    import('./lib/scan.mjs'),
    import('./lib/rules.mjs'),
    import('./lib/tasks.mjs'),
  ]);
} catch (err) {
  const msg = err?.message || String(err);
  console.error(`\n  zcode-inspector 启动失败：${msg}\n`);
  if (/node:sqlite/.test(msg)) {
    console.error(`  这个工具靠 Node 内置的 node:sqlite 读会话库，它从 Node 22.5 起才有`);
    console.error(`  （22.5–23.3 还要加 --experimental-sqlite，23.4 起不用）。`);
    console.error(`  当前是 Node ${process.versions.node}。换个版本再试，比如：nvm use 24\n`);
  }
  process.exit(1);
}

/** 把一次数据库操作丢进 worker 线程，主线程不被同步 SQLite 卡住。 */
function runDb(op, args = []) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lib/db-worker.mjs', import.meta.url), {
      workerData: { op, args },
    });
    worker.once('message', (m) => {
      worker.terminate();
      if (m.ok) return resolve(m.data);
      const err = new Error(m.error);
      err.statusCode = m.statusCode;
      reject(err);
    });
    worker.once('error', reject);
  });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(argOf('--port', process.env.PORT || 4173));
const NO_OPEN = argv.includes('--no-open');
const ROOT = path.resolve(
  argOf('--root', path.join(os.homedir(), '.zcode')).replace(/^~/, os.homedir())
);
/* 移入废纸篓和在 Finder 中显示都是 macOS 的做派。别的地方能扫能看能删，
   但那两个动作没意义 —— 与其让人点了报一句 ENOENT，不如启动时就说清楚。 */
const MACOS = process.platform === 'darwin';
const TRASH = path.join(os.homedir(), '.Trash');
const BACKUP_DIR = path.join(HERE, 'backups');

const MAX_BODY = 8 * 1024 * 1024;

/* ── 缓存 ─────────────────────────────────────────────────── */
let cache = null;          // { index, at }
let indexInflight = null;  // 并发请求搭同一趟扫描，别让 N 个请求各走一遍目录树
const CACHE_MS = 15_000;

let taskCache = null;      // 扫一遍会话库要读几百 MB，缓存久一点
let taskInflight = null;   // 同一时刻只允许一次扫描，重复请求搭同一趟车
const TASK_CACHE_MS = 60_000;

function getIndex(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.index);
  if (indexInflight) return indexInflight;

  indexInflight = scan(ROOT)
    .then((index) => { cache = { index, at: Date.now() }; return index; })
    .finally(() => { indexInflight = null; });
  return indexInflight;
}

function getTasks(force = false) {
  if (!force && taskCache && Date.now() - taskCache.at < TASK_CACHE_MS) return taskCache.index;
  if (taskInflight) return taskInflight;

  taskInflight = runDb('scan', [ROOT])
    .then((index) => { taskCache = { index, at: Date.now() }; return index; })
    .finally(() => { taskInflight = null; });
  return taskInflight;
}

/* ── 安全 ─────────────────────────────────────────────────── */

/** 检查每一级路径，不允许通过目录软链接或 .. 绕过保护。 */
function safeResolve(rel) {
  if (typeof rel !== 'string' || !rel.length) throw httpError(400, '路径为空');
  if (path.isAbsolute(rel)) throw httpError(400, `只接受相对路径：${rel}`);
  if (rel.includes('\0') || rel.split(path.sep).includes('..')) {
    throw httpError(400, `拒绝：路径包含非法部分：${rel}`);
  }
  const normalized = path.normalize(rel).replace(/\/$/, '');
  if (normalized === '.') throw httpError(400, '拒绝：不能操作扫描根目录');
  const root = fs.realpathSync.native(ROOT);
  const abs = path.resolve(root, normalized);
  if (!abs.startsWith(root + path.sep)) {
    throw httpError(400, `拒绝：路径越出 ${ROOT}`);
  }
  let current = root;
  try {
    for (const part of normalized.split(path.sep)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw httpError(400, `拒绝：${rel} 包含符号链接`);
      }
    }
    if (!fs.realpathSync.native(abs).startsWith(root + path.sep)) {
      throw httpError(400, `拒绝：路径越出 ${ROOT}`);
    }
  } catch (err) {
    if (err.statusCode) throw err;
    throw httpError(400, `无法访问 ${rel}`);
  }
  return fs.realpathSync.native(abs);
}

/** 对整个批次先检查，再开始执行，避免拒绝后已经删掉部分文件。 */
async function validateDeletionPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) throw httpError(400, '没有选中任何路径');
  for (const rel of paths) await deletablePath(rel);
}

async function deletablePath(rel) {
  const abs = safeResolve(rel);
  // native realpath 还原 macOS 不区分大小写文件系统上的实际名称。
  const normalized = path.relative(fs.realpathSync.native(ROOT), abs);
  async function inspect(file, relative) {
    const st = await fsp.lstat(file);
    if (isProtected(relative, st.isDirectory())) {
      throw httpError(403, `受保护内容不能删除：${relative}`);
    }
    // rm/rename 不跟随目录内的链接；检查也不进入其目标。
    if (st.isDirectory()) {
      for (const name of await fsp.readdir(file)) await inspect(path.join(file, name), `${relative}/${name}`);
    }
  }
  await inspect(abs, normalized);
  return abs;
}

function httpError(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}

/* ── 清理动作 ─────────────────────────────────────────────── */

function uniqueTrashTarget(abs) {
  const base = path.basename(abs);
  let target = path.join(TRASH, base);
  let i = 1;
  while (fs.existsSync(target)) target = path.join(TRASH, `${base} ${i++}`);
  return target;
}

async function moveToTrash(rel) {
  // 非 macOS 上 ~/.Trash 不存在，rename 会报一句看不懂的 ENOENT。直说。
  if (!MACOS) throw httpError(400, '这台机器不是 macOS，"移入废纸篓"用不了，请改用"彻底删除"');
  const abs = await deletablePath(rel);
  const st = await fsp.lstat(abs);
  const target = uniqueTrashTarget(abs);
  await fsp.rename(abs, target);
  return { path: rel, bytes: st.isDirectory() ? -1 : st.size, to: target };
}

async function purge(rel) {
  const abs = await deletablePath(rel);
  const st = await fsp.lstat(abs);
  const bytes = st.isDirectory() ? -1 : st.size;
  await fsp.rm(abs, { recursive: true, force: true });
  return { path: rel, bytes };
}

/** 与界面共用分类规则；数据库目录本身也必须保护。 */
function isProtected(rel, directory = false) {
  if (rel === 'cli/db' || rel.startsWith('cli/db/')) return true;
  // v2 是容器，由其实际后代决定；v2/cache 等目录按带斜杠的路径分类。
  if (directory && rel === 'v2') return false;
  return Boolean(CATEGORIES[classify(directory ? `${rel}/` : rel, 0)]?.locked);
}

/* ── HTTP ─────────────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJSON(req, res, status, obj) {
  const raw = Buffer.from(JSON.stringify(obj));
  const accept = String(req.headers['accept-encoding'] || '');
  if (raw.length > 1024 && accept.includes('gzip')) {
    const gz = zlib.gzipSync(raw);
    return send(res, status, gz, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': gz.length,
    });
  }
  return send(res, status, raw, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': raw.length,
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
        resolve(body);
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  try {
    const buf = await fsp.readFile(abs);
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host;
    const allowedHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    if (!allowedHosts.includes(host)) throw httpError(403, '拒绝：不是本地服务地址');
    if ((req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      throw httpError(403, '拒绝：跨站请求');
    }
    const url = new URL(req.url, `http://${host}`);
    const p = url.pathname;
    if (p.startsWith('/api/') && req.method === 'POST' && req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw httpError(415, '请求必须使用 application/json');
    }
    if (p === '/api/scan') {
      const index = await getIndex(url.searchParams.get('refresh') === '1');
      // 前端照这两个开关决定要不要摆出"移入废纸篓"和"在 Finder 中显示" ——
      // 不是 macOS 就没有落点，摆了也只是让人白按。
      return sendJSON(req, res, 200, { ...index, trash: TRASH, canTrash: MACOS, canReveal: MACOS });
    }

    if (p === '/api/tasks') {
      const data = await getTasks(url.searchParams.get('refresh') === '1');
      const app = await appRunning();
      return sendJSON(req, res, 200, { ...data, app, backupDir: BACKUP_DIR });
    }

    if (p === '/api/tasks/orphans' && req.method === 'POST') {
      const { dryRun = false } = await readBody(req);
      const app = await appRunning();
      if (app.running && !dryRun) {
        const who = app.hits.map((h) => `${h.name}×${h.pids}`).join('、');
        throw httpError(409, `ZCode 正在运行（${who}）。请先完全退出 ZCode 再清理。`);
      }
      const result = await runDb('orphans', [ROOT, { backupDir: BACKUP_DIR, dryRun }]);
      taskCache = null;
      return sendJSON(req, res, 200, result);
    }

    if (p === '/api/tasks/purge' && req.method === 'POST') {
      const { ids = [], dryRun = false, confirm } = await readBody(req);

      // 最要紧的一条：绝不能对正在被写入的数据库动手
      const app = await appRunning();
      if (app.running && !dryRun) {
        const who = app.hits.map((h) => `${h.name}×${h.pids}`).join('、');
        throw httpError(409,
          `ZCode 正在运行（${who}）。请先完全退出 ZCode 再清理 —— ` +
          `对一个正在被写入的数据库动手会损坏它。`);
      }
      if (!dryRun && confirm !== '清理') throw httpError(400, '确认串不正确');

      // 备份 + 删行 + VACUUM 全程在 worker 里跑，主线程始终保持响应
      const result = await runDb('purge', [ROOT, ids, { backupDir: BACKUP_DIR, dryRun }]);
      taskCache = null;
      return sendJSON(req, res, 200, result);
    }

    if (p === '/api/trash' && req.method === 'POST') {
      const { paths = [] } = await readBody(req);
      await validateDeletionPaths(paths);

      const done = [];
      const failed = [];
      for (const rel of paths) {
        try { done.push(await moveToTrash(rel)); }
        catch (err) { failed.push({ path: rel, error: err.message }); }
      }
      cache = null;
      return sendJSON(req, res, 200, { moved: done, failed, trash: TRASH });
    }

    if (p === '/api/purge' && req.method === 'POST') {
      const { paths = [], confirm } = await readBody(req);
      if (confirm !== '彻底删除') throw httpError(400, '确认串不正确');
      await validateDeletionPaths(paths);

      const done = [];
      const failed = [];
      for (const rel of paths) {
        try { done.push(await purge(rel)); }
        catch (err) { failed.push({ path: rel, error: err.message }); }
      }
      cache = null;
      return sendJSON(req, res, 200, { deleted: done, failed });
    }

    if (p === '/api/reveal' && req.method === 'POST') {
      const { path: rel } = await readBody(req);
      const abs = safeResolve(rel);
      execFile('open', ['-R', abs], () => {});
      return sendJSON(req, res, 200, { ok: true, path: abs });
    }

    if (p.startsWith('/api/')) return sendJSON(req, res, 404, { error: '未知接口' });

    if (req.method !== 'GET') return send(res, 405, 'method not allowed');
    return serveStatic(req, res, p);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('[error]', err);
    return sendJSON(req, res, status, { error: err.message || String(err) });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  zcode-inspector\n`);
  console.log(`  目录  ${ROOT}`);
  console.log(`  地址  ${url}\n`);
  console.log(`  首次打开会扫描一次目录（只读 stat，不读文件内容）。`);
  if (MACOS) {
    console.log(`  清理默认移入废纸篓，可随时恢复。按 Ctrl+C 退出。\n`);
  } else {
    console.log(`  注意：这台机器不是 macOS，"移入废纸篓"和"在 Finder 中显示"用不了`);
    console.log(`        （它们靠 ${TRASH} 和 open -R）。清理请只用"彻底删除"。\n`);
  }

  if (!NO_OPEN) execFile(MACOS ? 'open' : 'xdg-open', [url], () => {});
});

process.on('SIGINT', () => {
  console.log('\n  已退出。\n');
  process.exit(0);
});
