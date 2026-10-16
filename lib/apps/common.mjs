/**
 * 各 app 分类学的公共部分。
 *
 * 每个 app 自己带一张规则表和一份分类字典（lib/apps/<id>.mjs），
 * 这里只提供它们共用的东西：判定等级、状态色、规则编译、路径反解。
 *
 * 判定等级（verdict）：
 *   junk   —— 系统垃圾，建议直接清掉
 *   safe   —— 可安全清理，删了不影响任何可用数据
 *   review —— 谨慎，删之前请自己确认（通常是含隐私或有价值的内容）
 *   never  —— 不要删（配置、数据库、凭据、应用本体）
 *
 * 状态色（status）沿用 dataviz 的固定状态色板，永远配合图标 + 文字标签出现，
 * 不靠颜色单独表意：
 *   good #0ca30c · warning #fab219 · serious #ec835a · critical #d03b3b
 *
 * 每个分类必须回答四个问题：what（这是什么）/ why（为什么在这儿）/
 * outcome（删了会怎样）/ verdict（归哪一档）。outcome 要求写具体后果，不许写"可能有影响"。
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

/**
 * Cursor 把会话正文存在 ~/Library/Application Support 里，不在 ~/.cursor。
 * 一个 app 因此可以有多个扫描目标；这里统一算"家目录相对路径"给人看。
 */
export function shortenHome(abs) {
  const home = process.env.HOME || '';
  return home && abs.startsWith(home) ? '~' + abs.slice(home.length) : abs;
}
