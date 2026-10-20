/**
 * 历史会话这条线的路由器。
 *
 * 五个工具把"会话"存在完全不同的地方，所以这里只负责挑适配器，
 * 具体读写在各 lib/tasks-<app>.mjs 里：
 *
 *   zcode   cli/db/db.sqlite 的 session/message/part —— 按会话删行 + VACUUM
 *   codex   state_5.sqlite 的 threads + thread_history/logs 投影 —— 按线程删行 + VACUUM
 *   claude  projects 下的 .jsonl 文件本身就是正文 —— 只读列表，删除走文件那条线
 *   cursor  Application Support 里的 state.vscdb —— 只读构成分析，没有写路径
 *   gemini  antigravity/conversation_summaries.db —— 正文在云端，本机只有摘要索引，只读
 *
 * 统一的返回形状：{ tasks, totals, db, problems, scanMs } + 各 app 的附加字段。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as zcode from './tasks-zcode.mjs';
import * as codex from './tasks-codex.mjs';
import * as claude from './tasks-claude.mjs';
import * as cursor from './tasks-cursor.mjs';
import * as gemini from './tasks-gemini.mjs';
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
  else if (app.history === 'gemini-db') out = gemini.scanTasks(ctx.root);
  else throw new Error(`未知的历史会话类型：${app.history}`);
  await cleanupCopies();
  return { ...out, history: app.history, fileBased: app.history === 'claude-files', writable: isWritable(app) };
}

/**
 * 会话正文"按行删除"只对真有行可删的库开放。
 * 服务端在探测进程之前就问这一句 —— 这是静态能力，不该因为 Cursor 恰好在跑而变成 409。
 */
export function rowPurgeBlocked(app) {
  if (app.history === 'cursor-db') {
    return {
      status: 403,
      message: 'Cursor 的会话库由 IDE 独占写入，键值之间没有外键关系可依 —— 本工具对它只做只读分析。' +
        '要清会话请在 Cursor 界面里删除；整库回收要备份后重建 state.vscdb，那不该由这个工具代按。',
    };
  }
  if (app.history === 'gemini-db') {
    return {
      status: 403,
      message: 'Gemini/Antigravity 的会话正文在云端，本机的摘要库只是界面入口 —— 删掉它制造"半删"状态' +
        '（入口没了、正文还在），回收不了空间还破坏界面。要清会话请在 Antigravity 里删。',
    };
  }
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
  return zcode.purgeTasks(ctx.root, ids, opts);
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
