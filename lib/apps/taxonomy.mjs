/**
 * 共享分类学本体。
 *
 * 四个工具对同一类东西的**安全语义**是一样的："缓存"删了会重建、"凭据"碰都不能碰、
 * "数据库"要按行清而不是整文件删 —— 这些不该也不允许在每个 app 里各写一份：
 * 各写一份，措辞就会漂移（实测已经漂了：同一个 pluginData 有四个名字），
 * 更糟的是将来某个工具改了 verdict 而别的没跟，同类内容在不同工具下
 * 给出不同档位的"删了会怎样"，那是在撒谎。
 *
 * 所以语义（status/verdict/icon/recommend/locked）在这里定义一次；
 * 各 app 通过 shared(id, prose) 引用，只提供它自己说得出细节的部分：
 *
 *   what    这个工具把这类东西放在哪、具体是哪些目录 —— 每家不同
 *   why     为什么会在这儿 —— 多数是工具相关的（写法可以不同）
 *   outcome 删了会怎样 —— 语义层给默认句，app 可以说得更具体
 *
 * label 语义层也给默认（与安全语义绑定），app 只有在它家习惯说法
 * 真的不同时才覆写 —— 每一处覆写旁边都写了理由，不是随手改。
 */

/**
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

/* ── 语义层：每个条目只写一次 ─────────────────────────────── */

export const SHARED = {
  cache: {
    label: '缓存',
    status: 'good', verdict: 'safe', icon: 'box', recommend: true,
    outcome: '下次联网使用时重新拉取，不丢本地数据。',
  },
  appLog: {
    label: '应用运行日志',
    status: 'good', verdict: 'safe', icon: 'terminal', recommend: true,
    outcome: '删掉只是少了排障线索，不影响功能。',
  },
  shellSnapshot: {
    label: 'Shell 快照',
    status: 'good', verdict: 'safe', icon: 'terminal', recommend: true,
    outcome: '下一个会话自动生成新快照。',
  },
  junk: {
    label: '系统垃圾',
    status: 'good', verdict: 'junk', icon: 'trash', recommend: true,
    outcome: '会被再次生成。',
  },
  transcript: {
    label: '会话正文',
    status: 'warning', verdict: 'review', icon: 'doc',
    outcome: '删掉后这条会话再也回不来；它同时是隐私留存的主体（读过的文件全文、命令输出）。',
  },
  memories: {
    label: '记忆',
    status: 'warning', verdict: 'review', icon: 'doc',
    outcome: '删掉不可再生，之后的会话会忘记这些结论。',
  },
  artifacts: {
    label: '会话产物',
    status: 'warning', verdict: 'review', icon: 'box',
    outcome: '删掉不可恢复。',
  },
  pluginMarket: {
    label: '插件市场克隆',
    status: 'warning', verdict: 'review', icon: 'box',
    outcome: '可重新拉取，但内置市场可能要等下次同步才回来。',
  },
  pluginData: {
    label: '插件数据',
    status: 'warning', verdict: 'review', icon: 'box',
    outcome: '删掉后插件可能要重装，或丢失自身数据。',
  },
  userContent: {
    label: '自定义内容',
    status: 'warning', verdict: 'review', icon: 'doc',
    outcome: '删掉不可再生。',
  },
  runtime: {
    label: '运行期状态',
    status: 'warning', verdict: 'review', icon: 'box',
    outcome: '工具正在运行时删会打断它（套接字/锁没了）；空闲时多数会重建。',
  },
  promptHistory: {
    label: '输入历史',
    status: 'warning', verdict: 'review', icon: 'doc',
    outcome: '删掉只是丢失输入回翻；但这是明文躺着的历史提示词，含项目路径与想法。',
  },
  planDocs: {
    label: '计划文档',
    status: 'warning', verdict: 'review', icon: 'doc',
    outcome: '删掉不可恢复，建议先扫一眼内容再决定。',
  },
  configBackup: {
    label: '配置备份',
    status: 'warning', verdict: 'review', icon: 'gear',
    outcome: '删掉失去回滚点。确认现在的配置没问题再删。',
  },
  /* 顶层的 backups/ 目录。它和 configBackup 不是一回事：配置备份的可回滚对象是
     "这个工具的配置"，而这里是某个东西的完整副本 —— 实测 ~/.codex/backups/ 里
     躺着的是 44 MB 的项目 zip，不是配置。硬归进"配置备份"就是在替它撒谎。 */
  dataBackup: {
    label: '数据备份',
    status: 'warning', verdict: 'review', icon: 'box',
    outcome: '删掉失去这些回滚点。里面是完整副本，可能正装着你之前清理掉的文件 —— 先看一眼是什么再决定。',
  },
  database: {
    label: '索引与历史库',
    status: 'critical', verdict: 'never', icon: 'db', locked: true,
    outcome: '整文件删除 = 不可恢复。要清请走「历史任务」，按会话粒度删，并且先备份。',
  },
  credentials: {
    label: '凭据',
    status: 'critical', verdict: 'never', icon: 'key', locked: true,
    outcome: '删除后掉线，需要重新登录。',
  },
  appConfig: {
    label: '配置',
    status: 'critical', verdict: 'never', icon: 'gear', locked: true,
    outcome: '删掉等于把工具重置回初始状态。',
  },
  unknown: {
    label: '未归类',
    status: 'warning', verdict: 'review', icon: 'box',
    outcome: '工具不了解它，因此默认不勾选。请自行判断。',
  },
};

/**
 * 从共享本体引用一个分类，补上这个工具自己说得出细节的部分。
 * 语义字段不从这里改 —— 想改去 SHARED 改，四家一起生效。
 *
 * @param {string} id  SHARED 里的分类 id
 * @param {{label?:string, what:string, why:string, outcome?:string}} prose 工具自己的描述
 */
export function shared(id, prose) {
  const base = SHARED[id];
  if (!base) throw new Error(`共享分类学里没有「${id}」—— 先在 SHARED 里定义，或在 app 里写成独立分类`);
  return { id, ...base, ...prose };
}
