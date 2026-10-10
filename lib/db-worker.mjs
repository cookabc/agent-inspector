/**
 * 数据库操作的执行体。
 *
 * node:sqlite 是同步 API，而扫一遍会话库要读几百 MB、VACUUM 要重建整个库 ——
 * 放在主线程上会把事件循环卡住好几秒到几十秒，期间服务完全没响应。
 * 所以这些活儿全部丢进 worker 线程跑，主线程只负责收发消息。
 */

import { parentPort, workerData } from 'node:worker_threads';
import { scanTasks, purgeTasks, previewPurge, purgeOrphanIndex } from './tasks.mjs';

const { op, args } = workerData;

try {
  let data;
  if (op === 'scan') data = scanTasks(...args);
  else if (op === 'purge') data = await purgeTasks(...args);
  else if (op === 'preview') data = previewPurge(...args);
  else if (op === 'orphans') data = await purgeOrphanIndex(...args);
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
