/**
 * Gemini / Antigravity 的分类学。
 *
 * "Gemini" 在这台机器上其实是两套东西共用一个家：
 *   ~/.gemini/antigravity/          Antigravity IDE（Google 的 agent 编辑器）的数据：
 *                                   conversation_summaries.db 是会话索引（标题/预览/工作区），
 *                                   conversations/ 目录是本机会话正文——但在云同步形态下是空的，
 *                                   正文只存在于远端，本机只有摘要可读。
 *   ~/.gemini/config/               配置：config.json、mcp_config.json、projects/<uuid>.json
 *                                   （项目 id → folderUri 的映射，按项目横切时是 Cursor 反查的对应物）。
 *   ~/Library/Application Support/Antigravity/
 *                                   Electron 壳：各级缓存与崩溃日志，量很小。
 *
 * Gemini CLI 的经典布局（~/.gemini/tmp/<hash>/chat-*.json、checkpoints/、history.jsonl）
 * 在只装过 IDE 的机器上不存在 —— 规则里仍然写上：装了 CLI 的人一跑就能归对类，
 * 不用等下一个版本。没出现过的路径落在 unknown，不会误伤。
 *
 * 会话正文不在本机 → 「历史会话」只读列表（摘要库），没有行可删，也不该删：
 * 删掉摘要 = 界面里那条会话打不开入口，正文还躺在远端，反而制造"半删"状态。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openReadonly } from '../sqlite-open.mjs';
import { makeClassify, shortenHome } from './common.mjs';
import { shared } from './taxonomy.mjs';

const HOME = () => path.join(os.homedir(), '.gemini');
const IDE_HOME = () => path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity');

export const CATEGORIES = {
  /* ── 可回收层 ─────────────────────────────────────────── */
  cache: shared('cache', {
    what: 'antigravity/cache/marketplaces/ 插件市场缓存，App Support 的 GPUCache / Code Cache / DawnCache 等编译与网络缓存。',
    why: '为加速而留下的远端副本。',
    outcome: '首次启动会慢一点（缓存要重建、市场要重拉），不丢任何用户数据。',
  }),
  appLog: shared('appLog', {
    what: 'antigravity/crashes/ 崩溃日志。',
    why: '排障用。',
  }),
  junk: shared('junk', {
    what: '.DS_Store 与临时标记文件。',
    why: 'macOS 自动生成，和 Gemini/Antigravity 完全无关。',
    outcome: '会被 Finder 再次生成，删了没有任何副作用。',
  }),

  /* ── 需权衡层 ─────────────────────────────────────────── */
  summaryIndex: shared('summaryIndex', {
    label: '会话摘要库',
    what: 'antigravity/conversation_summaries.db（含 -wal / -shm）—— 会话的标题、预览与工作区索引。',
    why: 'Antigravity 界面的会话列表靠它；正文在云端的形态里，本机这份只是入口。',
    outcome: '整文件删除 = 界面里那些会话一次性失去入口，而云端正文还在 —— 制造"半删"状态，回收不了空间。本工具对它只读。',
  }),
  transcript: shared('transcript', {
    label: '会话正文',
    what: 'antigravity/conversations/ 下的本机会话正文（云同步形态下为空）。',
    why: '落在本机的会话正文副本。',
  }),
  userContent: shared('userContent', {
    what: 'antigravity/builtin/skills/（内置技能，升级会重置）、config/plugins/ 你装的插件。',
    why: '手写或自定义的部分，工具不一定再生成。',
    outcome: '删掉不可再生（内置技能可随更新回来，自定义的不会）。',
  }),
  runtime: shared('runtime', {
    what: 'antigravity/bin/（webm_encoder 等辅助程序）、lib/node_modules/（sidecar SDK）、installation_id。',
    why: '功能依赖的本地组件与设备标识。',
    outcome: '删掉对应功能不可用，要重装；installation_id 删了会重新分配。',
  }),

  /* ── 保护层 ─────────────────────────────────────────── */
  database: shared('database', {
    what: '一切 .db / .sqlite 及其 -wal / -shm（当前主要是 conversation_summaries.db）。',
    why: '会话索引与全文检索（FTS）都在这里。',
    outcome: '整文件删除 = 会话列表一次性抹掉。本工具对它只读。',
  }),
  credentials: shared('credentials', {
    what: 'jetski-standalone-oauth-token —— 登录得到的 OAuth 令牌。',
    why: 'Antigravity 靠它保持登录。',
    outcome: '删除后掉线，需要重新登录。',
  }),
  appConfig: shared('appConfig', {
    what: 'config/config.json、mcp_config.json、projects/（项目 id → 文件夹映射）、.migrated 标记，App Support 的 Preferences 与 Local State。',
    why: '删掉等于把工具重置回初始状态，MCP 配置与项目映射全丢。',
    outcome: '需要从头重配。',
  }),

  /* ── 兜底 ─────────────────────────────────────────── */
  unknown: shared('unknown', {
    what: '没有命中任何已知规则的文件。',
    why: '可能是新版本新增的目录，或你自己放进去的东西。',
  }),
};

export const RULES = [
  { id: 'junk', test: (p) => /(^|\/)\.DS_Store$/.test(p) },

  // 保护优先：凭据、配置。数据库规则在 transcript 之后 ——
  // conversation_summaries.db 是会话索引，按 transcript 保护（整文件锁定），
  // 但界面上要显示"会话摘要"这个名字，让摘要库在锁定的同时说清自己是什么。
  { id: 'credentials', test: (p) => p === 'jetski-standalone-oauth-token' },
  { id: 'appConfig',   test: (p) => p.startsWith('config/')
                                     || p === 'antigravity/antigravity_state.pbtxt'
                                     || p === 'antigravity/installation_id'
                                     || /^(Preferences|Local State|app_storage.json)$/.test(p) },

  // 摘要库是索引不是正文，而且是本机唯一的会话入口：整文件锁定，连勾选都不给。
  // 必须排在 transcript 前面 —— 它挂着 .db 后缀，落到 database 之前要先叫出自己的名字。
  { id: 'summaryIndex', test: (p) => p.startsWith('antigravity/conversation_summaries.db') },
  { id: 'transcript',   test: (p) => p.startsWith('antigravity/conversations/') },

  { id: 'database',    test: (p) => /\.(db|sqlite)(-wal|-shm)?$/.test(p) },

  // Gemini CLI 的经典布局（本机没装过 CLI 也写上：装了的人一跑就归对类）
  { id: 'transcript',  test: (p) => p.startsWith('tmp/') || p === 'history.jsonl' },
  { id: 'appLog',      test: (p) => p.startsWith('checkpoints/') },
  { id: 'cache',       test: (p) => p === 'models_cache.json' },

  // Antigravity 的组件与内容
  { id: 'appLog',      test: (p) => p.startsWith('antigravity/crashes/') },
  { id: 'cache',       test: (p) => p.startsWith('antigravity/cache/') },
  { id: 'runtime',     test: (p) => p.startsWith('antigravity/bin/')
                                     || p.startsWith('antigravity/lib/') },
  { id: 'userContent', test: (p) => p.startsWith('antigravity/builtin/')
                                     || p.startsWith('config/plugins/') },
  // App Support 壳（ide 目标）：Electron 自建的各级缓存
  { id: 'cache',       test: (p) => /^(GPUCache|Code Cache|Dawn\w*Cache|Cache|blob_storage|Shared Dictionary|DIPS|Trust Tokens|Session Storage|Local Storage|Cookies)(-journal)?\//.test(p)
                                     || /^(GPUCache|Code Cache|Dawn\w*Cache|Cache)$/.test(p) },
];

export const app = {
  id: 'gemini',
  label: 'Gemini',
  // 摘要库是索引不是正文（正文在云端或 conversations/ 的文件里）：
  // 只读展示 —— 删摘要只会让界面失去入口，正文还在云端，是"半删"
  history: 'gemini-db',
  writable: false,
  processLabel: 'Antigravity',
  processes: [
    ['Antigravity', ['-x', 'Antigravity']],
    ['gemini', ['-x', 'gemini']],
  ],
  protectedDirs: [],
  targets: () => [
    { key: 'root', kind: 'dir', path: HOME(), short: shortenHome(HOME()), label: '数据目录' },
    { key: 'ide', kind: 'dir', path: IDE_HOME(), short: shortenHome(IDE_HOME()), label: 'IDE 壳（缓存在这）' },
  ],
  CATEGORIES,
  RULES,
  classify: makeClassify(RULES),
  sessionIdOf: () => null,
  liveSessions: async () => null,
};

export default app;
