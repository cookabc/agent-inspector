/**
 * Cursor 的历史会话：只读分析，不提供按行删除。
 *
 * 聊天正文在 ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb：
 *   composerHeaders   界面可见的会话头（48 条这种量级）
 *   cursorDiskKV      key/value 大仓 —— bubbleId:<会话>:<气泡>、checkpointId:<会话>:<检查点>、
 *                     composer.data:<会话>、agentKv:blob:<内容哈希>
 *
 * 有意思的地方在这儿：气泡按会话 id 分组之后，有些组在 composerHeaders 里**已经没有对应行了** ——
 * 那正是"界面里删掉了、正文还留在磁盘上"。这个面板把它算出来给你看。
 *
 * 但清理不从这里做：这份库由 IDE 独占写入，key 之间没有外键关系可依（value 是 JSON blob，
 * 删一条气泡不会级联删检查点，反过来也是），而且库里有正在运行的窗口状态。
 * 所以要清得在 Cursor 界面里删会话；整库回收只有备份后重建 state.vscdb 这一条路，
 * 那是 IDE 自己的事，不是这个工具该替你按下的按钮。
 *
 * 唯一的例外在 lib/cursor-recover.mjs：界面里看不到、transcript 文件还在的会话可以
 * **只新增地回灌**（不删、不覆盖）。那是另一条独立路径，不改变这里的只读口径。
 */

import fs from 'node:fs';
import path from 'node:path';
import { openReadonly } from './sqlite-open.mjs';
import { normalizeRow, sortTasks, totalsOf } from './tasks-shape.mjs';

const DB_REL = path.join('User', 'globalStorage', 'state.vscdb');

/** 前端只读警示条直接引用：理由由适配器给，不在前端按 app 名硬编码。 */
export const READ_ONLY_NOTE =
  'Cursor 的会话正文以键值对存在 state.vscdb 里，由 IDE 独占写入，键之间没有外键可依。' +
  '要清会话请在 Cursor 界面里删 —— 这里不代按，也不给勾选。' +
  '界面里看不到、transcript 还在的会话可以在下方单独回灌：只新增、不覆盖任何已有会话。';

const FAMILY_LABEL = {
  bubbleId: '对话气泡（会话正文）',
  checkpointId: '检查点（文件快照）',
  composerData: '会话元数据',
  composer: '会话内容块（内容寻址）',
  agentKv: '内容寻址 blob（工具结果/文件片段）',
  slashMenuItems: '斜杠菜单项',
};

/**
 * 族名取到第一个分隔符为止。三种写法都要认，优先级 冒号 → 斜杠 → 点号：
 *   bubbleId:<uuid>:<id>          冒号分隔
 *   slashMenuItems/v7/local.glass 斜杠分段、点号只在最后一段 —— 斜杠必须先判
 *   composer.content.<sha256>     点号分隔。这一串本身没有冒号，只按冒号切会把
 *                                 每个 hash 当成一族（实测 766 族，构成图长 19000px）
 */
const FAMILY_EXPR = `CASE
  WHEN instr(key, ':') > 0 THEN substr(key, 1, instr(key, ':') - 1)
  WHEN instr(key, '/') > 0 THEN substr(key, 1, instr(key, '/') - 1)
  WHEN instr(key, '.') > 0 THEN substr(key, 1, instr(key, '.') - 1)
  ELSE key
END`;

/**
 * @param {string} idePath App Support/Cursor
 * @param {Map<string,string>} [folders] workspaceId → 文件夹绝对路径的反查表（见 apps/cursor.mjs）。
 *   传了就把不透明 UUID 还原成路径，让按项目横切能归并 Cursor 的会话；映不上的保留 UUID。
 */
export function scanTasks(idePath, folders = null) {
  const t0 = Date.now();
  const dbPath = path.join(idePath, DB_REL);
  const problems = [];

  if (!fs.existsSync(dbPath)) {
    return { tasks: [], totals: totalsOf([]), composition: [], db: sizes(idePath),
      readOnlyNote: READ_ONLY_NOTE, scanMs: 0, problems: [`找不到 ${DB_REL}`] };
  }

  const db = openReadonly(dbPath);
  if (!db) {
    return { tasks: [], totals: totalsOf([]), composition: [], db: sizes(idePath),
      readOnlyNote: READ_ONLY_NOTE, scanMs: 0, problems: ['state.vscdb 打不开（只读）'] };
  }

  try {
    // 1) 会话头
    let headers = [];
    try {
      headers = db.prepare(`
        SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency
        FROM composerHeaders
      `).all();
    } catch (err) { problems.push(`composerHeaders 读不出来：${err.message}`); }

    // 2) 气泡/检查点按会话聚合。bubbleId:<36位会话id>:<气泡id>
    const bodies = new Map();
    for (const [prefix, kind] of [['bubbleId:', 'bubble'], ['checkpointId:', 'checkpoint']]) {
      const off = prefix.length + 1;
      // 前缀里没有 % 和 _，不需要 LIKE 转义
      try {
        for (const r of db.prepare(`
          SELECT substr(key, ${off}, 36) cid, count(*) n, sum(octet_length(value)) b
          FROM cursorDiskKV WHERE key LIKE ? GROUP BY cid
        `).all(prefix + '%')) {
          const g = bodies.get(r.cid) || { bubbles: 0, bubbleBytes: 0, checkpoints: 0, checkpointBytes: 0 };
          if (kind === 'bubble') { g.bubbles = r.n; g.bubbleBytes = r.b || 0; }
          else { g.checkpoints = r.n; g.checkpointBytes = r.b || 0; }
          bodies.set(r.cid, g);
        }
      } catch (err) { problems.push(`${prefix} 聚合失败：${err.message}`); }
    }

    const tasks = [];
    const seen = new Set();
    for (const h of headers) {
      const g = bodies.get(h.composerId) || { bubbles: 0, bubbleBytes: 0, checkpoints: 0, checkpointBytes: 0 };
      seen.add(h.composerId);
      // 工作区 UUID 能还原成路径就用路径（和其它工具同一种语言），否则保留 UUID
      const folder = folders?.get(h.workspaceId) || '';
      tasks.push(normalizeRow({
        id: h.composerId,
        title: `会话 ${short(h.composerId)} · ${folder || h.workspaceId || '无工作区'}`,
        workspace: folder || h.workspaceId || '',
        state: h.isArchived ? 'archived' : 'active',
        reason: h.isArchived ? 'archived' : null,
        typeLabel: h.isSubagent ? '子 Agent' : '对话',
        createdAt: h.createdAt || 0,
        updatedAt: h.lastUpdatedAt || h.recency || 0,
        // 正文在库里，不在文件里
        bytes: g.bubbleBytes,
        rows: g.bubbles,
        children: g.checkpoints,
      }));
    }

    // 3) 界面里已经没有这条会话，正文还留在库里
    for (const [cid, g] of bodies) {
      if (seen.has(cid)) continue;
      tasks.push(normalizeRow({
        id: cid,
        title: `（界面里已经看不到）${short(cid)}`,
        workspace: '',
        state: 'untracked',
        reason: 'untracked',
        typeLabel: '库内残骸',
        bytes: g.bubbleBytes,
        rows: g.bubbles,
        children: g.checkpoints,
        residual: true,
      }));
    }

    sortTasks(tasks);

    // 4) 整库构成
    const composition = [];
    let kvTotal = 0;
    try {
      for (const r of db.prepare(`
        SELECT ${FAMILY_EXPR} fam, count(*) n, sum(octet_length(value)) b
        FROM cursorDiskKV GROUP BY fam ORDER BY b DESC
      `).all()) {
        composition.push({ table: 'cursorDiskKV', family: r.fam, label: FAMILY_LABEL[r.fam] || r.fam, count: r.n, bytes: r.b || 0 });
        kvTotal += r.b || 0;
      }
    } catch (err) { problems.push(`cursorDiskKV 分组失败：${err.message}`); }
    try {
      const item = db.prepare('SELECT count(*) n, sum(octet_length(value)) b FROM ItemTable').get();
      composition.push({ table: 'ItemTable', family: '', label: '界面状态与设置快照', count: item.n, bytes: item.b || 0 });
    } catch { /* 表可能不存在 */ }

    return {
      tasks,
      // 只读文案由适配器给；readOnly 这个布尔位由路由器按 app.writable 单源产出
      readOnlyNote: READ_ONLY_NOTE,
      totals: totalsOf(tasks),
      composition: [{ table: 'kvTotal', family: '', label: 'cursorDiskKV 合计', count: null, bytes: kvTotal }, ...composition],
      db: { ...sizes(idePath), kvTotal, headerCount: headers.length, bodyGroups: bodies.size },
      scanMs: Date.now() - t0,
      problems,
    };
  } finally {
    db.close();
  }
}

function sizes(idePath) {
  const info = (rel) => {
    try { const st = fs.statSync(path.join(idePath, rel)); return { path: path.join(idePath, rel), bytes: st.size, mtime: st.mtimeMs }; }
    catch { return { path: path.join(idePath, rel), bytes: 0, mtime: 0 }; }
  };
  const main = info(DB_REL);
  const wal = info(`${DB_REL}-wal`);
  const shm = info(`${DB_REL}-shm`);
  const search = info(path.join('User', 'globalStorage', 'conversation-search.db'));
  let free = null;
  try { const s = fs.statfsSync(idePath); free = s.bavail * s.bsize; } catch {}
  return { dbs: [{ name: 'state.vscdb', role: 'chat', ...main }, { name: 'conversation-search.db', role: 'index', ...search }],
    main, wal, shm, total: main.bytes + wal.bytes, free };
}

function short(id) {
  return String(id).slice(0, 8);
}
