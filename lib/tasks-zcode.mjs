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
import path from 'node:path';
import { writeDatabases, hasTable } from './database-write.mjs';
import { validateIds, validateDryRun } from './validation.mjs';
import { openReadonly, openReadonlyOrThrow } from './sqlite-open.mjs';
import { normalizeRow, sortTasks, totalsOf } from './tasks-shape.mjs';
import { emptyContents, addTree } from './session-contents.mjs';
import { httpErr } from './http-error.mjs';

const MAIN = (root) => path.join(root, 'cli', 'db', 'db.sqlite');
const INDEX = (root) => path.join(root, 'v2', 'tasks-index.sqlite');

/** 会话类型的中文说明。 */
const TYPE_LABEL = {
  interactive: '对话',
  fork: '分叉',
  selection_side_chat: '划词追问',
  subagent_child: '子 Agent',
  workflow_child: '工作流',
};

/**
 * ZCode 一条会话在磁盘上的牵连。正文在库里，但会话运行期会额外留下四类文件，
 * 它们都以 `sess_<id>` 命名（实测目录名就是完整会话 id，前缀不能截）：
 *   cli/agents/<id>/**               子 Agent 的 transcript
 *   cli/artifacts/<id>/**            会话产物
 *   cli/image-cache/<id>/**          会话内贴图
 *   cli/rollout/model-io-<id>.jsonl  模型 IO 回放
 *   cli/exec/<id>/**                 每条命令的 stdout（单条能到 34 GB）
 *
 * 这些文件以前完全不参与会话清理：删完会话它们变成孤儿留在盘上，
 * 只能等用户在文件清单的「会话已不存在」组里再清一遍。
 */
export function sessionContents(root, tasks, problems = []) {
  const out = new Map();
  for (const t of tasks) {
    const c = emptyContents();
    for (const [role, rel] of [
      ['transcript', `cli/agents/${t.id}`],
      ['artifact', `cli/artifacts/${t.id}`],
      ['media', `cli/image-cache/${t.id}`],
      ['log', `cli/exec/${t.id}`],
    ]) {
      addTree(c, { root, rel, role, problems });
    }
    addTree(c, { root, rel: `cli/rollout/model-io-${t.id}.jsonl`, role: 'body', problems });
    out.set(t.id, c);
  }
  return out;
}


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
  let roots, sessions;
  try {
    sessions = db.prepare('SELECT id, parent_id FROM session').all();

    // octet_length 直接取字节数，不解码 UTF-8；在大库上比 length() 快十几倍
    // （实测 346ms vs 6014ms）。node:sqlite 的 SQLite 下限是 3.46，它一直可用。
    const LEN = 'octet_length';

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
          SELECT s.id, s.id FROM session s WHERE s.parent_id IS NULL OR s.parent_id = ''
            OR NOT EXISTS (SELECT 1 FROM session p WHERE p.id = s.parent_id)
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
  const indexKnown = fs.existsSync(index);
  if (indexKnown) {
    const ti = openReadonlyOrThrow(index);
    try {
      for (const r of ti.prepare(`
        SELECT task_id, title, workspace_path, archived, deleted, pinned,
               created_at, updated_at, model
        FROM tasks
      `).all()) meta.set(r.task_id, r);
    } finally { ti.close(); }
  }

  const problems = indexKnown ? [] : ['找不到任务索引，无法判断会话状态与清理范围'];
  const represented = roots.reduce((n, r) => n + r.kids + 1, 0);
  if (represented < sessions.length) {
    problems.push(`有 ${sessions.length - represented} 条会话的父子关系包含循环，无法归入顶层任务；未将它们纳入可清理列表`);
  }
  const parentOf = new Map(sessions.map(s => [s.id, s.parent_id]));
  const blockedFamilies = new Set();
  for (const s of sessions) {
    if (!indexedTaskBlocked(meta.get(s.id))) continue;
    // 把活跃后代的阻止状态逐层传给父会话；集合同时保证循环会终止。
    let id = s.id;
    while (parentOf.has(id) && !blockedFamilies.has(id)) {
      blockedFamilies.add(id);
      id = parentOf.get(id);
    }
  }


  const tasks = sortTasks(roots.map((r) => {
    const m = meta.get(r.id);
    const state = !indexKnown ? 'active' : !m ? 'untracked'
      : m.deleted ? 'deleted'
      : m.archived ? 'archived'
      : 'active';
    return normalizeRow({
      id: r.id,
      title: (m?.title || r.title || '(无标题)').trim() || '(无标题)',
      workspace: m?.workspace_path || r.directory || '',
      state,
      // 可清理的原因，前端据此标注。null 表示当前不可清理。
      reason: indexKnown && !blockedFamilies.has(r.id) ? deleteReason(state, m, r) : null,
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
    problems,
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
    // dbs 是各家共用的那份清单（前端"在文件清单中定位"按它走），
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
  validateIds(ids);
  const main = MAIN(root);
  const index = INDEX(root);
  if (!fs.existsSync(main)) throw httpErr(500, '找不到 db.sqlite');

  const db = openReadonlyOrThrow(main);
  try {
    const cte = targetsCte(ids);
    const targetIds = db.prepare(`${cte} SELECT id FROM d`).all(...ids).map(r => r.id);
    assertPurgeable(index, targetIds);
    const perDb = [];
    for (const [table, column] of [...COUNTED_TABLES, ['dwf_actor', 'session_id'], ['dwf_run', 'parent_session_id']]) {
      if (!hasTable(db, table)) continue;
      const count = db.prepare(`${cte} SELECT count(*) c FROM ${table} WHERE ${column} IN (SELECT id FROM d)`).get(...ids).c;
      if (count) perDb.push({ name: 'db.sqlite', table, count });
    }
    const ti = openReadonlyOrThrow(index);
    try {
      for (const [table, column] of [['tasks', 'task_id'], ['task_group_members', 'task_id'],
        ['off_peak_tasks', 'session_id'], ['automation_runs', 'session_id']]) {
        if (!hasTable(ti, table)) continue;
        const query = ti.prepare(`SELECT count(*) c FROM ${table} WHERE ${column} = ?`);
        const count = targetIds.reduce((sum, id) => sum + query.get(id).c, 0);
        if (count) perDb.push({ name: 'tasks-index.sqlite', table, count });
      }
    } finally { ti.close(); }

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

  validateIds(ids);
  validateDryRun(dryRun);

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

  const { backup, result, integrity } = await writeDatabases([main, index],
    { backupDir, label: 'zcode', vacuum, root }, ([db, ti]) => {
      const targets = db.prepare(`${targetsCte(ids)} SELECT id FROM d`).all(...ids).map(r => r.id);
      // 删顶层会连带删后代：每一个后代都要过一遍索引护栏。
      assertPurgeable(index, targets);
      db.exec('CREATE TEMP TABLE targets (id TEXT PRIMARY KEY)');
      const insert = db.prepare('INSERT OR IGNORE INTO targets VALUES (?)');
      for (const id of targets) insert.run(id);
      const counts = {};
      for (const [table, column] of COUNTED_TABLES) {
        if (!hasTable(db, table)) continue;
        counts[table] = db.prepare(`SELECT count(*) c FROM ${table} WHERE ${column} IN (SELECT id FROM targets)`).get().c;
      }
      // 除显式开启外键级联外，子行也要逐表删一遍 —— 双保险。
      db.exec('PRAGMA defer_foreign_keys = ON');
      for (const [table, column] of [
        ...COUNTED_TABLES.filter(([t]) => t !== 'session'),
        ['dwf_actor', 'session_id'], ['dwf_run', 'parent_session_id'],
      ]) {
        if (hasTable(db, table)) db.exec(`DELETE FROM ${table} WHERE ${column} IN (SELECT id FROM targets)`);
      }
      db.exec('DELETE FROM session WHERE id IN (SELECT id FROM targets)');
      for (const [table, column] of [
        ['task_group_members', 'task_id'], ['off_peak_tasks', 'session_id'],
        ['automation_runs', 'session_id'], ['tasks', 'task_id'],
      ]) {
        if (!hasTable(ti, table)) continue;
        const del = ti.prepare(`DELETE FROM ${table} WHERE ${column} = ?`);
        for (const id of targets) del.run(id);
      }
      const orphans = {
        message: db.prepare('SELECT count(*) c FROM message m WHERE NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.session_id)').get().c,
        part: db.prepare('SELECT count(*) c FROM part p WHERE NOT EXISTS (SELECT 1 FROM message m WHERE m.id = p.message_id)').get().c,
      };
      return { ids, counts, orphans, dryRun: false };
    });
  const after = dbInfo(root);
  return {
    ...result, backup, before, after, integrity: 'ok', fkViolations: 0,
    vacuumMs: integrity.reduce((sum, item) => sum + item.vacuumMs, 0),
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

/** 界面上还能看到的任务，不许从这个入口消失。索引不在 = 没有依据
 *  判断这些 id 是否还挂在主列表里，判不了就不动。 */
function assertPurgeable(index, ids) {
  if (!fs.existsSync(index)) {
    throw httpErr(409,
      `找不到任务索引 ${path.basename(index)}，无法确认这些任务是否仍在 ZCode 主列表里。` +
      `判不了就不动 —— 请先在 ZCode 里归档或删除它们，再回到这里清理。`);
  }
  const ti = openReadonlyOrThrow(index);
  let rows;
  try {
    const query = ti.prepare('SELECT task_id, workspace_path, archived, deleted FROM tasks WHERE task_id = ?');
    rows = ids.map(id => query.get(id)).filter(row => row?.task_id != null);
  } finally { ti.close(); }

  // 索引里有行的：只有 活跃且工作区丢失 时放行，其余（活跃且工作区存在）拒绝。
  // 索引里没有行的（untracked）：界面上看不见，直接放行。
  const indexed = new Map(rows.map((r) => [r.task_id, r]));
  const blocked = ids.filter(id => indexedTaskBlocked(indexed.get(id)));
  if (blocked.length) {
    throw httpErr(409, `这些任务仍在 ZCode 主列表里且工作区存在，请先在 ZCode 里归档或删除它们：${blocked.join('、')}`);
  }
}

function indexedTaskBlocked(row) {
  return !!row && !row.deleted && !row.archived && !workspaceMissing(row.workspace_path);
}

