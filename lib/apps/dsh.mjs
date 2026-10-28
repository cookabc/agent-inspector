/** DeepSeek Harness 的文件分类。会话元数据读取见 tasks-dsh.mjs。 */

import os from 'node:os';
import path from 'node:path';
import { makeClassify, SHARED_RULES } from './common.mjs';
import { shared } from './taxonomy.mjs';

const HOME = () => path.join(os.homedir(), '.dsh');

export const CATEGORIES = {
  /* ── 可回收层 ─────────────────────────────────────────── */
  junk: shared('junk', {
    what: '.DS_Store —— Finder 留下的目录元数据。',
    why: 'macOS 自动生成，和 DeepSeek Harness 完全无关。',
  }),
  sessionLock: {
    id: 'sessionLock',
    label: '会话锁文件',
    status: 'good',
    verdict: 'safe',
    icon: 'doc',
    /* 不推荐：它是 0 字节，推荐它省不出任何空间；而 Harness 正在跑的时候
       删掉某个会话的锁，等于告诉它"这个会话没人用"，两个进程会同时写同一份正文。
       留成可勾（safe），但不进默认范围 —— 风险不该由"推荐"替你决定。 */
    recommend: false,
    what: 'sessions/**/session.lock —— 每个会话目录里的一个空文件，用来标记"这个会话正被某个进程持有"。',
    why: '进程崩溃或强杀之后会留下，之后不会自动清。',
    outcome: '删掉只会让 Harness 以为那个会话没人用；会话正文不受影响。' +
      '但 Harness 正在运行时不要动它 —— 同一个会话可能被两个进程同时打开。',
  },

  /* ── 需权衡层 ─────────────────────────────────────────── */
  transcript: shared('transcript', {
    label: '会话记录',
    what: 'sessions/<工作区>/session-<id>/session.v4.jsonl.zstd —— zstd 压缩的事件流（用户/助手消息、工具调用与结果、权限决策）。',
    why: '这就是会话正文本身，`--resume` 靠它回放。',
    outcome: '删掉这个目录 = 这个会话彻底消失。注意它含读过的文件全文与命令输出，是隐私留存的主体。',
  }),
  skills: {
    id: 'skills',
    label: '技能',
    status: 'warning',
    verdict: 'review',
    icon: 'doc',
    what: 'skills/<名称>/ —— 你装或写的技能包。',
    why: 'Harness 按需加载它们；有的是远端拉的，有的是你自己写的。',
    outcome: '手写的部分删掉不可再生；远端部分可重装，但要重新配。',
  },
  profileConfig: {
    id: 'profileConfig',
    label: '运行时配置',
    status: 'warning',
    verdict: 'review',
    icon: 'gear',
    what: 'profiles/{web,headless}/ —— 每套运行形态的 cordis 配置、patch 覆盖与依赖清单。',
    why: '决定 Harness 启动时装载哪些 bundle、按什么顺序打补丁。',
    outcome: '删掉后启动会回到默认组合；你在 cordis.patch.yml 里做的覆盖会丢。',
  },
  projectionCache: {
    id: 'projectionCache',
    label: '会话投影缓存',
    status: 'good',
    verdict: 'safe',
    icon: 'box',
    recommend: true,
    what: 'storages/session_projcache/ —— 每个会话的标题、cwd 等元数据的 JSON 投影。',
    why: '列表要显示标题，但解压整条 zstd 事件流太贵，所以投影一份出来。',
    outcome: '删掉下次打开会重建；会话正文与标题都在正文文件里，不会丢。',
  },
  workspaceIndex: {
    id: 'workspaceIndex',
    label: '工作区索引',
    status: 'warning',
    verdict: 'review',
    icon: 'db',
    what: 'storages/workspace.json —— 工作区路径、会话归属、归档与置顶状态。',
    why: '会话列表的分组、归档、置顶全靠它。',
    outcome: '删掉会丢失归档与置顶状态，会话会按目录重新归组。正文不受影响。',
  },
  /* 这两档是 SHARED_RULES 产出的 id，每家都必须有对应条目，
     否则界面上那一行会显示原始 id 加兜底色（分类表查不到）。
     顺序也必须与其余四家一致：紧跟在 junk 之后、保护规则之前。 */
  configBackup: shared('configBackup', {
    what: 'config.yaml.bak、*.backup-<时间戳> 这类"改配置之前留一份"的副本。',
    why: '配置被写坏时能回滚。',
    outcome: '删掉失去回滚点。',
  }),
  dataBackup: shared('dataBackup', {
    what: 'backups/ —— 整个目录的快照。',
    why: '某个东西的完整副本，不一定是配置。',
    outcome: '删掉这些回滚点就没了。里面可能正装着你之前清理掉的文件 —— 先看一眼是什么再决定。',
  }),

  /* ── 保护层 ───────────────────────────────────────────── */
  database: shared('database', {
    what: '任何 .sqlite 及其 -wal / -shm 侧文件。',
    why: '这台机器上 ~/.dsh 眼下没有库（会话是文件），但规则留在这里是为了兜住' +
      '将来版本或插件写下的库 —— 那时整文件删等于一次抹掉。',
    outcome: '整文件删除 = 不可恢复。',
  }),
  credentials: shared('credentials', {
    label: '凭据与账号',
    what: '.credentials.yaml 与 .env —— 登录态与 `MAGPIE_GATEWAY_KEY`。',
    why: 'Harness 靠它连上游模型网关。',
    outcome: '删除后掉线，要重新登录并重填 key。',
  }),
  appConfig: shared('appConfig', {
    what: 'config.yaml —— 顶层配置。',
    why: '删掉等于把 Harness 重置回初始状态。',
  }),
  unknown: shared('unknown', {
    what: '没有命中任何已知规则的文件。',
    why: '可能是新版本 DeepSeek Harness 新增的目录，或你自己放进去的东西。',
  }),
};

/* 会话正文的目录形状：sessions/<slug>/session-<uuid>/session.v<N>.jsonl.zstd */
const SESSION_DIR = /^sessions\/[^/]+\/session-[^/]+\//;

export const RULES = [
  { id: 'junk',         test: (p) => /(^|\/)\.DS_Store$/.test(p) },

  /* 备份目录必须先于下面所有规则：它是完整副本，里面的 .sqlite 是副本不是真库。
     各家的这两条都放在同一个位置 —— 顺序不同，同一个路径就会得到不同答案。 */
  { id: 'configBackup', test: SHARED_RULES.configBackupFile },
  { id: 'dataBackup',   test: SHARED_RULES.dataBackupDir },

  // 保护优先
  { id: 'credentials',  test: (p) => p === '.credentials.yaml' || p === '.env' },
  { id: 'appConfig',    test: (p) => p === 'config.yaml' || p === '.anonymous-user-id' },
  { id: 'database',     test: (p) => /\.sqlite(-wal|-shm|-journal)?$/.test(p) },

  // 会话正文与它的锁
  { id: 'sessionLock',  test: (p) => SESSION_DIR.test(p) && p.endsWith('session.lock') },
  { id: 'transcript',   test: (p) => SESSION_DIR.test(p) },

  { id: 'projectionCache', test: (p) => p.startsWith('storages/session_projcache/') },
  { id: 'workspaceIndex',  test: (p) => p.startsWith('storages/') },
  { id: 'profileConfig',   test: (p) => p.startsWith('profiles/') },
  { id: 'skills',          test: (p) => p.startsWith('skills/') },
];

/** 会话 id 从目录名里取：sessions/<slug>/session-<uuid>/... */
export function sessionIdOf(rel) {
  const m = /^sessions\/[^/]+\/(session-[^/]+)\//.exec(rel);
  return m ? m[1] : null;
}

/**
 * "这个会话还在不在" —— 这里没有索引库可比对，所以判不了孤儿。
 *
 * workspace.json 里确实有 sessionIds，但它记录的是"界面上看得见的"，
 * 拿它当"还在不在"的判据会把所有没进列表的会话都标成孤儿。宁可放弃判定。
 */
export async function liveSessions() {
  return null;
}

export const app = {
  id: 'dsh',
  label: 'DeepSeek',
  // 会话正文是文件（zstd 压缩的 JSONL），删除走文件线
  history: 'dsh-files',
  // 前端那句会原样显示在会话面板顶部：说清"正文是什么"，以及"在这里删"
  fileBasedNote:
    '一个会话就是一个目录：<code>sessions/&lt;工作区&gt;/session-&lt;id&gt;/</code>，' +
    '正文是里面的 <code>session.v4.jsonl.zstd</code>。勾选后在<b>这里</b>清理：' +
    '先备份，再把整个会话目录（含 <code>session.lock</code>）与投影缓存一起移入废纸篓，可随时恢复。',
  processLabel: 'DeepSeek Harness',
  processes: [
    ['dsh', ['-x', 'dsh']],
    ['deepseek-harness', ['-f', 'deepseek-harness']],
  ],
  protectedDirs: [],
  targets: () => [{
    key: 'root',
    kind: 'dir',
    path: HOME(),
    label: '数据目录',
  }],
  CATEGORIES,
  RULES,
  classify: makeClassify(RULES),
  sessionIdOf,
  liveSessions,
};

export default app;
