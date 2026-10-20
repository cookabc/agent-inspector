/**
 * Cursor 的分类学。
 *
 * 两个扫描目标，而且大头不在 ~/.cursor：
 *   ~/.cursor                              CLI 与 Agent 侧的数据（扩展、项目会话、plans）
 *   ~/Library/Application Support/Cursor   IDE 侧的数据 —— 聊天正文在 User/globalStorage/state.vscdb
 *
 * state.vscdb 里 composerHeaders 是界面可见的会话头（48 条），而气泡正文按
 * bubbleId:<composerId>:<bubbleId> 存在 cursorDiskKV（3 万条、3.4 亿字节）。
 * 两者的差集就是"界面里已经看不到了、正文还留在磁盘上"。
 * 这一份库由 IDE 独占写入（Electron + sql.js 风格的 key/value），没有可依赖的外键关系，
 * 所以这个 app **不提供按行删除** —— 见 app.writable。
 *
 * 唯一的写路径是「孤儿会话回灌」（lib/cursor-recover.mjs）：transcript 文件还在、
 * composerHeaders 里却没有这条会话时，按 Cursor 自己的结构把三组行补回去。
 * 它不删任何东西，只新增；已存在的会话一律跳过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClassify, SHARED_RULES } from './common.mjs';
import { shared } from './taxonomy.mjs';

const CLI_HOME = () => path.join(os.homedir(), '.cursor');
const IDE_HOME = () => path.join(os.homedir(), 'Library', 'Application Support', 'Cursor');

/** IDE 自己会重建的各级缓存目录（App Support 下）。 */
const IDE_CACHE_DIRS = /^(CachedData|Cache|Code Cache|GPUCache|Dawn\w*Cache|CachedExtensionVSIXs|CachedProfilesData|Service Worker|blob_storage|Shared Dictionary|Crashpad)\//;

/**
 * 安全语义来自共享本体（taxonomy.mjs），这里只写 Cursor 自己说得出细节的部分。
 */
export const CATEGORIES = {
  /* ── 可回收层 ─────────────────────────────────────────── */
  cache: shared('cache', {
    what: '编译缓存与网络缓存（App Support 的 CachedData / Cache / Code Cache / GPUCache / Partitions 等，~/.cursor 的 statsig-cache.json）。',
    why: '为启动速度和网络抖动留下的副本。',
    outcome: '首次启动会慢一点（V8 缓存要重建、实验配置要重拉），不丢任何用户数据。',
  }),
  appLog: shared('appLog', {
    what: 'App Support 的 logs/、sentry/、process-monitor/。',
    why: '排障与崩溃上报用的滚动日志。',
  }),
  junk: shared('junk', {
    what: '.DS_Store —— Finder 留下的目录元数据。',
    why: 'macOS 自动生成，和 Cursor 完全无关。',
    outcome: '会被 Finder 再次生成，删了没有任何副作用。',
  }),

  /* ── 需权衡层 ─────────────────────────────────────────── */
  extensions: {
    id: 'extensions',
    label: '已安装扩展',
    status: 'warning',
    verdict: 'review',
    icon: 'box',
    recommend: true,
    recommendDefaultOff: true,
    what: '~/.cursor/extensions/ —— 装好的扩展本体（这台机器上 112 MB）。',
    why: 'VS Code 系的扩展目录，Cursor 从 marketplace 拉下来放在这。',
    outcome: '删掉等于卸载这些扩展：语言服务、格式化器、主题全部失效，要手动重装。正在编辑的项目会当场受影响。',
  },
  projectSessions: {
    id: 'projectSessions',
    label: '项目会话数据',
    status: 'warning',
    verdict: 'review',
    icon: 'doc',
    what: '~/.cursor/projects/<id>/ —— 每个项目工作区的 Agent 会话数据与内存目录。',
    why: 'Agent 在那个项目的上下文都在这里。',
    outcome: '删掉后那个项目的 Agent 历史与上下文丢失，不可再生。',
  },
  planDocs: shared('planDocs', {
    what: '~/.cursor/plans/*.plan.md —— Plan 模式产出的方案文档。',
    why: '给你的产出物，不是运行时垃圾。',
    outcome: '删掉不可恢复。文件名带随机后缀，建议先扫一眼标题。',
  }),
  localHistory: {
    id: 'localHistory',
    label: '编辑器文件历史',
    status: 'warning',
    verdict: 'review',
    icon: 'doc',
    what: 'App Support 的 User/History/ —— 编辑器本地历史（每次保存的旧内容）。',
    why: 'Timeline 里回退未提交改动靠它。',
    outcome: '删掉后无法用编辑器回退到那些旧内容；文件本身与工作区不受影响。',
  },
  workspaceState: {
    id: 'workspaceState',
    label: '工作区与扩展状态',
    status: 'warning',
    verdict: 'review',
    icon: 'box',
    what: 'App Support 的 User/workspaceStorage/、User/globalStorage/（state.vscdb 除外）、AgentStores/、WebStorage/、IndexedDB/。',
    why: '界面布局、标签页、扩展自身状态与内嵌浏览器存储。',
    outcome: '删掉会丢工作区布局、登录过的内嵌站点会话与扩展设置；不会丢聊天正文（那在 state.vscdb）。',
  },
  browserState: {
    id: 'browserState',
    label: '内嵌浏览器状态',
    status: 'warning',
    verdict: 'review',
    icon: 'box',
    what: 'App Support 的 Partitions/、DIPS、Trust Tokens、Cookies 等 Chromium 存储。',
    why: 'Cursor 内嵌浏览器/Agent 浏览网页时留下的会话。',
    outcome: '删掉等于那些内嵌站点要重新登录，Partitions 里有 cookie —— 也是隐私。',
  },
  backups: {
    id: 'backups',
    label: '未保存备份',
    status: 'warning',
    verdict: 'review',
    icon: 'doc',
    what: 'App Support 的 Backups/ —— 崩溃时未保存编辑器内容的备份。',
    why: '为了下次打开能恢复你没保存的东西。',
    outcome: '删掉可能丢掉某次崩溃时没保存的编辑。确认没有未保存内容再删。',
  },
  pluginData: shared('pluginData', {
    label: '插件与技能',   // 覆写：~/.cursor 下这批是 skills/plugins/agents 混合体
    icon: 'doc',           // 覆写：以手写技能为主，文档形态比"箱子"更贴切
    what: '~/.cursor/{skills,skills-cursor,plugins,agents}/ —— 你装的技能、插件与自定义 agent。',
    why: '混合体：有远端拉下来的副本，也有你手写的。',
    outcome: '手写的部分删掉不可再生；远端部分可重拉，但要重装。',
  }),
  runtime: shared('runtime', {
    what: '~/.cursor/sandbox-policies/、update-supervisor/、User/mcp-oauth-attempts 等运行期落点。',
    why: '沙箱策略、更新进程与 OAuth 尝试记录。',
  }),

  /* ── 保护层 ─────────────────────────────────────────── */
  database: shared('database', {
    label: '聊天与索引库',
    what: 'User/globalStorage/state.vscdb（含 -wal/-shm）、conversation-search.db、~/.cursor/ai-tracking/ai-code-tracking.db 与一切 .db/.sqlite。',
    why: '聊天正文、气泡、检查点、搜索索引、AI 代码归属统计都在这几个库里 —— 其中 state.vscdb 是 Cursor 唯一的会话存储。',
    outcome: '整文件删除 = 全部聊天历史一次抹掉，且 IDE 正在写它会直接损坏库。要清请走「历史任务」面板：它只读地告诉你能在界面里删哪些。',
  }),
  appConfig: shared('appConfig', {
    what: '~/.cursor/{mcp.json,cli-config.json,argv.json,ide_state.json,blocklist,unified_repo_list.json} 与 User/settings.json、storage.json。',
    why: 'MCP 服务器、CLI 设置、启动参数与全部编辑器键位/设置。',
    outcome: '删掉等于把 Cursor 重置回初始状态，MCP 配置与个人设置全丢。',
  }),
  configBackup: shared('configBackup', {
    what: 'settings.json.bak-<时间戳> 这类改动前留下的旧配置副本。',
    why: '配置被写坏时能回滚 —— 多半是别的工具替你存的。',
  }),
  dataBackup: shared('dataBackup', {
    what: '~/.cursor/backups/ —— 完整数据副本，不是配置副本。（App Support 侧的 Backups/ 是另一回事，见「未保存备份」。）',
    why: '别的工具在批量改动前整批存的一份。',
    outcome: '删掉失去这批回滚点；先看清是哪次操作留下的副本再决定。',
  }),
  unknown: shared('unknown', {
    what: '没有命中任何已知规则的文件。',
    why: '可能是新版本 Cursor 新增的目录，或你自己放进去的东西。',
  }),
};

export const RULES = [
  { id: 'junk', test: (p) => /(^|\/)\.DS_Store$/.test(p) },
  { id: 'configBackup', test: SHARED_RULES.configBackupFile },
  // CLI 侧的 backups/（ide 侧的同名目录由下面那条更贴切的 backups 规则接住）
  { id: 'dataBackup',   test: (p, s, ctx) => ctx?.t !== 'ide' && SHARED_RULES.dataBackupDir(p) },

  // 保护优先：整库与配置
  { id: 'database',    test: (p) => /\.(db|sqlite|vscdb|vscdb-wal|vscdb-shm|sqlite-wal|sqlite-shm)(\.bak)?$/.test(p) || p.startsWith('ai-tracking/') },
  { id: 'appConfig',   test: (p, s, ctx) => (ctx?.t === 'ide' && /^User\/(settings\.json|storage\.json)$/.test(p)) ||
                                             /^(mcp\.json|cli-config\.json|argv\.json|ide_state\.json|blocklist|unified_repo_list\.json)$/.test(p) },
  // 聊天正文在库里：只保护库文件本身；库里"界面已删"的正文由历史会话面板只读报告
  { id: 'database',    test: (p) => p.startsWith('User/globalStorage/') && /^User\/globalStorage\/(state\.vscdb|conversation-search\.db)/.test(p) },

  { id: 'cache',        test: (p, s, ctx) => ctx?.t === 'ide' ? (IDE_CACHE_DIRS.test(p) || p === 'languagepacks.json') : p === 'statsig-cache.json' },
  { id: 'appLog',       test: (p, s, ctx) => ctx?.t === 'ide' && /^(logs|sentry|process-monitor)\//.test(p) },
  { id: 'browserState', test: (p, s, ctx) => ctx?.t === 'ide' && (/^(Partitions|DIPS|Trust Tokens|Network|Cookies|Local State|Local Storage|Preferences|SharedStorage|Shared Dictionary-wal|Session Storage|TransportSecurity|Login Data)/.test(p) || p === 'QuotaManager') },
  { id: 'runtime',      test: (p, s, ctx) => ctx?.t === 'ide' && (/(\.sock|\.pid|\.lock)$/.test(p) || /^(code\.lock|machineid|DevToolsActivePort)/.test(p) || /^update-supervisor\//.test(p)) },
  { id: 'backups',      test: (p, s, ctx) => ctx?.t === 'ide' && /^(Backups|backup)/.test(p) },
  { id: 'localHistory', test: (p, s, ctx) => ctx?.t === 'ide' && p.startsWith('User/History/') },
  { id: 'workspaceState', test: (p, s, ctx) => ctx?.t === 'ide' &&
      /^(User\/(workspaceStorage|globalStorage)\/|AgentStores\/|WebStorage\/|IndexedDB\/)/.test(p) },

  { id: 'extensions',       test: (p, s, ctx) => ctx?.t === 'cli' && p.startsWith('extensions/') },
  { id: 'projectSessions',  test: (p) => p.startsWith('projects/') },
  { id: 'planDocs',         test: (p) => p.startsWith('plans/') },
  { id: 'runtime',          test: (p) => p.startsWith('sandbox-policies/') },
  { id: 'pluginData',       test: (p) => /^(skills|skills-cursor|plugins|agents)\//.test(p) },
];

/**
 * 读 `User/workspaceStorage/<uuid>/workspace.json`，把 Cursor 的不透明工作区 UUID
 * 还原成文件夹绝对路径 —— 否则按项目横切时，Cursor 的会话谁也无法归并。
 *
 * `folder` 是 `file://` URL（可能带 percent-encoding）。读不到、解析不了、
 * 不是 file: 协议的条目一律跳过：宁可少映射几个会话，也不要把 UUID 猜成路径。
 *
 * @returns {Promise<Map<string, string>>} uuid → 绝对路径
 */
export async function workspaceFolders(idePath) {
  const base = path.join(idePath, 'User', 'workspaceStorage');
  let names;
  try { names = await fs.promises.readdir(base); } catch { return new Map(); }
  const out = new Map();
  for (const name of names) {
    let folder;
    try {
      const raw = await fs.promises.readFile(path.join(base, name, 'workspace.json'), 'utf8');
      folder = JSON.parse(raw)?.folder;
    } catch { continue; }               // 没有这个文件（如 empty-window）或不是合法 JSON
    if (typeof folder !== 'string') continue;
    let abs;
    try {
      const url = new URL(folder);
      // 只认本机文件夹协议；vscode-remote:// 之类的远端工作区没有本地路径可归并
      if (url.protocol !== 'file:') continue;
      // 项目目录可能已经删除（realpath 失败）—— 那时用 fileURLToPath 的结果：
      // 路径本身仍然有效，正是"工作区没了但会话还在"的典型情形。
      try { abs = fs.realpathSync.native(fileURLToPath(url)); }
      catch { abs = fileURLToPath(url); }
    } catch { continue; }
    if (abs && path.isAbsolute(abs)) out.set(name, abs);
  }
  return out;
}

export const app = {
  id: 'cursor',
  label: 'Cursor',
  history: 'cursor-db',
  // 只读：不提供按行删除（库由 IDE 独占写入，键值之间没有外键关系可依）
  writable: false,
  processLabel: 'Cursor',
  processes: [
    ['Cursor', ['-x', 'Cursor']],
    ['cursor-agent', ['-f', 'cursor-agent']],
    ['cursor-mcp', ['-f', 'cursor-mcp']],
    ['Cursor Helper', ['-f', 'Cursor Helper']],
  ],
  protectedDirs: [],
  // 不删行（writable:false），但有一条受控的"孤儿会话回灌"写路径。
  canRecover: true,
  targets: () => [
    { key: 'cli', kind: 'dir', path: CLI_HOME(), label: 'CLI 与 Agent 数据' },
    { key: 'ide', kind: 'dir', path: IDE_HOME(), label: 'IDE 数据（聊天正文在这）' },
  ],
  CATEGORIES,
  RULES,
  classify: makeClassify(RULES),
  sessionIdOf: () => null,
  liveSessions: async () => null,
  workspaceFolders,
};

export default app;
