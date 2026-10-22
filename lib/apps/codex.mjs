/**
 * Codex（~/.codex）的分类学。
 *
 * 两条线都有：会话正文既落在 sessions/YYYY/MM/DD/rollout-<时间>-<thread id>.jsonl，
 * 又投影进 thread_history_1.sqlite 的 thread_items（新版分页历史）；
 * 线程索引在 state_5.sqlite 的 threads 表，带 rollout_path 与 archived 标记。
 *
 * 所以"界面里删掉的会话"在这里有两种残留：threads 行没了但 jsonl 还在（纯文件问题），
 * 以及 threads.archived=1 的归档线程（还能看，只是不在主列表）。
 *
 * 另有一个纯粹占地方的大头：packages/app-server-daemon/releases/ 里堆的旧版本运行时，
 * current 软链接指着的那个在用，其余的历史版本可以删 —— 扫描时按 current 解析结果标记。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openReadonly } from '../sqlite-open.mjs';
import { makeClassify, SHARED_RULES } from './common.mjs';
import { shared } from './taxonomy.mjs';

const HOME = () => path.join(os.homedir(), '.codex');

/** rollout 文件名里的 thread id（26 位 ULID 或标准 uuid 都行）。 */
const ROLLOUT_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?\.jsonl$/;

/**
 * 读 rollout 文件首行的元信息，判断它是不是"分页续段"。
 *
 * 新版 Codex 在上下文压缩后会把后续轮次写进**新文件**，并在首行留下
 * `history_base.end_ordinal_exclusive` —— 意思是"我从第 N 个 ordinal 起接，
 * 前面那段在另一个文件里"。实测两个真实样本：
 *
 *   首 ordinal=0    → 原始文件，history_base 缺省，删它只毁这一条会话
 *   首 ordinal=4990 → 续段，history_base.end_ordinal_exclusive=4990
 *
 * 续段被删的后果与普通正文不同：整条会话再也恢复不了，而且报错是
 * "missing source rollout" —— 看起来像别的地方坏了，很难联想到是自己删了个文件。
 *
 * 只读第一行，最多 64KB。读不到或解析失败返回 null（判不了就不判）。
 *
 * @returns {{continuation:boolean, endOrdinal:number|null, mode:string|null}|null}
 */
export function rolloutLineage(absPath) {
  let fd;
  try {
    fd = fsSync.openSync(absPath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fsSync.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    const first = nl < 0 ? text : text.slice(0, nl);
    const obj = JSON.parse(first);
    const p = obj.payload || obj;
    const hb = p.history_base || null;
    const endOrdinal = hb && Number.isFinite(hb.end_ordinal_exclusive) ? hb.end_ordinal_exclusive : null;
    return {
      continuation: endOrdinal != null && endOrdinal > 0,
      endOrdinal,
      mode: p.history_mode || null,
    };
  } catch {
    return null;
  } finally {
    try { if (fd !== undefined) fsSync.closeSync(fd); } catch {}
  }
}

/**
 * 安全语义来自共享本体（taxonomy.mjs），这里只写 Codex 自己说得出细节的部分。
 */
export const CATEGORIES = {
  /* ── 可回收层 ─────────────────────────────────────────── */
  cache: shared('cache', {
    what: '模型目录、远端插件目录、技能清单等拉取缓存（cache/、vendor_imports/、models_cache.json）。',
    why: '为加速而留下的远端副本。',
  }),
  temp: {
    id: 'temp',
    label: '临时目录',
    status: 'good',
    verdict: 'safe',
    icon: 'trash',
    recommend: true,
    what: 'tmp/ 与 .tmp/ 下的临时工作副本（含 .tmp/git-* 这类一次性 git 沙箱）。',
    why: '会话里随手落盘的中间产物，工具按设计可以丢。',
    outcome: '进行中的会话可能正靠某个临时目录跑东西；空闲时删没有长期影响。里面也可能有你自己在会话里留下的文件，删前扫一眼名字。',
  },
  shellSnapshot: shared('shellSnapshot', {
    what: 'shell_snapshots/ —— 每次执行命令前对 shell 环境打的快照。',
    why: '让命令跑起来像在你的交互终端里。',
  }),
  appLog: shared('appLog', {
    what: 'log/ 里的运行日志（不含 logs_2.sqlite，那个归到数据库）。',
    why: '排障用。',
  }),
  junk: shared('junk', {
    what: '.DS_Store 与 .lock / .stamp 这类空标记文件。',
    why: 'macOS 与进程锁留下的痕迹。',
    outcome: '会被再次生成；锁文件在进程退出后本就该消失。',
  }),
  oldRelease: {
    id: 'oldRelease',
    label: '旧版本运行时',
    status: 'serious',
    verdict: 'safe',
    icon: 'box',
    recommend: true,
    // 默认排除：判定靠 current 软链接，解析不到时不标这一类；
    // 而且它体积大（每个版本约几百 MB～1 GB），值得单独看一眼再删。
    recommendDefaultOff: true,
    what: 'packages/app-server-daemon/releases/ 里除 current 指向之外的历史版本，以及 plugins/.plugin-appserver 下的历史 CLI。',
    why: '自动更新每装一个版本就留一份，旧版本没人清 —— 这台机器上 1.9 GB 里有大半是历史版本。',
    outcome: '只丢旧版本的可执行文件，current 指向的那份不动；升级不会退回旧版本。删前确认没有进程还从旧版本跑着。',
  },

  /* ── 需权衡层 ─────────────────────────────────────────── */
  transcript: shared('transcript', {
    what: 'sessions/YYYY/MM/DD/rollout-*.jsonl —— 每条会话的完整逐轮记录（含工具输出与读过的文件内容）。',
    why: '这是 Codex 的会话正文本身，历史回放与 --resume 靠它。',
    outcome: '删掉后：界面里这条会话再也回不来；threads 索引行如果还在会指向一个不存在的文件。若这条会话在索引里已经不存在（标记为「界面已删」），那它已经是残骸。',
  }),
  archivedSession: {
    id: 'archivedSession',
    label: '归档会话正文',
    status: 'warning',
    verdict: 'review',
    icon: 'doc',
    what: 'archived_sessions/ 下的 rollout-*.jsonl —— 被归档（不是删除）的会话正文。',
    why: '归档只是从主列表移走，正文原样保留。',
    outcome: '删掉后这条归档会话不可恢复，也无法再取消归档继续聊。',
  },
  /* 分页历史的**续段**：首行带 history_base，说明它只是会话的一段。
     和 transcript 分开一档，是因为删它的后果重得多 ——
     删掉整条会话回不来，而且报错是"missing source rollout"，
     看起来像别处坏了，很难联想到自己删了个文件。 */
  transcriptSegment: {
    id: 'transcriptSegment',
    label: '会话正文（分页续段）',
    status: 'serious',
    verdict: 'never',
    icon: 'doc',
    locked: true,
    what: 'sessions/ 下首行带 <code>history_base</code> 的 rollout-*.jsonl —— ' +
      '它是长会话被上下文压缩切开后的**一段**，前面还有别的文件。',
    why: '新版 Codex 压缩上下文后把后续轮次写进新文件，用 history_base 指回前一段。',
    outcome: '删掉这段 = 整条会话再也恢复不了（恢复时会报 missing source rollout）。' +
      '要清这条会话，请走「会话管理」按会话删，那里会连索引一起处理。',
  },
  memories: shared('memories', {
    what: 'memories/、memories_v2/ —— 跨会话沉淀的记忆条目（各自是 git 仓库，含 rollout_summaries）。',
    why: '每次开工会读，是"这个工具记住了什么"的载体。',
    outcome: '删掉不可再生，之后的会话会忘记这些结论。两个版本目录是升级留下的，v1 通常已无用 —— 但请先确认。',
  }),
  artifacts: shared('artifacts', {
    what: 'generated_images/、visualizations/、attachments/ —— 会话里生成的图片、可视化与粘贴附件。',
    why: '这是你的产出物与素材，不是缓存。',
    outcome: '删掉不可恢复。attachments 里是你粘贴过的原文，可能含敏感内容。',
  }),
  dictation: {
    id: 'dictation',
    label: '语音输入历史',
    status: 'warning',
    verdict: 'review',
    icon: 'doc',
    what: 'dictation-history/ —— 语音转文字的原始音频与结果缓存。',
    why: '为了重复听写与纠错留下的本地副本。',
    outcome: '删掉后无法回看那几次听写原文。含你的声音，隐私敏感度高于普通日志。',
  },
  pluginMarket: shared('pluginMarket', {
    label: '插件市场副本',   // Codex 的市场是拉取副本，不是 git 克隆
    what: '.tmp/bundled-marketplaces、.tmp/marketplaces —— 内置与拉取的市场仓库副本。',
    why: '从远端或发行包里复制过来的副本。',
    outcome: '可重新拉取，但内置市场可能要等下次同步才回来。',
  }),
  runtime: shared('runtime', {
    label: '运行期状态与锁',   // Codex 的运行期目录里锁文件占重要一部分
    what: 'ipc/、app-server-control/、app-server-daemon/、node_repl/、*-locks/、browser/、computer-use/、tui-thread-reference-capabilities/。',
    why: '本地服务、套接字、锁、桌面自动化与浏览器会话的运行期落点。',
    outcome: 'Codex 正在运行时删会打断它（套接字/锁没了）；空闲时多数会重建。computer-use 里是辅助程序本体，删了该功能不可用。',
  }),
  userContent: shared('userContent', {
    what: 'skills/、pets/、AGENTS.md —— 你写的技能、宠物与全局指令。',
    why: '手写内容，工具不会再生成。',
    outcome: '删掉不可再生。AGENTS.md 是全局指令，影响每一次会话。',
  }),

  /* ── 保护层 ─────────────────────────────────────────── */
  database: shared('database', {
    label: '索引与历史库',
    what: 'state_5.sqlite（线程索引）、thread_history_*.sqlite（投影后的逐轮条目）、logs_2.sqlite（结构化日志）、queue_1.sqlite、memories_*.sqlite、sqlite/codex-dev.db，含 -wal / -shm。',
    why: 'Codex 的会话索引与历史投影全在这里，删一个文件等于抹掉整段历史。',
    outcome: '整文件删除 = 不可恢复。要清请走「历史任务」，按线程粒度删，并且先备份。',
  }),
  credentials: shared('credentials', {
    what: 'auth.json —— 登录得到的 OAuth 凭据。',
    why: 'Codex 靠它调用模型。',
  }),
  appConfig: shared('appConfig', {
    what: 'config.toml（模型、审批模式、provider）、rules/、.codex-global-state.json（含 .bak）、version.json、chrome-native-hosts*.json。',
    why: '删掉等于把 Codex 重置回初始状态。',
    outcome: '需要从头重配模型、审批策略与自定义规则。',
  }),
  pluginData: shared('pluginData', {
    what: 'plugins/ 下除缓存与历史 CLI 之外的内容。',
    why: '插件运行时写下的状态，不是可重建的缓存。',
    outcome: '删掉后插件可能要重装，或丢失自身数据。',
  }),
  promptHistory: shared('promptHistory', {
    what: 'history.jsonl —— 你敲进输入框的提示历史；session_index.jsonl 与 external_agent_session_imports.json 是会话清单的导入/导出记录。',
    why: '上下键回翻历史输入靠它。',
  }),
  configBackup: shared('configBackup', {
    what: 'config.toml.*.bak 这类改动前留下的旧配置副本。',
    why: '配置被写坏时能回滚 —— 多半是别的工具（如 AI 工具箱）替你存的。',
  }),
  dataBackup: shared('dataBackup', {
    what: 'backups/<项目>/<动作>-<时间戳>/ —— 完整数据副本，实测这里装着 40+ MB 的项目 zip 与校验清单。',
    why: '别的工具（如 AI 工具箱）在批量改文件之前整批存的一份，不归 Codex 管。',
    outcome: '删掉这些回滚点就没了；但里面的内容不属于 Codex —— 先看清是哪次操作留下的副本再决定。',
  }),
  unknown: shared('unknown', {
    what: '没有命中任何已知规则的文件。',
    why: '可能是新版本 Codex 新增的目录，或你自己放进去的东西。',
  }),
};

export const RULES = [
  { id: 'junk',         test: (p) => /(^|\/)\.DS_Store$/.test(p) || /(^|\/)[^/]+\.(lock|stamp)$/.test(p) || p === '.sandbox_migration' },

  /* 备份目录必须先于下面所有规则：它是完整副本，里面的 .sqlite 是副本不是真库。
     各家的这两条都放在同一个位置 —— 顺序不同，同一个路径就会得到不同答案。 */
  { id: 'configBackup', test: SHARED_RULES.configBackupFile },
  { id: 'dataBackup',   test: SHARED_RULES.dataBackupDir },

  // 保护优先
  { id: 'credentials',  test: (p) => p === 'auth.json' },
  { id: 'appConfig',    test: (p) => p === 'config.toml' || p.startsWith('rules/') ||
                                     /^\.codex-global-state\.json(\.bak)?$/.test(p) ||
                                     p === 'version.json' || /^chrome-native-hosts/.test(p) },
  { id: 'database',     test: (p) => /\.sqlite(-wal|-shm)?$/.test(p) || p.startsWith('sqlite/') ||
                                     /^(session_index|external_agent_session_imports)\.jsonl?$/.test(p) },
  { id: 'appConfig',    test: (p) => p === 'keybindings.json' || p === 'chrome-native-hosts.json' },

  // 会话正文
  { id: 'archivedSession', test: (p) => p.startsWith('archived_sessions/') },
  { id: 'transcript',      test: (p) => p.startsWith('sessions/') },

  { id: 'memories',     test: (p) => /^memories(_v2)?\//.test(p) },
  { id: 'artifacts',    test: (p) => /^(generated_images|visualizations|attachments)\//.test(p) },
  { id: 'dictation',    test: (p) => p.startsWith('dictation-history/') },
  { id: 'pluginMarket', test: (p) => /^\.tmp\/(bundled-)?marketplaces\//.test(p) },
  { id: 'shellSnapshot',test: (p) => /^(shell_snapshots|shell-snapshots)\//.test(p) },
  { id: 'cache',        test: (p) => /^(cache|vendor_imports)\//.test(p) || p === 'models_cache.json' ||
                                     p.startsWith('plugins/cache/') },
  { id: 'temp',         test: (p) => /^(tmp|\.tmp)\//.test(p) || /^\.git-/.test(p) },
  { id: 'appLog',       test: (p) => p.startsWith('log/') },
  { id: 'promptHistory', test: (p) => p === 'history.jsonl' },
  { id: 'dictation',     test: (p) => p === 'transcription-history.jsonl' },
  { id: 'runtime',       test: (p) => /^packages\/app-server-daemon\/(current|auto-update-version)$/.test(p) || p === 'installation_id' },
  { id: 'runtime',      test: (p) => p.startsWith('packages/app-server-daemon/releases/') ||
                                     p.startsWith('plugins/.plugin-appserver/') },
  { id: 'runtime',      test: (p) => /^(ipc|app-server-control|app-server-daemon|node_repl|browser|computer-use|code-review-plugin|tui-thread-reference-capabilities)\//.test(p) ||
                                     /^(project-metadata|thread-writer|mcp-oauth)-locks\//.test(p) },
  { id: 'pluginData',   test: (p) => p.startsWith('plugins/') },
  { id: 'userContent',  test: (p) => /^(skills|pets|commands|agents)\//.test(p) || p === 'AGENTS.md' },
];

export function sessionIdOf(rel) {
  const m = ROLLOUT_ID.exec(rel.split('/').pop() || '');
  return m ? m[1] : null;
}

/**
 * 线程索引里还活着的 thread id（archived 也算"在"，只是不在主列表）。
 * 读不到就返回 null —— 判不了就不判孤儿，别把全部会话标成可清理。
 */
export async function liveSessions(root) {
  const db = await openReadonly(path.join(root, 'state_5.sqlite'));
  if (!db) return null;
  try {
    return new Set(db.prepare('SELECT id FROM threads').all().map((r) => r.id));
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * 找出"历史版本运行时"目录：current 软链接没指着的那些 releases。
 * 解析不到 current 时返回空 —— 宁可少标一类，也不误把在用的版本标成可删。
 */
export async function staleDirs(root) {
  const base = path.join(root, 'packages', 'app-server-daemon');
  let target;
  try {
    target = await fs.realpath(path.join(base, 'current'));
    const releases = await fs.realpath(path.join(base, 'releases'));
    if (path.dirname(target) !== releases || !(await fs.stat(target)).isDirectory()) return [];
  } catch { return []; }
  const currentName = path.basename(target);
  const out = [];
  let entries;
  try { entries = await fs.readdir(path.join(base, 'releases'), { withFileTypes: true }); }
  catch { return []; }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== currentName) {
      out.push(`packages/app-server-daemon/releases/${e.name}`);
    }
  }
  return out;
}

export const app = {
  id: 'codex',
  label: 'Codex',
  history: 'codex-db',
  processLabel: 'Codex',
  processes: [
    ['Codex', ['-x', 'Codex']],
    ['codex', ['-x', 'codex']],
    ['codex-app-server', ['-f', 'codex-app-server']],
    ['codex-code-mode-host', ['-f', 'codex-code-mode-host']],
    ['codex-mcp', ['-f', 'codex-mcp']],
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

  /**
   * 光看路径判不出"这个 rollout 是原始段还是分页续段"，得读首行。
   * scan.mjs 在 entry() 里调它，把已经是 transcript / archivedSession 的那些再细分。
   *
   * 为什么值得单独一档：续段被删，整条会话永久不可恢复，而报错是
   * "missing source rollout" —— 看起来像别处坏了，很难联想到自己删了个文件。
   * 所以它锁成"请勿删除"，要清就走会话面板（那边会连索引一起处理）。
   */
  refineCategory(rel, abs, current) {
    if (current !== 'transcript' && current !== 'archivedSession') return undefined;
    const l = rolloutLineage(abs);
    if (l?.continuation) return 'transcriptSegment';
    return undefined;
  },

  sessionIdOf,
  liveSessions,
  staleDirs,
};

export default app;
