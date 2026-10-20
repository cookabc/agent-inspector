/**
 * ZCode 的历史任务：读取与清理。
 *
 * ZCode 把会话正文放在 cli/db/db.sqlite（message / part 两张表撑起 1.4 GB），
 * 把任务元数据放在 v2/tasks-index.sqlite。两边靠 task_id === session.id 关联。
 *
 * 关键点：ZCode 界面上"删除任务"只是把 tasks.deleted 置 1（软删除）——
 * 正文一行没少。所以界面上看不见的任务，仍然实打实占着磁盘。
 *
 * 删除时必须显式 PRAGMA foreign_keys=ON。SQLite 的这个开关是"每连接"的，
 * 默认关闭，不打开的话 message/part 的 on delete cascade 根本不会触发，
 * 删完会留下一堆孤儿行，空间一点都回收不了。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadonly, openReadonlyOrThrow } from './sqlite-open.mjs';
import { normalizeRow, sortTasks, totalsOf } from './tasks-shape.mjs';

const MAIN = (root) => path.join(root, 'cli', 'db', 'db.sqlite');
const INDEX = (root) => path.join(root, 'v2', 'tasks-index.sqlite');
const SIDECARS = (p) => [p, `${p}-wal`, `${p}-shm`];

/** 会话类型的中文说明。 */
const TYPE_LABEL = {
  interactive: '对话',
  fork: '分叉',
  selection_side_chat: '划词追问',
  subagent_child: '子 Agent',
  workflow_child: '工作流',
};


/* ── 只读扫描 ─────────────────────────────────────────────── */

/**
 * 把每个顶层会话连同它的全部后代会话汇总成一条任务记录。
 * 只读打开两个库，绝不写。
 */
export function scanTasks(root) {
  const main = MAIN(root);
  const index = INDEX(root);
  const t0 = Date.now();

  if (!fs.existsSync(main)) {
    return { tasks: [], totals: totalsOf([]), db: dbInfo(root), problems: ['找不到 db.sqlite'], scanMs: Date.now() - t0 };
  }

  const db = openReadonly(main);
  if (!db) {
    return { tasks: [], totals: totalsOf([]), db: dbInfo(root), problems: ['db.sqlite 打不开（只读）'], scanMs: Date.now() - t0 };
  }
  let roots;
  try {

    // octet_length 直接取字节数，不解码 UTF-8；在大库上比 length() 快十几倍
    // （实测 346ms vs 6014ms）。老版本 SQLite 没有它，退回 length()。
    let LEN = 'octet_length';
    try { db.prepare('SELECT octet_length(?) x').get('a'); }
    catch { LEN = 'length'; }

    // 一次算完：每个顶层会话 + 全部后代 的文本字节数与行数
    roots = db.prepare(`
      WITH RECURSIVE
        sz AS (
          SELECT s.id,
                 coalesce(m.mb, 0) + coalesce(p.pb, 0) AS bytes,
                 coalesce(m.n, 0) + coalesce(p.n, 0)   AS rows
          FROM session s
          LEFT JOIN (SELECT session_id, sum(${LEN}(data)) mb, count(*) n FROM message GROUP BY session_id) m ON m.session_id = s.id
          LEFT JOIN (SELECT session_id, sum(${LEN}(data)) pb, count(*) n FROM part    GROUP BY session_id) p ON p.session_id = s.id
        ),
        tree(root, id) AS (
          SELECT id, id FROM session WHERE parent_id IS NULL OR parent_id = ''
          UNION ALL
          SELECT t.root, c.id FROM session c JOIN tree t ON c.parent_id = t.id
        ),
        agg AS (
          SELECT tree.root, sum(sz.bytes) AS bytes, sum(sz.rows) AS rows, count(*) - 1 AS kids
          FROM tree JOIN sz ON sz.id = tree.id GROUP BY tree.root
        )
      SELECT agg.root AS id, agg.bytes, agg.rows, agg.kids,
             s.title, s.directory, s.time_created, s.time_updated, s.task_type
      FROM agg JOIN session s ON s.id = agg.root
    `).all();
  } finally {
    db.close();
  }

  // 任务索引里的元数据
  const meta = new Map();
  if (fs.existsSync(index)) {
    const ti = openReadonlyOrThrow(index);
    try {
      for (const r of ti.prepare(`
        SELECT task_id, title, workspace_path, archived, deleted, pinned,
               created_at, updated_at, model
        FROM tasks
      `).all()) meta.set(r.task_id, r);
    } finally { ti.close(); }
  }

  const tasks = sortTasks(roots.map((r) => {
    const m = meta.get(r.id);
    const state = !m ? 'untracked'
      : m.deleted ? 'deleted'
      : m.archived ? 'archived'
      : 'active';
    return normalizeRow({
      id: r.id,
      title: (m?.title || r.title || '(无标题)').trim() || '(无标题)',
      workspace: m?.workspace_path || r.directory || '',
      state,
      // 可清理的原因，前端据此标注。null 表示当前不可清理。
      reason: deleteReason(state, m, r),
      pinned: !!m?.pinned,
      model: m?.model || '',
      typeLabel: TYPE_LABEL[r.task_type] || r.task_type,
      createdAt: m?.created_at || r.time_created,
      updatedAt: m?.updated_at || r.time_updated,
      bytes: r.bytes || 0,
      rows: r.rows || 0,
      children: r.kids || 0,
    });
  }));

  return {
    tasks,
    totals: totalsOf(tasks),
    db: dbInfo(root),
    scanMs: Date.now() - t0,
    problems: [],
  };
}

export function dbInfo(root) {
  const info = (p) => {
    try {
      const st = fs.statSync(p);
      return { path: p, bytes: st.size, mtime: st.mtimeMs };
    } catch { return { path: p, bytes: 0, mtime: 0 }; }
  };
  const main = info(MAIN(root));
  const index = info(INDEX(root));
  return {
    // dbs 是五个工具共用的那份清单（前端"在文件清单中定位"按它走），
    // main/index 是本家自有的附加字段，保留。
    dbs: [{ name: 'db.sqlite', role: 'chat', ...main },
          { name: 'tasks-index.sqlite', role: 'index', ...index }],
    main, index,
    total: main.bytes + index.bytes,
    free: freeBytes(path.dirname(main.path)),
  };
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

/* ── 清理 ─────────────────────────────────────────────────── */

const COUNTED_TABLES = [
  ['session', 'id'], ['message', 'session_id'], ['part', 'session_id'],
  ['model_usage', 'session_id'], ['turn_usage', 'session_id'], ['tool_usage', 'session_id'],
  ['todo', 'session_id'], ['session_entry', 'session_id'], ['session_input', 'session_id'],
  ['session_target', 'session_id'], ['session_task_link', 'child_session_id'],
  ['input_history', 'session_id'],
];

/** 递归 CTE：选中的顶层会话 + 它们的全部后代。 */
function targetsCte(ids) {
  const values = ids.map(() => '(?)').join(',');
  return `WITH RECURSIVE roots(id) AS (VALUES ${values}),
    d(id) AS (SELECT id FROM roots UNION SELECT s.id FROM session s JOIN d ON s.parent_id = d.id)`;
}

/**
 * 空跑：只用只读连接做 COUNT，不建临时表、不开事务、不加任何写锁。
 * 这样即使 ZCode 正开着，预览也是绝对安全的。
 */
export function previewPurge(root, ids) {
  if (!Array.isArray(ids) || !ids.length) throw httpErr(400, '没有选中任何任务');
  const main = MAIN(root);
  const index = INDEX(root);
  if (!fs.existsSync(main)) throw httpErr(500, '找不到 db.sqlite');

  const db = openReadonlyOrThrow(main);
  try {
    const cte = targetsCte(ids);
    const selects = COUNTED_TABLES.map(([t, col], i) =>
      `(SELECT count(*) FROM ${t} WHERE ${col} IN (SELECT id FROM d)) AS c${i}`).join(', ');
    const row = db.prepare(`${cte} SELECT ${selects}`).get(...ids);

    // 与 Codex 同一套形状：逐库逐表列出会删掉的行。
    // 任务索引里的条目真删时也会一起清掉，不报出来就是报少了一截。
    const perDb = [];
    COUNTED_TABLES.forEach(([table], i) => {
      if (row[`c${i}`]) perDb.push({ name: 'db.sqlite', table, count: row[`c${i}`] });
    });
    if (fs.existsSync(index)) {
      const ti = openReadonly(index);
      if (ti) {
        try {
          const q = ids.map(() => '?').join(',');
          for (const [table, col] of [
            ['tasks', 'task_id'], ['task_group_members', 'task_id'],
            ['off_peak_tasks', 'session_id'], ['automation_runs', 'session_id'],
          ]) {
            try {
              const n = ti.prepare(`SELECT count(*) c FROM ${table} WHERE ${col} IN (${q})`).get(...ids).c;
              if (n) perDb.push({ name: 'tasks-index.sqlite', table, count: n });
            } catch { /* 表不存在 */ }
          }
        } finally { ti.close(); }
      }
    }

    const orphans = {
      message: db.prepare(`${cte} SELECT count(*) c FROM message m WHERE NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.session_id)`).get(...ids).c,
      part: db.prepare(`${cte} SELECT count(*) c FROM part p WHERE NOT EXISTS (SELECT 1 FROM message m WHERE m.id = p.message_id)`).get(...ids).c,
    };
    return { ids, perDb, orphans, dryRun: true, before: dbInfo(root), after: dbInfo(root), freed: 0, integrity: 'skipped', fkViolations: 0, vacuumMs: 0, backup: null };
  } finally { db.close(); }
}

/**
 * @param {string} root      ~/.zcode
 * @param {string[]} ids     要删的任务 id（顶层会话 id）
 * @param {object} opts      { backupDir, dryRun, vacuum }
 */
export async function purgeTasks(root, ids, opts = {}) {
  const { backupDir, dryRun = false, vacuum = true } = opts;

  if (!Array.isArray(ids) || !ids.length) throw httpErr(400, '没有选中任何任务');
  if (ids.length > 500) throw httpErr(400, '一次最多处理 500 个任务');

  const main = MAIN(root);
  const index = INDEX(root);
  if (!fs.existsSync(main)) throw httpErr(500, '找不到 db.sqlite');

  assertPurgeable(index, ids);               // 护栏对预览和真删一视同仁
  if (dryRun) return previewPurge(root, ids); // 预览永远走只读路径，不加任何写锁

  const before = dbInfo(root);

  // VACUUM 会重建整个库，必须有与库等量的空闲空间，否则中途失败可能留下半个文件
  if (vacuum && before.free != null && before.free < before.main.bytes * 1.2) {
    throw httpErr(507,
      `可用空间不足：VACUUM 需要约 ${(before.main.bytes * 1.2 / 1073741824).toFixed(1)} GB，` +
      `当前只有 ${(before.free / 1073741824).toFixed(1)} GB。`);
  }

  // 备份：一定要先落盘再动手
  if (!backupDir) throw httpErr(500, '未指定备份目录');
  const backup = path.join(backupDir, stamp());
  await fsp.mkdir(backup, { recursive: true });
  for (const p of [...SIDECARS(main), ...SIDECARS(index)]) {
    if (fs.existsSync(p)) await fsp.copyFile(p, path.join(backup, path.basename(p)));
  }

  const db = new DatabaseSync(main);
  let result;
  try {
    db.exec('PRAGMA foreign_keys = ON');

    db.exec('CREATE TEMP TABLE roots (id TEXT PRIMARY KEY)');
    const ins = db.prepare('INSERT OR IGNORE INTO roots (id) VALUES (?)');
    for (const id of ids) ins.run(id);

    // 目标 = 选中的顶层会话 + 它们的全部后代
    db.exec(`
      CREATE TEMP TABLE targets AS
      WITH RECURSIVE d(id) AS (
        SELECT id FROM roots
        UNION
        SELECT s.id FROM session s JOIN d ON s.parent_id = d.id
      ) SELECT id FROM d
    `);

    const counts = {};
    for (const t of ['session', 'message', 'part', 'model_usage', 'turn_usage', 'tool_usage',
                     'todo', 'session_entry', 'session_input', 'session_target', 'session_task_link']) {
      try { counts[t] = db.prepare(`SELECT count(*) c FROM ${t} WHERE ` +
        (t === 'session' ? 'id' : t === 'session_task_link' ? 'child_session_id' : 'session_id') +
        ' IN (SELECT id FROM targets)').get().c; } catch { /* 表可能不存在 */ }
    }

    db.exec('BEGIN IMMEDIATE');
    // 这一条会级联清掉 message / part / model_usage / turn_usage / tool_usage /
    // todo / session_entry / session_input / session_target / session_task_link
    db.exec('DELETE FROM session WHERE id IN (SELECT id FROM targets)');

    // 下面几张表的 session 列没声明外键，级联管不到，手动兜底
    for (const sql of [
      'DELETE FROM part          WHERE session_id IN (SELECT id FROM targets)',
      'DELETE FROM input_history WHERE session_id IN (SELECT id FROM targets)',
      'DELETE FROM dwf_actor     WHERE session_id IN (SELECT id FROM targets)',
      'DELETE FROM dwf_run       WHERE parent_session_id IN (SELECT id FROM targets)',
    ]) { try { db.exec(sql); } catch { /* 表不存在就跳过 */ } }

    const orphans = {
      message: db.prepare('SELECT count(*) c FROM message m WHERE NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.session_id)').get().c,
      part: db.prepare('SELECT count(*) c FROM part p WHERE NOT EXISTS (SELECT 1 FROM message m WHERE m.id = p.message_id)').get().c,
    };

    db.exec('COMMIT');
    result = { ids, counts, orphans, dryRun: false };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  } finally {
    try { db.exec('PRAGMA foreign_keys = OFF'); } catch {}
    db.close();
  }

  // 收尾：清任务索引条目
  if (fs.existsSync(index)) {
    const ti = new DatabaseSync(index);
    try {
      ti.exec('PRAGMA foreign_keys = ON');
      ti.exec('BEGIN IMMEDIATE');
      const q = ids.map(() => '?').join(',');
      const tables = [
        ['tasks', 'task_id'], ['task_group_members', 'task_id'],
        ['off_peak_tasks', 'session_id'], ['automation_runs', 'session_id'],
      ];
      for (const [t, col] of tables) {
        try { ti.prepare(`DELETE FROM ${t} WHERE ${col} IN (${q})`).run(...ids); } catch { /* 表不存在 */ }
      }
      ti.exec('COMMIT');
      ti.exec('PRAGMA foreign_keys = OFF');
    } finally { ti.close(); }
  }

  // VACUUM：不跑这一步，删掉的空间只是进了 freelist，文件不会变小
  let vacuumMs = 0;
  if (vacuum) {
    const t = Date.now();
    const v = new DatabaseSync(main);
    try { v.exec('VACUUM'); } finally { v.close(); }
    vacuumMs = Date.now() - t;
  }

  // 收尾自检 —— 删完必须自己验一遍，不能只报"成功"
  const c = openReadonlyOrThrow(main);
  let integrity = 'ok';
  let fkViolations = 0;
  try {
    integrity = c.prepare('PRAGMA integrity_check').get()?.integrity_check || 'ok';
    fkViolations = c.prepare('PRAGMA foreign_key_check').all().length;
  } finally { c.close(); }

  const after = dbInfo(root);
  return {
    ...result,
    backup,
    vacuumMs,
    integrity,
    fkViolations,
    before,
    after,
    freed: Math.max(0, before.total - after.total),
  };
}

/**
 * 任务为什么能被清理。一条任务只要在 ZCode 里看不到，就归入其中一类：
 *   deleted      界面上删过（索引 deleted=1）
 *   archived     归档后不在主列表（索引 archived=1）
 *   wsMissing    活跃，但工作区目录已不存在，主列表不显示
 *   untracked    会话库有正文，索引里没有这一行，界面列表根本不列它
 * 返回 null 表示它在 ZCode 里仍可见，不能从这里清理。
 */
export function deleteReason(state, m, r) {
  if (state === 'deleted') return 'deleted';
  if (state === 'archived') return 'archived';
  if (state === 'untracked') return 'untracked';
  if (state === 'active' && workspaceMissing(m?.workspace_path)) return 'wsMissing';
  return null;
}

/**
 * 工作区目录是否确实不存在了。只有 ENOENT 才算；路径为空或权限等其他错误一律视为"不知道"，不放行。
 */
export function workspaceMissing(p) {
  if (!p) return false;
  try { fs.statSync(p); return false; }
  catch (err) { return err.code === 'ENOENT'; }
}

/** 界面上还能看到的任务，不许从这个入口消失。 */
function assertPurgeable(index, ids) {
  if (!fs.existsSync(index)) return;
  const ti = openReadonlyOrThrow(index);
  let rows;
  try {
    const q = ids.map(() => '?').join(',');
    rows = ti.prepare(
      `SELECT task_id, workspace_path, archived, deleted FROM tasks WHERE task_id IN (${q})`
    ).all(...ids);
  } finally { ti.close(); }

  // 索引里有行的：只有 活跃且工作区丢失 时放行，其余（活跃且工作区存在）拒绝。
  // 索引里没有行的（untracked）：界面上看不见，直接放行。
  const indexed = new Map(rows.map((r) => [r.task_id, r]));
  const blocked = ids.filter((id) => {
    const r = indexed.get(id);
    if (!r) return false;                       // untracked：放行
    if (r.deleted || r.archived) return false;  // 已删除 / 已归档：放行
    return !workspaceMissing(r.workspace_path); // 活跃：仅工作区丢失时放行
  });
  if (blocked.length) {
    throw httpErr(409, `这些任务仍在 ZCode 主列表里且工作区存在，请先在 ZCode 里归档或删除它们：${blocked.join('、')}`);
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function httpErr(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}
