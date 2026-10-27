/**
 * 请求参数校验。上限 500 同时是"一次操作的批量边界"——
 * 三处调用（HTTP 入口、ZCode、Codex 适配器）共用这一个上限，
 * 别处再写一遍 500 就会在改上限时落后。
 */
const MAX_IDS = 500;

export function validateIds(ids) {
  if (Array.isArray(ids) && !ids.length) throw Object.assign(new Error('没有选中任何会话'), { statusCode: 400 });
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS ||
      ids.some(id => typeof id !== 'string' || !id.trim() || id.includes('\0') || id.length > 1024)) {
    throw Object.assign(new Error(`ids 必须包含 1–${MAX_IDS} 个非空会话 id 字符串`), { statusCode: 400 });
  }
  return ids;
}

export function validateDryRun(value) {
  if (typeof value !== 'boolean') throw Object.assign(new Error('dryRun 必须是布尔值'), { statusCode: 400 });
}
