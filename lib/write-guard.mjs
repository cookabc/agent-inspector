/** Reject overlapping mutations instead of silently queuing a stale deletion request. */
export function createWriteGuard() {
  let busy = false;
  return async function withWriteGuard(work) {
    if (busy) throw Object.assign(new Error('已有清理或回灌正在执行，请等待完成后重新扫描再操作'), { statusCode: 409 });
    busy = true;
    try { return await work(); }
    finally { busy = false; }
  };
}
