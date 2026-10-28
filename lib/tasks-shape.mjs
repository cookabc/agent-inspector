/**
 * 各工具的会话行与统计口径 —— 一份，不是每家一份。
 *
 * 各家把"会话"存在完全不同的地方（SQLite 表、.jsonl 文件、键值库），
 * 取数方式该差就让它差；但**行长什么样、统计怎么算**必须一致，
 * 否则界面上会出现"某一家的筛选钮点了没反应"这类只有那一家才有的毛病。
 *
 * 这个模块是叶子：不 import 任何适配器，也不 import lib/tasks.mjs
 * （那个文件反过来 import 了全部适配器，双向依赖会成环）。
 */

/** 生命周期桶。顺序 = 界面上的筛选钮顺序：能清的在前，活跃的殿后。 */
export const STATES = ['deleted', 'archived', 'untracked', 'empty', 'active'];

/**
 * 会话行为什么可清。这是**唯一的可清信号**（前端 isPurgeable 只看它），
 * 与 state 是两个轴：ZCode 的一条会话可以是 state='active' + reason='wsMissing'。
 * 值域与 STATES 重叠但不等价 —— 'bodyMissing' 只在 reason 这一侧。
 *
 * manual 是 Cursor 专用的。别家不在"界面已删"时不给 reason，因为它们的删除
 * 只碰索引行，删活跃会话会留下指向不存在线程的空壳。Cursor 按可达性分析删，
 * 删一条活跃会话是自洽的 —— 于是"用户明确勾了它"本身就成了清理依据。
 */
export const REASONS = ['deleted', 'archived', 'untracked', 'wsMissing', 'bodyMissing', 'empty', 'manual'];

/**
 * 「删掉这条会话会带走哪些东西」的角色分类。前端按它分组展示，
 * 清理抽屉按它决定执行方式：库行走事务、文件走废纸篓/备份。
 *
 * 存在的理由：五种工具的级联范围差别极大 —— ZCode 一条会话牵连 18 张表
 * 加四类目录，Claude 就是删一个文件。用户在下手前必须看得见差别，
 * 否则「清理」这个词在五个工具里意味着五件不同的事。
 *
 * 值域两边共用（后端枚举 + 前端字典），测试双向锁死。
 */
export const CONTENT_ROLES = ['body', 'segment', 'media', 'transcript', 'log', 'artifact', 'projection', 'lock', 'index'];

/**
 * 会话行的中性默认值。不适用就留默认，不要留空 —— 前端按字段名取值，
 * 少一个键就是 undefined，而 undefined 会一路画到界面上。
 */
export const NEUTRAL_ROW = Object.freeze({
  id: '',
  title: '',
  workspace: '',
  state: 'active',
  reason: null,
  pinned: false,
  model: '',
  typeLabel: '',
  createdAt: 0,
  updatedAt: 0,
  bytes: 0,
  rows: 0,
  children: 0,
  bodyRel: null,
  residual: false,
  /* 正文文件的"血统"：Codex 分页历史把一条长会话切成多段 rollout 文件，
     续段的首行带 history_base（前面那段在另一个文件里）。别家一律 null。
     形状见 lib/apps/codex.mjs 的 rolloutLineage()。 */
  lineage: null,
  /* 这条会话在磁盘上的全部牵连，由各家的 sessionContents() 填。
     形状见 lib/session-contents.mjs 的 EMPTY_CONTENTS。
     为什么放在行里而不是单独接口：列表本来就要 stat 这些路径才能算体积，
     多一次往返只会让「展开详情时数字跳一下」。 */
  contents: null,
});

/** 把适配器给的行补成完整契约。多余的键保留 —— 各家可以有附加字段。 */
export function normalizeRow(row) {
  return { ...NEUTRAL_ROW, ...row };
}

/**
 * 统计口径。byState 的键**取自 state**（不是 reason）—— 前端筛选钮按
 * state 匹配行，拿 reason 当键的钮点了永远筛不出东西。
 *
 * bytes 只累加 t.bytes。正文在库外的那两家（Codex 的 rollout、Claude 的
 * .jsonl）另有 db.bodies 表示，混进这里会让构成条把同一块体积算两遍。
 */
export function totalsOf(tasks) {
  const byState = STATES.map((state) => {
    const g = tasks.filter((t) => t.state === state);
    return { state, count: g.length, bytes: g.reduce((s, t) => s + (t.bytes || 0), 0) };
  }).filter((g) => g.count > 0);

  return {
    count: tasks.length,
    bytes: tasks.reduce((s, t) => s + (t.bytes || 0), 0),
    rows: tasks.reduce((s, t) => s + (t.rows || 0), 0),
    byState,
  };
}

/**
 * 统一排序：体积降序，同体积按最后使用，再按 id 稳定。
 * 体积恒为 0 的库主键会退化成并列，次级键替它保住原本有意义的次序。
 */
export function sortTasks(tasks) {
  return tasks.sort((a, b) =>
    (b.bytes || 0) - (a.bytes || 0) ||
    (b.updatedAt || 0) - (a.updatedAt || 0) ||
    String(a.id).localeCompare(String(b.id)));
}
