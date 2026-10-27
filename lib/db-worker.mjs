/**
 * 数据库操作的执行体。
 *
 * node:sqlite 是同步 API，而扫一遍会话库要读几百 MB、VACUUM 要重建整个库 ——
 * 放在主线程上会把事件循环卡住好几秒到几十秒，期间服务完全没响应。
 * 所以这些活儿全部丢进 worker 线程跑，主线程只负责收发消息。
 *
 * worker 收的是纯数据（appId + 目标路径），app 对象本身带函数，不能结构化克隆过来。
 */

import { parentPort, workerData } from 'node:worker_threads';
import { cleanupCopies } from './sqlite-open.mjs';
import { getApp } from './apps/index.mjs';
import { scanTasks, purgeTasks, analyzeCursorPurge } from './tasks.mjs';
import { scanOrphans, reimportOrphans } from './cursor-recover.mjs';
import { auditApp } from './audit-sessions.mjs';

const { op, appId, targets, args } = workerData;

/** Cursor 有两个根：cli = ~/.cursor，ide = App Support/Cursor。缺一个就退回第一个根。 */
function targetPath(list, key) {
  return (list.find((t) => t.key === key) || list[0]).path;
}

let message;
try {
  const app = getApp(appId);
  if (!app) throw new Error(`未知 app：${appId}`);

  let data;
  if (op === 'scan') data = await scanTasks(app, targets);
  else if (op === 'purge') data = await purgeTasks(app, targets, ...args);
  // 凭据外泄审计：只读，把一个 app 的全部会话正文过一遍 lib/audit.mjs 的判定
  else if (op === 'audit') data = await auditApp(app, targets);
  // Cursor 独占量分析：要把整库内容寻址池解一遍，必须待在 worker 里
  else if (op === 'cursor-purge-analyze') data = await analyzeCursorPurge(targets);
  else if (op === 'cursor-orphans') {
    data = await scanOrphans(targetPath(targets, 'cli'), targetPath(targets, 'ide'));
  } else if (op === 'cursor-recover') {
    data = await reimportOrphans(targetPath(targets, 'cli'), targetPath(targets, 'ide'), ...args);
  } else throw new Error(`未知操作：${op}`);

  message = { ok: true, data };
} catch (err) {
  // statusCode 要带回去，好让接口返回 4xx 而不是 500
  message = {
    ok: false,
    error: err?.message || String(err),
    statusCode: err?.statusCode || 500,
  };
} finally {
  try { await cleanupCopies(); } catch { /* 清理失败不掩盖操作本身的结果。 */ }
}
parentPort.postMessage(message);
