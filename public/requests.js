/** Read-only JSON boundary. Write operations keep their explicit receipt handling. */
export async function readJson(url, validate, fetcher = globalThis.fetch) {
  const response = await fetcher(url);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`本地服务未返回可读取的数据（HTTP ${response.status}），请确认服务仍在运行后重试。`);
  }
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
  if (!validate(data)) throw new Error("本地服务返回的数据不完整，请重新扫描或重启服务后重试。");
  return data;
}
export const scanResponse = (data) =>
  data &&
  Array.isArray(data.apps) &&
  Number.isFinite(data.durationMs) &&
  data.apps.every(
    (app) =>
      Array.isArray(app.files) &&
      Array.isArray(app.targets) &&
      Array.isArray(app.categories) &&
      Array.isArray(app.catalog) &&
      app.totals,
  );
export const allResponse = (data) =>
  data &&
  Array.isArray(data.tasks) &&
  Array.isArray(data.tools) &&
  Array.isArray(data.groups) &&
  Number.isFinite(data.total);
export const auditResponse = (data) => data && Array.isArray(data.apps);
export const taskResponse = (data) => data && typeof data.appId === "string" && Array.isArray(data.tasks);
