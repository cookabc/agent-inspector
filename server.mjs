#!/usr/bin/env node
/**
 * Agent Inspector —— 本地服务
 *
 *   node server.mjs [--port 4173] [--app zcode] [--root ~/.zcode] [--no-open]
 *
 * 只做四件事：
 *   GET  /api/scan     扫描全部 app 并返回索引（gzip）
 *   POST /api/trash    移入废纸篓（可恢复）
 *   POST /api/purge    彻底删除（需显式确认串）
 *   POST /api/reveal   在 Finder 中显示
 *
 * 路径都是 {app, target, path} 三元组：app 决定用哪张分类表，target 决定落在哪个根目录。
 * 所有写操作都先把路径解析到该根目录之内，越界一律拒绝。
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
let APPS, getApp, planApps, scanApps, appRunning, rowPurgeBlocked, CURSOR_CONFIRM;
try {
  [{ APPS, getApp, planApps }, { scanApps }, { appRunning, rowPurgeBlocked },
    { CONFIRM_WORD: CURSOR_CONFIRM }] = await Promise.all([
    import('./lib/apps/index.mjs'),
    import('./lib/scan.mjs'),
    import('./lib/tasks.mjs'),
    import('./lib/cursor-recover.mjs'),
  ]);
} catch (err) {
  const msg = err?.message || String(err);
  console.error(`\n  Agent Inspector 启动失败：${msg}\n`);
  if (/node:sqlite/.test(msg)) {
    console.error(`  这个工具靠 Node 内置的 node:sqlite 读会话库，它从 Node 22.5 起才有`);
    console.error(`  （22.5–23.3 还要加 --experimental-sqlite，23.4 起不用）。`);
    console.error(`  当前是 Node ${process.versions.node}。换个版本再试，比如：nvm use 24\n`);
  }
  process.exit(1);
}

/** 把一次数据库操作丢进 worker 线程，主线程不被同步 SQLite 卡住。 */
function runDb(op, appId, targets, args = []) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lib/db-worker.mjs', import.meta.url), {
      workerData: { op, appId, targets, args },
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
const ROOT = argOf('--root', null);
/* --root 只换个目录给你看，分类表还是那个 app 的 —— 单独指定 --root 时，
   沿用旧行为把它当作 ZCode 的目标，不然扫出来是一堆"未归类"。 */
const ONLY_APP = argOf('--app', ROOT ? 'zcode' : null);
if (ONLY_APP && !getApp(ONLY_APP)) {
  console.error(`\n  未知 app：${ONLY_APP}\n  可选：${APPS.map((a) => a.id).join('、')}\n`);
  process.exit(1);
}

/* 移入废纸篓和在 Finder 中显示都是 macOS 的做派。别的地方能扫能看能删，
   但那两个动作没意义 —— 与其让人点了报一句 ENOENT，不如启动时就说清楚。 */
const MACOS = process.platform === 'darwin';
const TRASH = path.join(os.homedir(), '.Trash');
const BACKUP_DIR = path.join(HERE, 'backups');

const MAX_BODY = 8 * 1024 * 1024;

let plans;
try {
  plans = planApps(ONLY_APP, ROOT);
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
/* ── 缓存 ─────────────────────────────────────────────────── */
let cache = null;          // { index, at }
let indexInflight = null;  // 并发请求搭同一趟扫描，别让 N 个请求各走一遍目录树
const CACHE_MS = 15_000;

const taskCache = new Map();      // appId -> { index, at }。扫一遍会话库要读几百 MB，缓存久一点
const taskInflight = new Map();   // 同一时刻每个 app 只允许一次扫描，重复请求搭同一趟车
const TASK_CACHE_MS = 60_000;

function getIndex(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.index);
  if (indexInflight) return indexInflight;

  indexInflight = scanApps(plans)
    .then((index) => { cache = { index, at: Date.now() }; return index; })
    .finally(() => { indexInflight = null; });
  return indexInflight;
}

function getTasks(appId, force = false) {
  const hit = taskCache.get(appId);
  if (!force && hit && Date.now() - hit.at < TASK_CACHE_MS) return Promise.resolve(hit.index);
  if (taskInflight.get(appId)) return taskInflight.get(appId);

  const plan = plans.find((p) => p.app.id === appId);
  if (!plan) return Promise.reject(httpError(404, `未知 app：${appId}`));

  const run = runDb('scan', appId, plan.targets.map(stripTarget))
    .then((index) => { taskCache.set(appId, { index, at: Date.now() }); return index; })
    .finally(() => { taskInflight.delete(appId); });
  taskInflight.set(appId, run);
  return run;
}

/** worker 只要纯数据，别把函数和 app 对象塞过去。 */
function stripTarget(t) {
  return { key: t.key, kind: t.kind, path: t.path, short: t.short, label: t.label, exists: t.exists };
}

/* ── 全域聚合 ───────────────────────────────────────────────── */

/* ── 安全 ─────────────────────────────────────────────────── */

function planFor(appId) {
  const plan = plans.find((p) => p.app.id === appId);
  if (!plan) throw httpError(400, `未知 app：${appId || '(空)'}`);
  return plan;
}

function targetOf(plan, key) {
  const t = plan.targets.find((x) => x.key === (key || plan.targets[0].key));
  if (!t) throw httpError(400, `${plan.app.id} 没有名为 ${key} 的扫描目标`);
  if (!t.exists) throw httpError(400, `${t.short} 在这台机器上不存在`);
  return t;
}

/** 单文件目标的"根"是它所在的目录；解析和相对路径计算必须用同一个根。 */
function targetRoot(target) {
  return fs.realpathSync.native(target.kind === 'file' ? path.dirname(target.path) : target.path);
}

/** 检查每一级路径，不允许通过目录软链接或 .. 绕过保护。 */
function safeResolve(appId, targetKey, rel) {
  const plan = planFor(appId);
  const target = targetOf(plan, targetKey);
  if (typeof rel !== 'string' || !rel.length) throw httpError(400, '路径为空');
  if (path.isAbsolute(rel)) throw httpError(400, `只接受相对路径：${rel}`);
  if (rel.includes('\0') || rel.split(path.sep).includes('..')) {
    throw httpError(400, `拒绝：路径包含非法部分：${rel}`);
  }
  const normalized = path.normalize(rel).replace(/\/$/, '');
  if (normalized === '.') throw httpError(400, '拒绝：不能操作扫描根目录');
  let root;
  try {
    root = targetRoot(target);
  } catch {
    throw httpError(400, `${target.short} 在这台机器上不存在`);
  }
  let current = root;
  let real;
  try {
    for (const part of normalized.split(path.sep)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) {
        // 说清楚是"这一段是软链接"还是"你点的就是一条软链接" ——
        // 前者换一条路径就能删，后者这条路径永远删不了。混成一句话会害人反复重试。
        const itself = path.resolve(root, normalized) === current;
        throw httpError(400, itself
          ? `拒绝：${rel} 本身是符号链接 —— 这个工具不跟随、也不删除软链接，请在 Finder 里手动处理`
          : `拒绝：${rel} 的路径里有符号链接（${path.relative(root, current)}），请改选它指向的真实路径`);
      }
    }
    // 返回 realpath 而不是拼出来的 abs：macOS 默认文件系统不区分大小写，
    // 调用方要靠这个真实名字去匹配分类规则 —— "V2/Credentials.json" 能骗过大小写敏感的正则。
    real = fs.realpathSync.native(path.resolve(root, normalized));
    if (!real.startsWith(root + path.sep)) {
      throw httpError(400, `拒绝：路径越出 ${target.path}`);
    }
  } catch (err) {
    if (err.statusCode) throw err;
    throw httpError(400, `无法访问 ${rel}`);
  }
  // 单文件目标只允许指向那个文件本身
  if (target.kind === 'file' && real !== fs.realpathSync.native(target.path)) {
    throw httpError(400, `拒绝：${target.short} 是单个文件，里面没有 ${normalized}`);
  }
  return real;
}

/** 对整个批次先检查，再开始执行，避免拒绝后已经删掉部分文件。 */
async function validateDeletionPaths({ app, target, paths }) {
  if (typeof app !== 'string') throw httpError(400, '缺少 app');
  if (!Array.isArray(paths) || !paths.length) throw httpError(400, '没有选中任何路径');
  for (const rel of paths) await deletablePath(app, target, rel);
}

async function deletablePath(appId, targetKey, rel) {
  const plan = planFor(appId);
  const abs = safeResolve(appId, targetKey, rel);
  const target = targetOf(plan, targetKey);
  // realpath 还原 macOS 不区分大小写文件系统上的实际名称。
  const normalized = path.relative(targetRoot(target), abs);
  async function inspect(file, relative) {
    const st = await fsp.lstat(file);
    if (isProtected(plan, target, relative, st.isDirectory())) {
      throw httpError(403, `受保护内容不能删除：${target.short}/${relative}`);
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

async function moveToTrash(rel, appId, targetKey) {
  // 非 macOS 上 ~/.Trash 不存在，rename 会报一句看不懂的 ENOENT。直说。
  if (!MACOS) throw httpError(400, '这台机器不是 macOS，"移入废纸篓"用不了，请改用"彻底删除"');
  const abs = await deletablePath(appId, targetKey, rel);
  const st = await fsp.lstat(abs);
  const to = uniqueTrashTarget(abs);
  await fsp.rename(abs, to);
  return { path: rel, app: appId, target: targetKey, bytes: st.isDirectory() ? -1 : st.size, to };
}

async function purge(rel, appId, targetKey) {
  const abs = await deletablePath(appId, targetKey, rel);
  const st = await fsp.lstat(abs);
  const bytes = st.isDirectory() ? -1 : st.size;
  await fsp.rm(abs, { recursive: true, force: true });
  return { path: rel, app: appId, target: targetKey, bytes };
}

/**
 * 与界面共用分类规则；每个 app 另外声明两件事，都写在它自己的模块里：
 *   protectedDirs  必须整目录保护的库目录（如 ZCode 的 cli/db）
 *   containerDirs  纯容器目录，自己不保护，由后代决定（如 ZCode 的 v2/）
 * Cursor 的 state.vscdb 已经在规则里归到 database（locked），不需要特判。
 */
function isProtected(plan, target, rel, directory = false) {
  const { app } = plan;
  for (const dir of app.protectedDirs || []) {
    if (rel === dir || rel.startsWith(`${dir}/`)) return true;
  }
  if (directory && (app.containerDirs || []).includes(rel)) return false;
  return Boolean(app.CATEGORIES[app.classify(
    directory ? `${rel}/` : rel, 0, { app: app.id, t: target.key }
  )]?.locked);
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
      const appId = url.searchParams.get('app') || plans[0].app.id;
      const plan = planFor(appId);
      const data = await getTasks(appId, url.searchParams.get('refresh') === '1');
      const app = await appRunning(plan.app);
      return sendJSON(req, res, 200, { ...data, app, appId, appLabel: plan.app.label, backupDir: BACKUP_DIR });
    }

    /* Cursor 的两条专用入口：只针对"界面里看不到、.jsonl 还在"的孤儿会话。
       列表只读；回灌是受控写入 —— 退出应用、确认串、整库备份、事务、自检，
       全在这一条路径上，不影响其它工具，也不覆盖任何已有会话。 */
    if (p === '/api/tasks/cursor/orphans' && req.method === 'GET') {
      const plan = planFor('cursor');
      const data = await runDb('cursor-orphans', 'cursor', plan.targets.map(stripTarget));
      const app = await appRunning(plan.app);
      return sendJSON(req, res, 200, { ...data, app, appId: 'cursor', appLabel: plan.app.label, backupDir: BACKUP_DIR, confirmWord: CURSOR_CONFIRM });
    }

    if (p === '/api/tasks/cursor/recover' && req.method === 'POST') {
      const { ids = [], dryRun = false, confirm } = await readBody(req);
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
        throw httpError(400, 'ids 必须是会话 id 的字符串数组');
      }
      const plan = planFor('cursor');
      // 空跑是只读的，应用开着也安全；真正写入前必须退出，避免和 IDE 抢写。
      if (!dryRun && confirm !== CURSOR_CONFIRM) throw httpError(400, `确认串不正确（应为「${CURSOR_CONFIRM}」）`);
      const running = await appRunning(plan.app);
      if (running.running && !dryRun) throw appMustQuit(running);
      const result = await runDb('cursor-recover', 'cursor', plan.targets.map(stripTarget),
        [ids, { backupDir: BACKUP_DIR, dryRun }]);
      if (!dryRun) taskCache.delete('cursor');
      return sendJSON(req, res, 200, result);
    }

    if (p === '/api/tasks/purge' && req.method === 'POST') {
      const { app: appId, ids = [], dryRun = false, confirm } = await readBody(req);
      const plan = planFor(String(appId || ''));

      // 静态能力先判：这个 app 有没有"行"可删，跟它在不在跑无关
      const blocked = rowPurgeBlocked(plan.app);
      if (blocked) throw httpError(blocked.status, blocked.message);

      // 最要紧的一条：绝不能对正在被写入的数据库动手
      const running = await appRunning(plan.app);
      if (running.running && !dryRun) throw appMustQuit(running);
      if (!dryRun && confirm !== '清理') throw httpError(400, '确认串不正确');

      // 备份 + 删行 + VACUUM 全程在 worker 里跑，主线程始终保持响应
      const result = await runDb('purge', plan.app.id, plan.targets.map(stripTarget), [ids, { backupDir: BACKUP_DIR, dryRun }]);
      taskCache.delete(appId);
      return sendJSON(req, res, 200, result);
    }

    if (p === '/api/trash' && req.method === 'POST') {
      const { app, target, paths = [] } = await readBody(req);
      await validateDeletionPaths({ app, target, paths });

      const done = [];
      const failed = [];
      for (const rel of paths) {
        try { done.push(await moveToTrash(rel, app, target)); }
        catch (err) { failed.push({ path: rel, error: err.message }); }
      }
      cache = null;
      return sendJSON(req, res, 200, { moved: done, failed, trash: TRASH });
    }

    if (p === '/api/purge' && req.method === 'POST') {
      const { app, target, paths = [], confirm } = await readBody(req);
      if (confirm !== '彻底删除') throw httpError(400, '确认串不正确');
      await validateDeletionPaths({ app, target, paths });

      const done = [];
      const failed = [];
      for (const rel of paths) {
        try { done.push(await purge(rel, app, target)); }
        catch (err) { failed.push({ path: rel, error: err.message }); }
      }
      cache = null;
      return sendJSON(req, res, 200, { deleted: done, failed });
    }

    if (p === '/api/reveal' && req.method === 'POST') {
      const { app, target, path: rel } = await readBody(req);
      const abs = safeResolve(String(app || ''), target, rel);
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

function appMustQuit(running) {
  const who = running.hits.map((h) => `${h.name}×${h.pids}`).join('、');
  return httpError(409,
    `${running.label} 正在运行（${who}）。请先完全退出它再清理 —— ` +
    `对一个正在被写入的数据库动手会损坏它。`);
}

server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  Agent Inspector\n`);
  for (const { app, targets } of plans) {
    const found = targets.filter((t) => t.exists);
    const line = found.length ? found.map((t) => t.short).join(' + ') : '（这台机器上没有）';
    console.log(`  ${app.label.padEnd(12)} ${line}`);
  }
  console.log(`\n  地址  ${url}\n`);
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
