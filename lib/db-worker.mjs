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
import { getApp } from './apps/index.mjs';
import { scanTasks, purgeTasks, purgeOrphanIndex } from './tasks.mjs';
import * as codex from './tasks-codex.mjs';

const { op, appId, targets, args } = workerData;

try {
  const app = getApp(appId);
  if (!app) throw new Error(`未知 app：${appId}`);

  let data;
  if (op === 'scan') data = await scanTasks(app, targets);
  else if (op === 'purge') data = await purgeTasks(app, targets, ...args);
  else if (op === 'orphans') data = await purgeOrphanIndex(app, targets, ...args);
  else if (op === 'codex-preview') data = codex.previewPurge(targets[0].path, ...args);
  else throw new Error(`未知操作：${op}`);

  parentPort.postMessage({ ok: true, data });
} catch (err) {
  // statusCode 要带回去，好让接口返回 4xx 而不是 500
  parentPort.postMessage({
    ok: false,
    error: err?.message || String(err),
    statusCode: err?.statusCode || 500,
  });
}
