/**
 * 写操作互斥：同一时刻只允许一个改动磁盘的操作在跑。
 *
 * 排队等待不如直接拒绝 —— 请求方拿到"上一次还没完"，重新扫描再操作，
 * 比把一个过期的删除请求悄悄排在后面更安全。
 */
export function createWriteGuard() {
  let busy = false;
  return async function withWriteGuard(work) {
    if (busy) throw Object.assign(new Error('已有清理或回灌正在执行，请等待完成后重新扫描再操作'), { statusCode: 409 });
    busy = true;
    try { return await work(); }
    finally { busy = false; }
  };
}
