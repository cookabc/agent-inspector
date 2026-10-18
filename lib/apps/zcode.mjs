/**
 * ZCode（~/.zcode）的分类学。
 *
 * 这个工具的起点：一次 grep 自引用把 ~/.zcode/cli/exec 里的单条日志撑到 34 GB。
 * 会话正文在 cli/db/db.sqlite，任务元数据在 v2/tasks-index.sqlite，
 * 界面上"删除任务"只是把 tasks.deleted 置 1 —— 正文一行没少。
 */

import os from 'node:os';
import path from 'node:path';
import { openReadonly } from '../sqlite-open.mjs';
import { makeClassify, shortenHome, RUNAWAY_BYTES } from './common.mjs';
import { shared } from './taxonomy.mjs';

export const CATEGORIES = {
  /* ── 病理层：本次审计的主角 ───────────────────────────────── */
  runaway: {
    id: 'runaway',
    label: '失控放大日志',
    status: 'serious',
    verdict: 'safe',
    icon: 'alert',
    recommend: true,
    what: '单条命令产生的超大输出日志，每个都超过 500 MB，最大的一个 34 GB。',
    why: 'ZCode 把每条命令的 stdout 完整落盘到 ~/.zcode/cli/exec/。某次只读搜索把搜索范围设成了这个目录本身，grep 一边读、一边匹配到自己正在写入的内容，输出层层嵌套、指数膨胀。',
    outcome: '只丢失那几次命令的原始字节。结论已经写进会话记录，不影响会话、任务、配置、记忆或凭据。',
  },

  /* ── 可回收层 ─────────────────────────────────────────── */
  execLog: {
    id: 'execLog',
    label: '工具输出日志',
    status: 'good',
    verdict: 'safe',
    icon: 'terminal',
    recommend: true,
    what: '每条 Bash / 终端命令的完整 stdout 捕获，按会话分目录存放。',
    why: '纯历史日志，只用于在界面里回看某条命令当时打印了什么。',
    outcome: '删掉后无法回看这些命令的原始输出；会话、任务、记忆、产物都不受影响。',
  },
  appLog: shared('appLog', {
    what: 'ZCode 自身的运行日志（cli/log、v2/logs）。',
    why: '排障用的滚动日志，按天切分。',
  }),
  cache: shared('cache', {
    what: '插件缓存、运行时缓存（cli/plugins/cache、v2/cache）。',
    why: '为了加速而缓存的副本，源头都在远端或可重建。',
    outcome: '下次使用时重新下载/重建，会慢一点，但不会丢数据。',
  }),
  junk: shared('junk', {
    what: '.DS_Store —— Finder 留下的目录元数据。',
    why: 'macOS 自动生成，和 ZCode 完全无关。',
    outcome: '会被 Finder 再次生成，删了没有任何副作用。',
  }),
  cuaDev: {
    id: 'cuaDev',
    label: 'Computer Use 副本身份',
    status: 'good',
    verdict: 'safe',
    icon: 'box',
    recommend: true,
    // 默认排除：内容是别的 .app 的副本，理论上可重建，
    // 但你现在可能正靠着 dev 版本跑东西 —— 这种"安全但会硌一下"的，不放进默认推荐。
    recommendDefaultOff: true,
    what: 'Computer Use 辅助程序的 dev 构建副本（约 124 MB）。',
    why: '与正式 .app 内容重复，是开发期的并行副本。',
    outcome: '若当前没在用 dev 版本，删掉不影响 Computer Use 功能。删前建议先确认应用能正常启动。',
  },

  /* ── 需权衡层 ─────────────────────────────────────────── */
  transcript: shared('transcript', {
    label: '会话记录',   // ZCode 家的习惯说法：transcript/model-io 都是记录形态
    what: '每个子 Agent 的完整事件流（transcript.jsonl），以及每次模型调用的请求/响应原文（cli/rollout/model-io-*.jsonl）。',
    why: '请求体包含系统提示、读过的每一个文件的全文、图片 base64 —— 既是会话回放与恢复的依据，也是一份不可再生的敏感副本。',
    outcome: '删除后：① 无法回放/恢复这些子 Agent 的运行；② 从隐私角度反而减少了本地留存的原文。请按需权衡。',
  }),
  memories: shared('memories', {
    label: '项目记忆',
    what: '按项目累积的记忆条目与 MEMORY.md。',
    why: '这是跨会话沉淀下来的知识，不是日志 —— ZCode 每次开工会读它。',
    outcome: '删掉不可再生，之后的会话会"忘记"这些结论。建议保留；只在确认某项目已废弃时清理。',
  }),
  sessionMedia: {
    id: 'sessionMedia',
    label: '会话贴图',
    status: 'warning',
    verdict: 'review',
    icon: 'box',
    what: '会话里粘贴/上传过的图片（cli/image-cache/sess_<id>/*.png），按会话分目录。',
    why: '你贴进对话框的原件，会话库和 transcript 只引用文件名，图片本身只存在这里。',
    outcome: '删掉后历史会话里的图片缩略图会失效，文字内容不受影响。原件不可再生。',
  },
  artifacts: shared('artifacts', {
    what: 'Agent 在各会话中生成的产物文件（HTML 页面、导出物等）。',
    why: '这是你的产出物，不是缓存。',
    outcome: '删掉不可恢复。请先在界面里按体积排序看一眼，确认没有还要用的东西。',
  }),
  pluginMarket: shared('pluginMarket', {
    what: '插件市场仓库的本地克隆（cli/plugins/marketplaces）。',
    why: '从远端拉下来的仓库副本，可重新拉取。',
    outcome: '可安全删除，之后重新添加市场会重新克隆。已安装插件的数据不受影响。',
  }),
  pluginData: shared('pluginData', {
    label: '插件数据与市场配置',
    what: '插件的持久数据（cli/plugins/data）、你添加过的市场列表（known_marketplaces.json）与图标映射（icon-sources.json）。',
    why: '这些是插件运行时写下的状态，不是可重建的缓存。',
    outcome: '删掉后插件可能丢失自身数据，市场列表需要重新添加。请确认不再使用对应插件再删。',
  }),
  cuaApp: {
    id: 'cuaApp',
    label: 'Computer Use 程序',
    status: 'warning',
    verdict: 'review',
    icon: 'box',
    what: 'ZCode Computer Use 辅助应用本体（dev.zcode.cua-helper）。',
    why: 'Computer Use 功能依赖它执行桌面自动化。',
    outcome: '删除会让 Computer Use 功能不可用，需要重新安装辅助程序。',
  },
  runtime: shared('runtime', {
    label: '运行时数据',
    what: '运行期状态与证书（v2/runtime、v2/certs）。',
    why: '供远端控制与本地服务使用的状态与自签证书。',
    outcome: '可能触发重新握手或重新生成证书，一般不影响登录态，但请谨慎。',
  }),
  workspace: {
    id: 'workspace',
    label: '会话工作区',
    status: 'warning',
    verdict: 'review',
    icon: 'doc',
    what: 'ZCode 默认工作区与会话启动脚本目录。',
    why: '对话式工作区里可能存着你在会话中随手写的文件。',
    outcome: '删前请逐个看过，里面可能有你自己写的东西。',
  },
  userContent: shared('userContent', {
    what: '你自己放进去的东西：skills、commands、agents。',
    why: '这些是你手写的扩展，不是工具生成的。',
    outcome: '删掉不可再生。除非确定不再使用，否则保留。',
  }),

  /* ── 保护层 ─────────────────────────────────────────── */
  database: shared('database', {
    label: '会话数据库',
    what: '应用主数据库：cli/db/db.sqlite 与 v2/tasks-index.sqlite（含 -wal / -shm）。',
    why: 'ZCode 的全部历史都在这里 —— 会话、消息、任务分组、工作流、令牌用量。',
    outcome: '删除 = 历史彻底消失且不可恢复。要清请走「历史任务」，按任务粒度删，并且有备份。',
  }),
  credentials: shared('credentials', {
    what: 'OAuth token、JWT、各 provider 的 API Key（v2/credentials.json）。',
    why: 'ZCode 靠它保持登录与调用模型。',
    outcome: '删除后全部 provider 掉线，需要重新登录。注意：文件权限 600，但内容是明文。',
  }),
  appConfig: shared('appConfig', {
    what: '模型 provider、界面偏好、计划与登录记录等全部设置。',
    why: '删掉等于把 ZCode 重置回初始状态。',
    outcome: '需要从头重新配置模型、provider 与各项偏好。',
  }),
  usage: {
    id: 'usage',
    label: '用量统计',
    status: 'critical',
    verdict: 'never',
    icon: 'db',
    locked: true,
    what: '累计请求数、token 消耗、按模型的用量分布（cli/usage.json）。',
    why: '体积极小（几 KB），但记录了不可再生的累计值。',
    outcome: '删除后用量会从零重新累计，历史消耗无法找回。',
  },
  configBackup: shared('configBackup', {
    what: 'cli/config.json.bak-<时间戳> 这类改动前留下的旧配置副本。',
    why: '配置被写坏时能回滚 —— 多半是别的工具替你存的。',
  }),
  unknown: shared('unknown', {
    what: '没有命中任何已知规则的文件。',
    why: '可能是新版本 ZCode 新增的目录，或你自己放进去的东西。',
  }),
};

const EXEC_LOG = /^cli\/exec\/[^/]+\/(call_[A-Za-z0-9_-]+-stdout\.log|.*\.log)$/;

export const RULES = [
  { id: 'junk',         test: (p) => /(^|\/)\.DS_Store$/.test(p) },
  // 各种"改配置前留一份"的副本：跨 app 同形，统一按备份处理
  { id: 'configBackup', test: (p) => /\.(bak|backups?)([.-][^/]*)?$/i.test(p) },

  // 先按体积判定"失控"，再兜底成普通工具日志
  { id: 'runaway',      test: (p, s) => EXEC_LOG.test(p) && s >= RUNAWAY_BYTES },
  { id: 'execLog',      test: (p) => p.startsWith('cli/exec/') },

  { id: 'transcript',   test: (p) => p.startsWith('cli/agents/') || p.startsWith('cli/rollout/') },
  { id: 'sessionMedia', test: (p) => p.startsWith('cli/image-cache/') },
  { id: 'artifacts',    test: (p) => p.startsWith('cli/artifacts/') },
  { id: 'database',     test: (p) => p.startsWith('cli/db/') },
  { id: 'memories',     test: (p) => p.startsWith('cli/memories/') },
  { id: 'appLog',       test: (p) => p.startsWith('cli/log/') },
  { id: 'cache',        test: (p) => p.startsWith('cli/plugins/cache/') },
  { id: 'pluginMarket', test: (p) => p.startsWith('cli/plugins/marketplaces/') },
  // 插件的持久数据与配置：不是缓存，不能按"可安全清理"处理
  { id: 'pluginData',   test: (p) => p.startsWith('cli/plugins/data/') ||
                                      /^cli\/plugins\/(known_marketplaces|icon-sources)\.json$/.test(p) },
  // 注意：不再有 cli/plugins/ 的兜底规则。它会把未知的插件内容静默当成缓存推荐删除。
  { id: 'usage',        test: (p) => p === 'cli/usage.json' },
  { id: 'appConfig',    test: (p) => p === 'cli/config.json' },
  // 不再有 cli/ 的通用兜底。它会把 cli/ 下新出现的未知内容静默当成"工具日志"（可安全清理）。
  // 未知内容应该落到 unknown（默认不勾选），由人来判断。

  { id: 'credentials',  test: (p) => p === 'v2/credentials.json' },
  { id: 'database',     test: (p) => /^v2\/tasks-index\.sqlite/.test(p) },
  { id: 'appConfig',    test: (p) => /^v2\/(config|setting|provider_config|bot-config\.v3|bot-state\.v3|model-provider-display-order|onboarding-record|telemetry-state)\.json$/.test(p) },
  { id: 'appLog',       test: (p) => p.startsWith('v2/logs/') },
  { id: 'cache',        test: (p) => p.startsWith('v2/cache/') },
  { id: 'runtime',      test: (p) => p.startsWith('v2/runtime/') },
  { id: 'runtime',      test: (p) => p.startsWith('v2/certs/') },
  { id: 'appConfig',    test: (p) => p.startsWith('v2/') },

  { id: 'cuaDev',       test: (p) => p.startsWith('computer-use/dev/') },
  { id: 'cuaApp',       test: (p) => p.startsWith('computer-use/') },

  { id: 'workspace',    test: (p) => p.startsWith('workspace/') },
  { id: 'pluginData',   test: (p) => p.startsWith('plugin-workspace/') },
  { id: 'userContent',  test: (p) => /^(skills|commands|agents)\//.test(p) },
];

/**
 * 从相对路径里取出 sess_<id> 的 id。
 * agents / artifacts / image-cache 用会话目录分层；rollout 是扁平的 model-io-sess_<id>.jsonl。
 * 目录名/文件名里的就是完整会话 id（带 sess_ 前缀），与会话库 session.id 原样对应，不能截掉前缀。
 */
export function sessionIdOf(rel) {
  const m = /^cli\/(?:agents|artifacts|image-cache)\/(sess_[^/]+)\//.exec(rel)
    || /^cli\/rollout\/model-io-(sess_[^.]+)\.jsonl$/.exec(rel);
  return m ? m[1] : null;
}

/**
 * 读出会话库里所有会话的 id。失败返回 null，由调用方决定如何处理（这里是"不判定孤儿"）。
 * 库不存在或读取失败时绝不能判定"全都是孤儿" —— 那会把所有会话文件标成可清理。
 */
export async function liveSessions(root) {
  const db = openReadonly(path.join(root, 'cli', 'db', 'db.sqlite'));
  if (!db) return null;
  try {
    return new Set(db.prepare('SELECT id FROM session').all().map((r) => r.id));
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

export const app = {
  id: 'zcode',
  label: 'ZCode',
  // 历史会话这条线走哪种适配器：db = 会话正文在 sqlite 里，可按行清理
  history: 'zcode-db',
  processLabel: 'ZCode',
  processes: [
    ['ZCode', ['-x', 'ZCode']],
    ['zcode-cli', ['-x', 'zcode-cli']],
    ['zcode-host-local', ['-f', 'zcode-host-local']],
    ['ZCode Helper', ['-f', 'ZCode Helper']],
  ],
  // db.sqlite 所在目录必须整体保护：不能整文件删，只能按任务粒度清理
  protectedDirs: ['cli/db'],
  targets: () => [{
    key: 'root',
    kind: 'dir',
    path: path.join(os.homedir(), '.zcode'),
    short: shortenHome(path.join(os.homedir(), '.zcode')),
    label: '数据目录',
  }],
  CATEGORIES,
  RULES,
  classify: makeClassify(RULES),
  sessionIdOf,
  liveSessions,
};

export default app;
