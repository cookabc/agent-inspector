/**
 * 各 app 分类学的公共部分。
 *
 * 每个工具的安全语义（status/verdict/icon/locked）在 taxonomy.mjs 里定义一次，
 * app 模块用 shared(id, prose) 引用；这里只提供匹配器与判定用常数。
 */

/**
 * 把一张规则表编译成 classify(rel, size, ctx)。
 * ctx 里至少有 { app, t }（t = 扫描目标 key），多根目录的 app 用它区分两侧规则。
 */
export function makeClassify(rules) {
  return function classify(rel, size, ctx) {
    for (const rule of rules) {
      if (rule.test(rel, size, ctx)) return rule.id;
    }
    return 'unknown';
  };
}

/** 单条日志超过这个体积就认定为"失控放大"。 */
export const RUNAWAY_BYTES = 500 * 1024 * 1024;
