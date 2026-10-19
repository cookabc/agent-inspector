/**
 * Claude Code（~/.claude）的分类学。
 *
 * 形态与 ZCode 根本不同：**没有会话数据库**。每个会话就是一个
 * projects/<工作区 slug>/<会话 id>.jsonl 文件，正文全在文件里 —— 所以
 * "删会话"在这里等于"删文件"，走文件清理线，不需要按行删数据库。
 *
 * 另有一份凭据+全局状态放在 ~/.claude（根目录之外）的 .claude.json 里，
 * 因此这个 app 有两个扫描目标：~/.claude 与那个单文件。
 */

import os from 'node:os';
import path from 'node:path';
import { makeClassify } from './common.mjs';
import { shared } from './taxonomy.mjs';

const HOME = () => path.join(os.homedir(), '.claude');

/**
 * 安全语义（status/verdict/icon/recommend/locked）全部来自共享本体 taxonomy.mjs，
 * 这里只写 Claude Code 自己说得出细节的部分：它把这类东西放在哪、为什么在这儿。
 * label 沿用共享默认，只有这台工具的习惯说法确实不同才覆写（并注明理由）。
 */
export const CATEGORIES = {
  /* ── 可回收层 ─────────────────────────────────────────── */
  cache: shared('cache', {
    what: '更新日志、插件目录缓存（cache/、plugins/cache*、plugins/plugin-directory-cache*.json）。',
    why: '为加速而留下的远端副本，源头都在远端。',
  }),
  shellSnapshot: shared('shellSnapshot', {
    what: 'shell-snapshots/ —— 每次运行 Bash 工具前对当前 shell 环境（变量、别名、函数）打的快照。',
    why: '为了让工具调用里的 shell 表现得像你的交互终端。',
    outcome: '下一个会话会自动生成新快照；只影响进行中的那几个命令的环境还原。',
  }),
  pasteCache: {
    id: 'pasteCache',
    label: '粘贴缓存',
    status: 'good',
    verdict: 'safe',
    icon: 'doc',
    recommend: true,
    what: 'paste-cache/ —— 你在输入框里粘贴的长文本/图片落盘副本。',
    why: '粘贴内容太大时先落盘再引用，避免命令行超长。',
    outcome: '进行中的会话里那些粘贴内容将无法再次取回；已发送的会话正文不受影响。注意：里面可能有你粘贴的密码或令牌。',
  },
  junk: shared('junk', {
    what: '.DS_Store —— Finder 留下的目录元数据。',
    why: 'macOS 自动生成，和 Claude Code 完全无关。',
    outcome: '会被 Finder 再次生成，删了没有任何副作用。',
  }),

  /* ── 需权衡层 ─────────────────────────────────────────── */
  transcript: shared('transcript', {
    label: '会话记录',   // Claude 家的习惯说法：正文就是文件本身
    what: 'projects/<工作区>/<会话 id>.jsonl —— 每个会话的完整逐轮记录（消息、工具调用与结果）。',
    why: '这就是会话正文本身，--resume 靠它回放。',
    outcome: '删掉这个文件 = 这个会话彻底消失，再也 --resume 不回来。注意它含读过的文件全文与命令输出，是隐私留存的主体。',
  }),
  memories: shared('memories', {
    label: '项目记忆',
    what: 'projects/<工作区>/memory/ —— 自动记忆条目与 MEMORY.md 索引。',
    why: '跨会话沉淀下来的知识，Claude Code 每次开工会读。',
    outcome: '删掉不可再生，之后的会话会"忘记"这些结论。建议只在确认工作区已废弃时清理。',
  }),
  fileHistory: {
    id: 'fileHistory',
    label: '文件编辑历史',
    status: 'warning',
    verdict: 'review',
    icon: 'doc',
    what: 'file-history/ —— Claude 改过的每个文件的历史副本（供 /rewind 回退）。',
    why: '撤销一次批量编辑时要有旧内容可还原。',
    outcome: '删掉后无法再回退到那些编辑；工作区里的当前文件不受影响。',
  },
  planDocs: shared('planDocs', {
    what: 'plans/*.md —— 计划模式产出的方案文档（随机词命名）。',
    why: '这些是给你的产出物，不是运行时垃圾。',
    outcome: '删掉不可恢复。文件名没有语义，建议先看一眼内容再决定。',
  }),
  promptHistory: shared('promptHistory', {
    what: 'history.jsonl —— 你敲进输入框的每条提示历史。',
    why: '上下键回翻历史输入靠它。',
  }),
  sessionRuntime: {
    id: 'sessionRuntime',
    label: '会话运行期',
    status: 'warning',
    verdict: 'review',
    icon: 'box',
    what: 'sessions/、session-env/、tasks/ —— 会话与后台任务运行时的临时目录。',
    why: '进程活着时要在里面读写状态。',
    outcome: 'Claude 正在跑时删会打断那个会话或后台任务；空闲时删没有长期影响。',
  },
  configBackup: shared('configBackup', {
    label: '全局状态备份',   // 覆写：备的是 ~/.claude.json 全局状态，不只是 cli 配置
    what: 'backups/.claude.json.backup.<时间戳> —— 每次改配置前自动留的 .claude.json 副本。',
    why: '配置被写坏时能回滚。',
    outcome: '删掉失去回滚点；注意这些副本里可能含旧的账号与凭据字段。',
  }),
  pluginMarket: shared('pluginMarket', {
    what: 'plugins/marketplaces/ —— 市场仓库的本地 git 克隆。',
    why: '从远端拉下来的副本，可重新拉取。',
    outcome: '可删，重新添加市场会再克隆一次。已安装插件的数据不受影响。',
  }),
  pluginData: shared('pluginData', {
    label: '插件数据与安装',
    what: 'plugins/store/、known_marketplaces.json —— 插件安装状态与你添加过的市场列表。',
    why: '这是插件运行时写下的状态，不是可重建的缓存。',
    outcome: '删掉后市场列表要重新添加、插件可能要重装。',
  }),
  userContent: shared('userContent', {
    what: 'skills/、commands/、agents/ —— 你自己写的扩展。',
    why: '手写内容，工具不会再生成。',
    outcome: '删掉不可再生。除非确定不再使用，否则保留。',
  }),

  /* ── 保护层 ─────────────────────────────────────────── */
  database: shared('database', {
    label: '索引与状态库',
    what: 'sqlite 库及其 -wal / -shm 侧文件。',
    why: '工具侧的状态库，整文件删等于一次抹掉。',
    outcome: '删除 = 不可恢复，且会让工具下次启动重建一份空的。',
  }),
  credentials: shared('credentials', {
    label: '凭据与账号',
    what: '~/.claude.json —— 账号、密钥引用、每个项目的会话计数与设置都写在这一份里（在 ~/.claude 之外）。',
    why: 'Claude Code 靠它保持登录。',
    outcome: '删除后掉线，要重新登录；里面连带丢了各项目的历史统计。',
  }),
  appConfig: shared('appConfig', {
    what: 'settings.json（权限、hooks、模型）与运行标记。',
    why: '删掉等于把 Claude Code 重置回初始状态，hooks 与权限规则全丢。',
    outcome: '需要从头重配权限、hooks 与各项偏好。',
  }),
  unknown: shared('unknown', {
    what: '没有命中任何已知规则的文件。',
    why: '可能是新版本 Claude Code 新增的目录，或你自己放进去的东西。',
  }),
};

export const RULES = [
  { id: 'junk',         test: (p) => /(^|\/)\.DS_Store$/.test(p) },
  { id: 'configBackup', test: (p) => /\.(bak|backups?)([.-][^/]*)?$/i.test(p) },

  // 保护优先：单文件目标 ~/.claude.json 就是凭据
  { id: 'credentials',  test: (p) => p === '.claude.json' || p === '.credentials.json' },
  { id: 'appConfig',    test: (p) => /^settings(\..*)?\.json$/.test(p) || p === 'CLAUDE.md' },
  { id: 'configBackup', test: (p) => p.startsWith('backups/') },
  { id: 'appConfig',    test: (p) => p === '.last-cleanup' },
  { id: 'database',     test: (p) => /\.sqlite(-wal|-shm)?$/.test(p) || p.startsWith('sqlite/') },

  // 会话正文：projects/<slug>/<uuid>.jsonl；memory/ 是自动记忆
  { id: 'memories',     test: (p) => /^projects\/[^/]+\/memory\//.test(p) },
  { id: 'transcript',   test: (p) => p.startsWith('projects/') },

  { id: 'fileHistory',    test: (p) => p.startsWith('file-history/') },
  { id: 'planDocs',       test: (p) => p.startsWith('plans/') },
  { id: 'promptHistory',  test: (p) => p === 'history.jsonl' },
  { id: 'sessionRuntime', test: (p) => /^(sessions|session-env|tasks)\//.test(p) },
  { id: 'pasteCache',     test: (p) => p.startsWith('paste-cache/') },
  { id: 'shellSnapshot',  test: (p) => p.startsWith('shell-snapshots/') },
  { id: 'cache',          test: (p) => p.startsWith('cache/') || /^plugins\/(cache|plugin-directory-cache)/.test(p) },
  { id: 'pluginMarket',   test: (p) => p.startsWith('plugins/marketplaces/') },
  { id: 'pluginData',     test: (p) => p.startsWith('plugins/') },
  { id: 'userContent',    test: (p) => /^(skills|commands|agents)\//.test(p) },
];

/** Claude 没有会话索引库，所以文件扫描不做孤儿判定 —— 判不了就别乱标。 */
export async function liveSessions() {
  return null;
}

export const app = {
  id: 'claude',
  label: 'Claude Code',
  // 会话正文就是文件：这一条清理线走文件删除，不写任何数据库
  history: 'claude-files',
  processLabel: 'Claude Code',
  processes: [
    ['claude', ['-x', 'claude']],
    ['claude-code', ['-f', 'claude-code']],
  ],
  protectedDirs: [],
  targets: () => [
    {
      key: 'home',
      kind: 'dir',
      path: HOME(),
      label: '数据目录',
    },
    {
      // 单文件目标：凭据与全局状态不在 ~/.claude 里面，但躲不开它 —— 显式列出来。
      key: 'dotfile',
      kind: 'file',
      path: path.join(os.homedir(), '.claude.json'),
      label: '凭据与全局状态（目录之外）',
    },
  ],
  CATEGORIES,
  RULES,
  classify: makeClassify(RULES),
  // 会话 id 是文件名（uuid），但没有索引库可比对，因此不提供 sessionIdOf
  sessionIdOf: () => null,
  liveSessions,
};

export default app;
