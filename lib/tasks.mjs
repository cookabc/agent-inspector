/**
 * 历史会话这条线的路由器。
 *
 * 四个工具把"会话"存在完全不同的地方，所以这里只负责挑适配器，
 * 具体读写在各 lib/tasks-<app>.mjs 里：
 *
 *   zcode   cli/db/db.sqlite 的 session/message/part —— 按会话删行 + VACUUM
 *   codex   state_5.sqlite 的 threads + thread_history/logs 投影 —— 按线程删行 + VACUUM
 *   claude  projects 下的 .jsonl 文件本身就是正文 —— 只读列表，删除走文件那条线
 *   cursor  Application Support 里的 state.vscdb —— 键值库，按会话删 + 连带
 *           独占的内容寻址 blob（见 lib/cursor-purge.mjs）
 *
 * 统一的返回形状：{ tasks, totals, db, problems, scanMs } + 能力位
 * （history / fileBased / writable / readOnly / canRecover）+ 各 app 的附加字段。
 * 会话行与统计的形状见 lib/tasks-shape.mjs —— 四家共用一份。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as zcode from './tasks-zcode.mjs';
import * as codex from './tasks-codex.mjs';
import * as claude from './tasks-claude.mjs';
import * as cursor from './tasks-cursor.mjs';
import { cleanupCopies } from './sqlite-open.mjs';

const pexec = promisify(execFile);

function httpErr(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}

/** 把 plan.targets 展成 { root, byKey } —— 各适配器要哪个根自己挑。 */
function ctxOf(targets) {
  const byKey = Object.fromEntries(targets.map((t) => [t.key, t.path]));
  return { root: targets[0].path, byKey };
}

/**
 * 会话库能不能按行清理。cursor 的 app 模块显式声明 writable:false，
 * 其余默认可写 —— 判定只在这一处，不再散到各调用点比较 history 类型。
 */
export function isWritable(app) {
  return app.writable !== false;
}

export async function scanTasks(app, targets) {
  const ctx = ctxOf(targets);
  let out;
  if (app.history === 'zcode-db') out = zcode.scanTasks(ctx.root);
  else if (app.history === 'codex-db') out = codex.scanTasks(ctx.root);
  else if (app.history === 'claude-files') out = await claude.scanTasks(ctx.root);
  else if (app.history === 'cursor-db') {
    // 工作区 UUID → 文件夹路径：按项目横切要它才能把 Cursor 的会话归并进去。
    // 读不到就是一个空表，scanTasks 自然退回"保留 UUID + 标记"。
    const folders = app.workspaceFolders ? await app.workspaceFolders(ctx.byKey.ide || ctx.root) : null;
    out = cursor.scanTasks(ctx.byKey.ide || ctx.root, folders);
  }
  else throw new Error(`未知的历史会话类型：${app.history}`);
  await cleanupCopies();
  // 能力位在这里单源出口：前端的显隐判断只读它们，不再按 app 名硬编码。
  const writable = isWritable(app);
  return {
    ...out,
    history: app.history,
    fileBased: app.history === 'claude-files',
    writable,
    readOnly: !writable,
    // 只有 Cursor 有"孤儿会话回灌"这条受控写路径
    canRecover: app.canRecover === true,
  };
}

/**
 * 会话正文"按行删除"只对真有行可删的库开放。
 * 服务端在探测进程之前就问这一句 —— 这是静态能力，不该因为 Cursor 恰好在跑而变成 409。
 */
/**
 * 这个 app 能不能按会话删。
 *
 * Cursor 曾经在这里被拒。现在可以了 —— 但走的是**另一条路径**（见
 * purgeTasks 里的 cursor 分支）：它没有外键，靠的是从活会话出发的可达性
 * 分析，连带删掉只被这些会话引用的内容寻址 blob。所以这里不再拦它，
 * 真正拦人的是 purgeTasks 里那条路径自己的闸门。
 *
 * 仍然拦的是 Claude Code：它的正文就是 .jsonl 文件，没有"行"可删。
 */
export function rowPurgeBlocked(app) {
  if (app.history === 'claude-files') {
    return { status: 400, message: 'Claude Code 的会话正文就是 .jsonl 文件本身，请按文件清理（移入废纸篓 / 彻底删除）' };
  }
  return null;
}

export async function purgeTasks(app, targets, ids, opts = {}) {
  const ctx = ctxOf(targets);
  const blocked = rowPurgeBlocked(app);
  if (blocked) throw httpErr(blocked.status, blocked.message);
  if (app.history === 'codex-db') return codex.purgeTasks(ctx.root, ids, opts);
  if (app.history === 'cursor-db') {
    const { purgeSessions } = await import('./cursor-purge.mjs');
    return purgeSessions(ctx.byKey.ide || ctx.root, ids, opts);
  }
  return zcode.purgeTasks(ctx.root, ids, opts);
}

/**
 * Cursor 的会话清理走的是可达性分析，比别家贵得多（要把整库的
 * 内容寻址池解一遍）。所以单独开一个"只算独占量"的只读入口，
 * 供任务面板在列表渲染时取 —— 它不参与 scanTasks 的常规路径。
 */
export async function analyzeCursorPurge(targets) {
  const ctx = ctxOf(targets);
  const { analyzePurge } = await import('./cursor-purge.mjs');
  return analyzePurge(ctx.byKey.ide || ctx.root);
}

/**
 * 这个 app 的进程在不在跑。往正在被写入的数据库里 DELETE 会损坏它，
 * 所以按行清理之前必须先问这一句。
 */
export async function appRunning(app) {
  const hits = [];
  for (const [name, args] of app.processes || []) {
    try {
      const { stdout } = await pexec('pgrep', args);
      const pids = stdout.trim().split('\n').filter(Boolean);
      if (pids.length) hits.push({ name, pids: pids.length });
    } catch { /* pgrep 无匹配时退出码为 1 */ }
  }
  return { running: hits.length > 0, hits, label: app.processLabel || app.label };
}

/* ── 跨工具：把所有 app 的会话汇到一张表 ───────────────────── */

/**
 * 四个工具的会话合成一张表，按"最近用过"排序。
 *
 * 为什么要有这个：用户真实的问题是"我刚才在哪个工具里干活"，而各工具视图
 * 只能回答"这个工具里有什么"。catchup 的 `--list` 也是这么做的，说明这个
 * 需求是真的。
 *
 * **只读。** 不同 app 的删除路径完全不同（ZCode/Codex 走事务+VACUUM、
 * Claude 走文件、Cursor 走可达性分析），把两家的会话混进一次删除请求里，
 * 服务端那四道闸根本没法统一 —— 所以这里只给"找"和"看"，不给"删"。
 * 要删就点进对应工具。
 *
 * @param {{app:object, targets:object[]}[]} plans
 * @param {(app:object, targets:object[]) => Promise<object>} scan 单个 app 的扫描（由调用方注入，便于复用缓存）
 * @returns {Promise<{tools:Array, total:number, groups:Array, scanMs:number}>}
 */
export async function aggregateSessions(plans, scan) {
  const t0 = Date.now();
  const tools = [];
  const all = [];

  for (const { app, targets } of plans) {
    if (!targets.some((t) => t.exists)) continue;
    let data = null;
    try { data = await scan(app, targets); } catch (err) {
      tools.push({ app: app.id, label: app.label, count: 0, error: err.message || String(err) });
      continue;
    }
    const rows = (data?.tasks || []).map((t) => ({
      // 跨工具的行必须自带归属：同一个 uuid 在两个工具里是两段不同的对话
      app: app.id,
      appLabel: app.label,
      ...t,
    }));
    tools.push({
      app: app.id,
      label: app.label,
      count: rows.length,
      bytes: rows.reduce((s, t) => s + t.bytes, 0),
      deletable: rows.filter((t) => t.reason != null).length,
    });
    all.push(...rows);
  }

  // 最近用过的排前面；同一时刻的按体积降序（大的一般是主线索）
  all.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.bytes - a.bytes));

  /* 按目录分组。工作区为空的（Cursor 有部分会话还原不出路径）单独一组，
     组名用显式的说明，不要留空字符串让界面画出一个没有标题的分组。 */
  const byWs = new Map();
  for (const t of all) {
    const key = t.workspace || '';
    let g = byWs.get(key);
    if (!g) byWs.set(key, g = { workspace: key, tasks: [], bytes: 0, apps: new Set() });
    g.tasks.push(t);
    g.bytes += t.bytes;
    g.apps.add(t.app);
  }
  const groups = [...byWs.values()]
    .map((g) => ({ ...g, apps: [...g.apps] }))
    .sort((a, b) => (b.tasks[0]?.updatedAt || 0) - (a.tasks[0]?.updatedAt || 0));

  return {
    tools,
    total: all.length,
    bytes: all.reduce((s, t) => s + t.bytes, 0),
    tasks: all,
    groups,
    scanMs: Date.now() - t0,
  };
}
