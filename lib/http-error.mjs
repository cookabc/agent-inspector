/**
 * 带 HTTP 状态码的错误。全项目只有这一份 —— 它沿 worker 的消息边界
 * 回到 server（db-worker.mjs 会把 statusCode 带回去），散抄的话某一份
 * 加了字段，其余的就悄悄落后。
 *
 * 约定：错误的 `statusCode` 属性就是 HTTP 状态码；没有它的错误一律当 500。
 */

/**
 * @param {number} status HTTP 状态码
 * @param {string} message 给人看的原因（会原样出现在接口响应里）
 * @returns {Error & {statusCode: number}}
 */
export function httpErr(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}
