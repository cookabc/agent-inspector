/**
 * 带 HTTP 状态码的错误。
 *
 * 同一个六行函数原先在 tasks.mjs、tasks-codex.mjs、tasks-zcode.mjs 里
 * 各抄了一份（server.mjs 里那份叫 httpError，只因历史原因多了个 o）。
 * 抄三份的问题不在于占行数，而在于**改的时候只改一处**：这些错误对象沿
 * worker 的消息边界回到 server（见 lib/db-worker.mjs 把 statusCode 带回去），
 * 谁要是哪天在其中一份上加了字段（比如 retryable），另两份就悄悄落后。
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
