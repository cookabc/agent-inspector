/** Cursor 会话列表与库构成。写操作分别位于 cursor-purge 和 cursor-recover。 */

import fs from 'node:fs';
import path from 'node:path';
import { openReadonly } from './sqlite-open.mjs';
import { normalizeRow, sortTasks, totalsOf } from './tasks-shape.mjs';

const DB_REL = path.join('User', 'globalStorage', 'state.vscdb');

/**
 * 从 composerHeaders.value 里取出会话标题。
 *
 * 标题不在列上，而在这一列 JSON 的 name 字段里 —— Cursor 自己起的名字
 * （实测 125 条会话里 84 条有）。取不到时退回 subtitle（"Edited a.java, b.java"
 * 这种摘要），再取不到才算无名。回退顺序是照重要程度排的：
 * name 是人能认的短标题，subtitle 是改动摘要，两者都比 UUID 好认。
 *
 * @returns {{title: string, subtitle: string}} title 为空串表示这条没有可用标题
 */
function readTitle(value) {
  if (!value) return { title: '', subtitle: '' };
  let json;
  try { json = JSON.parse(value); } catch { return { title: '', subtitle: '' }; }
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');
  return { title: clean(json.name), subtitle: clean(json.subtitle) };
}

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
 *   slashMenuItems/v7/local.glass 斜杠分段、点号只在最后一段 —— 斜杠必须先判，
 *                                 否则会切出 slashMenuItems/v7/local 这种半截名字
 *   composer.content.<sha256>     点号分隔。这一串本身没有冒号，只按冒号切会把
 *                                 每个 hash 当成一族（实测 766 族，构成图长 19000px）
 *
 * 用 SQL 算而不是取回来再切：GROUP BY 要在库里完成，几万行不该搬进进程。
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
      scanMs: 0, problems: [`找不到 ${DB_REL}`] };
  }

  const db = openReadonly(dbPath);
  if (!db) {
    return { tasks: [], totals: totalsOf([]), composition: [], db: sizes(idePath),
      scanMs: 0, problems: ['state.vscdb 打不开（只读）'] };
  }

  try {
    // 1) 会话头
    let headers = [];
    try {
      headers = db.prepare(`
        SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value
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
    let unnamed = 0;
    for (const h of headers) {
      const g = bodies.get(h.composerId) || { bubbles: 0, bubbleBytes: 0, checkpoints: 0, checkpointBytes: 0 };
      seen.add(h.composerId);
      // 工作区 UUID 能还原成路径就用路径（和其它工具同一种语言），否则保留 UUID
      const folder = folders?.get(h.workspaceId) || '';
      const { title, subtitle } = readTitle(h.value);
      // 没有标题的会话用 UUID 占位 —— 但不能假装它和别的会话一样，
      // 下面把条数报给前端，让界面主动说一句"这几条 Cursor 没起名"。
      if (!title && !subtitle) unnamed++;
      tasks.push(normalizeRow({
        id: h.composerId,
        title: title || subtitle || `（无标题）${short(h.composerId)}`,
        workspace: folder || h.workspaceId || '',
        state: h.isArchived ? 'archived' : 'active',
        /* 归档的照旧可清理；活跃的也给一个 reason —— 别的工具只在"界面已删"
           时才给，那是因为它们按索引行删，删活跃会话会留下指向不存在线程的壳。
           Cursor 不一样：它按可达性分析删，删一条活跃会话是自洽的
           （会话行连同只被它引用的工具结果一起消失）。用户明确勾哪一条，
           就是在明确说"这段对话我不要了" —— 不给勾选反而是替人做主。 */
        reason: h.isArchived ? 'archived' : 'manual',
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
      totals: totalsOf(tasks),
      // 有几条会话 Cursor 自己也没起名（value 里既没有 name 也没有 subtitle）。
      // 报上去让界面明说，而不是让一堆 UUID 混在正常标题里冒充内容。
      untitled: unnamed,
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
