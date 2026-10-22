export function validateIds(ids) {
  if (Array.isArray(ids) && !ids.length) throw Object.assign(new Error('没有选中任何会话'), { statusCode: 400 });
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 ||
      ids.some(id => typeof id !== 'string' || !id.trim() || id.includes('\0') || id.length > 1024)) {
    throw Object.assign(new Error('ids 必须包含 1–500 个非空会话 id 字符串'), { statusCode: 400 });
  }
}

export function validateDryRun(value) {
  if (typeof value !== 'boolean') throw Object.assign(new Error('dryRun 必须是布尔值'), { statusCode: 400 });
}
