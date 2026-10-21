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

/**
 * 跨 app 同形的规则：写法一致、语义一致，一家家抄一遍迟早漂移。
 * 实测就漂过 —— `backups/` 目录在 Claude 有专门规则，Codex 与 ZCode 只靠
 * 后缀匹配，于是 `~/.codex/backups/000_wx-mp/*.zip` 这样的东西全落进了 unknown。
 *
 * 每条都写成 (p) => boolean，由各 app 在自己的 RULES 里按顺序展开。
 */
export const SHARED_RULES = {
  /** .bak / .backup-<时间戳> 这类"改配置之前留一份"的副本文件。 */
  configBackupFile: (p) => /\.(bak|backups?)([.-][^/]*)?$/i.test(p),

  /**
   * 顶层备份目录（backups/ 或 backup/）**及其全部后代**。
   *
   * 之所以要覆盖整棵子树：里面的东西常常不命中任何规则（项目 zip、校验清单、
   * 整表转储），只标目录本身的话它们会全部掉进 unknown。
   *
   * 归 dataBackup 而不是 configBackup —— 里面是完整数据副本，不是几 KB 的配置。
   * 也刻意排在 database 之类的前面：备份目录里的 .sqlite 是**副本**，
   * 锁成"请勿删除"是假锁（真正不能删的那个库不在 backups/ 里）。
   *
   * 四家必须把它放在同一个位置（紧跟在 configBackupFile 之后），
   * 否则同一个路径会因为规则顺序不同而得到不同答案 —— 实测就是这么漂的：
   *   backups/2026/state_5.sqlite → claude:configBackup codex:database
   *                                 zcode:dataBackup cursor:dataBackup
   */
  dataBackupDir: (p) => /^backups?\//.test(p),
};
