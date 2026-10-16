/**
 * Codex 的历史会话：读取与按行清理。
 *
 * 三个库各管一段， thread id 把它们串起来：
 *   state_5.sqlite        threads 表 = 界面主列表（含 archived、cwd、rollout_path）
 *   thread_history_N.sqlite  thread_items / thread_turns = 投影后的逐轮条目（新版分页历史）
 *   logs_2.sqlite         logs 表按 thread_id 记录结构化日志
 * 会话正文本身在 sessions/YYYY/MM/DD/rollout-*.jsonl（归档的在 archived_sessions/）。
 *
 * 于是"界面里已经看不到的会话"在这台机器上有两种残留：
 *   threads.archived=1        归档线程：索引还在，只是不在主列表
 *   rollout 文件没有索引行      真残骸：删了索引，正文一行没少 —— 这只能删文件
 *
 * 外键实况：thread_dynamic_tools / thread_attachments 有 ON DELETE CASCADE，
 * project_id / thread_section_id 是 SET NULL；thread_spawn_edges 和 thread_history/logs
 * 那几个库的表**没有**声明外键 —— 所以既要 PRAGMA foreign_keys=ON，也要手动兜底。
 *
 * 跨库删除的安全做法：先把每个库都试开一遍（能读写才继续），全部通过才备份、才动手；
 * 任何一步失败都不会留下"删了一半"的状态。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadonly, openReadonlyOrThrow } from './sqlite-open.mjs';

const INDEX_DB = 'state_5.sqlite';
/** 这些库按 thread id 关联，删除时要一起处理。 */
const FAMILY = [
  { role: 'index', re: /^state_\d+\.sqlite$/ },
  { role: 'history', re: /^thread_history_\d+\.sqlite$/ },
  { role: 'logs', re: /^logs_\d+\.sqlite$/ },
];
/** 结构表：里面没有会话数据，不能碰。 */
const NEVER_TOUCH = new Set(['_sqlx_migrations', 'sqlite_sequence', 'backfill_state']);
const SIDECARS = (p) => [p, `${p}-wal`, `${p}-shm`];

/** 找出根目录里属于这个家族的库文件（文件名里的版本号会变，所以按模式匹配）。 */
export function familyDbs(root) {
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.sqlite')) continue;
    const fam = FAMILY.find((f) => f.re.test(name));
    if (!fam) continue;
    out.push({ role: fam.role, name, path: path.join(root, name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 库里所有带 thread_id / session_id 列的表 —— 删除时逐表清。 */
function threadTables(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const tables = names
    .filter((n) => !NEVER_TOUCH.has(n) && !n.startsWith('threads'));
  const out = [];
  for (const t of tables) {
    let cols;
    try { cols = db.prepare(`PRAGMA table_info(${q_ident(t)})`).all(); }
    catch { continue; }
    const col = cols.find((c) => c.name === 'thread_id') || cols.find((c) => c.name === 'session_id');
    if (col) out.push({ table: t, column: col.name });
  }
  // threads 表自己按 id 删 —— 但只有这个库里真的有它才加上。
  // history / logs 那几个库没有这张表，无条件拼进去会让整个跨库删除在第一条 SQL 上失败。
  const head = names.includes('threads') ? [{ table: 'threads', column: 'id', primary: true }] : [];
  return [...head, ...out];
}

/* ── 只读扫描 ─────────────────────────────────────────────── */

/**
 * @param {string} root ~/.codex
 */
export function scanTasks(root) {
  const t0 = Date.now();
  const problems = [];
  const dbs = familyDbs(root);
  const index = dbs.find((d) => d.role === 'index');

  if (!index) {
    return { tasks: [], totals: emptyTotals(), db: dbSizes(root, dbs), problems: [`找不到 ${INDEX_DB}`], scanMs: 0 };
  }

  const db = openReadonly(index.path);
  if (!db) return { tasks: [], totals: emptyTotals(), db: dbSizes(root, dbs), problems: [`${INDEX_DB} 打不开（只读）`], scanMs: 0 };

  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, title, name, cwd, rollout_path, created_at, updated_at, archived, archived_at,
             is_pinned, tokens_used, model, model_provider, history_mode, thread_source, preview
      FROM threads
    `).all();
  } catch (err) {
    problems.push(`threads 表读不出来：${err.message}`);
  } finally { db.close(); }

  // 投影库里的条目数与体积（按 thread 汇总）
  const hist = new Map();
  for (const d of dbs.filter((x) => x.role === 'history')) {
    const h = openReadonly(d.path);
    if (!h) { problems.push(`${d.name} 打不开（只读）`); continue; }
    try {
      for (const r of h.prepare(`
        SELECT thread_id, count(*) n, sum(octet_length(item_json)) b
        FROM thread_items GROUP BY thread_id
      `).all()) hist.set(r.thread_id, r);
    } catch { /* 老版本没有这张表 */ } finally { h.close(); }
  }

  const rootReal = safeRealpath(root);
  const tasks = rows.map((r) => {
    const body = bodyFile(rootReal, r.rollout_path);
    const h = hist.get(r.id);
    return {
      id: r.id,
      title: (r.name || r.title || r.preview || firstLine(r.preview) || '(无标题)').trim() || '(无标题)',
      workspace: r.cwd || '',
      workspaceKey: r.cwd || '',
      state: r.archived ? 'archived' : 'active',
      // 能从这里清理的原因（null = 仍在主列表里，不许从这里消失）
      reason: deleteReason(r, body),
      pinned: !!r.is_pinned,
      model: r.model || r.model_provider || '',
      type: r.thread_source || '',
      typeLabel: r.history_mode === 'paginated' ? '分页历史' : '原始 rollout',
      createdAt: r.created_at,
      updatedAt: r.archived_at || r.updated_at,
      // 正文体积来自磁盘上的 rollout 文件（stat 原文件，不是副本）
      bytes: body?.bytes || 0,
      rows: h?.n || 0,
      children: 0,
      bodyRel: body?.rel || null,
      bodyMissing: !!r.rollout_path && !body,
      dbBytes: h?.b || 0,
    };
  });

  // 残骸：磁盘上有 rollout 文件，却没有任何一行认领它 —— 界面里早就不见了，正文还占着磁盘。
  // 按"有没有被认领"判，不能只按 id：索引里还有行、但 rollout_path 指向别处或已丢失时，
  // 这个文件既不在那行名下、又躲过了 id 判断，库里统计就会少算一块。
  const claimed = new Set(tasks.map((t) => t.bodyRel).filter(Boolean));
  for (const f of rolloutFiles(root)) {
    if (claimed.has(f.rel)) continue;
    tasks.push(untrackedTask(f));
  }

  tasks.sort((a, b) => (b.bytes + b.dbBytes) - (a.bytes + a.dbBytes));

  return {
    tasks,
    totals: {
      count: tasks.length,
      bytes: tasks.reduce((s, t) => s + t.bytes, 0),
      rows: tasks.reduce((s, t) => s + t.rows, 0),
      byState: ['deleted', 'archived', 'active', 'untracked'].map((k) => {
        const g = tasks.filter((t) => (k === 'deleted' ? false : t.state === k));
        return { state: k, count: g.length, bytes: g.reduce((s, t) => s + t.bytes + t.dbBytes, 0) };
      }).filter((g) => g.count),
    },
    db: dbSizes(root, dbs),
    scanMs: Date.now() - t0,
    problems,
  };
}

function untrackedTask(f) {
  return {
    // 残骸的编号用它自己的文件路径，不用文件名里那个 thread id：
    // 同一个 thread 可以留下多份 rollout（分页、路径搬家），编号撞了界面就选不中。
    // 顺带这条 id 也不会被当成线程 id 误删 —— SQL 里永远匹配不到它。
    id: `file:${f.rel}`,
    title: `（索引里已经没有这条会话）${f.rel}`,
    workspace: '',
    workspaceKey: '',
    state: 'untracked',
    reason: 'untracked',
    pinned: false,
    model: '',
    type: 'rollout',
    typeLabel: '磁盘残骸',
    createdAt: f.mtime,
    updatedAt: f.mtime,
    bytes: f.bytes,
    rows: 0,
    children: 0,
    bodyRel: f.rel,
    bodyMissing: false,
    dbBytes: 0,
    // 索引里已经没有行，库里无行可删 —— 只能删文件，界面据此换成"移入废纸篓"入口
    residual: true,
  };
}

/** sessions/ 与 archived_sessions/ 下的 rollout 文件（只 stat，文件名里带 thread id）。 */
export function rolloutFiles(root) {
  const out = [];
  for (const dir of ['sessions', 'archived_sessions']) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const abs = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(abs); continue; }
        if (!e.name.endsWith('.jsonl')) continue;
        const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?\.jsonl$/.exec(e.name);
        if (!m) continue;
        let st; try { st = fs.statSync(abs); } catch { continue; }
        out.push({ id: m[1], rel: path.relative(root, abs).split(path.sep).join('/'), bytes: st.size, mtime: st.mtimeMs });
      }
    }
  }
  return out;
}

/** rollout_path 是否落在扫描根之内；落在外面就不当作可删的文件。 */
function bodyFile(rootReal, rolloutPath) {
  if (!rolloutPath) return null;
  // 索引里存的可能还是没解析过软链接的旧路径（macOS 的 /var ↔ /private/var 就是这样）。
  // 直接拿字符串比前缀会把同一目录当成"根外面"，于是正文凭空变成缺失。
  let real;
  try { real = fs.realpathSync.native(path.resolve(rolloutPath)); } catch { return null; }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  try {
    const st = fs.statSync(real);
    return { rel: path.relative(rootReal, real).split(path.sep).join('/'), bytes: st.size };
  } catch { return null; }
}

function safeRealpath(p) {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

function firstLine(s) {
  return (s || '').split('\n')[0].slice(0, 80);
}

/**
 * 为什么这条能从清理入口消失：
 *   archived     归档线程，主列表不显示
 *   wsMissing    活跃，但工作目录已经不存在
 *   bodyMissing  活跃，但 rollout 正文文件已经不在磁盘上（索引是空壳）
 * 返回 null 表示界面里还能正常打开它。
 */
function deleteReason(r, body) {
  if (r.archived) return 'archived';
  if (r.cwd && missing(r.cwd)) return 'wsMissing';
  if (r.rollout_path && !body) return 'bodyMissing';
  return null;
}

function missing(p) {
  try { fs.statSync(p); return false; } catch (err) { return err.code === 'ENOENT'; }
}

function emptyTotals() {
  return { count: 0, bytes: 0, rows: 0, byState: [] };
}

function dbSizes(root, dbs) {
  const info = (p) => {
    try { const st = fs.statSync(p); return { path: p, bytes: st.size, mtime: st.mtimeMs }; }
    catch { return { path: p, bytes: 0, mtime: 0 }; }
  };
  const list = (dbs || familyDbs(root)).map((d) => ({ ...d, ...info(d.path) }));
  const files = rolloutFiles(root);
  let free = null;
  try { const s = fs.statfsSync(root); free = s.bavail * s.bsize; } catch {}
  return {
    dbs: list,
    total: list.reduce((s, d) => s + d.bytes, 0),
    // rollout 文件是会话正文的实际占用，库里只是投影
    bodies: { count: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) },
    free,
  };
}

/* ── 清理 ─────────────────────────────────────────────────── */

/**
 * 空跑：只用只读连接做 COUNT，不建表、不开事务、不加写锁。
 * @returns {{perDb: Array<{name:string, table:string, column:string, count:number}>}}
 */
export function previewPurge(root, ids) {
  if (!Array.isArray(ids) || !ids.length) throw httpErr(400, '没有选中任何会话');
  const perDb = [];
  const bodyBytes = rolloutBytes(root, ids);
  for (const d of familyDbs(root)) {
    const db = openReadonlyOrThrow(d.path);
    try {
      for (const t of threadTables(db)) {
        const q = ids.map(() => '?').join(',');
        const count = db.prepare(`SELECT count(*) c FROM ${q_ident(t.table)} WHERE ${q_ident(t.column)} IN (${q})`).get(...ids).c;
        if (count) perDb.push({ name: d.name, table: t.table, column: t.column, count });
      }
    } finally { db.close(); }
  }
  // 磁盘正文不在库里，单列出来：那才是体积的大头
  return { ids, dryRun: true, perDb, bodyBytes, freed: 0, before: dbSizes(root), after: dbSizes(root) };
}

function rolloutBytes(root, ids) {
  const set = new Set(ids);
  return rolloutFiles(root).filter((f) => set.has(f.id)).reduce((s, f) => s + f.bytes, 0);
}

/**
 * 按线程清理。四道闸与 ZCode 同一套：进程退出 → 备份 → 事务 + 外键 → VACUUM + 自检。
 * @param {string[]} ids threads.id
 * @param {{backupDir:string, dryRun?:boolean}} opts
 */
export async function purgeTasks(root, ids, opts = {}) {
  const { backupDir, dryRun = false } = opts;
  if (!Array.isArray(ids) || !ids.length) throw httpErr(400, '没有选中任何会话');
  if (ids.length > 500) throw httpErr(400, '一次最多处理 500 个会话');

  const dbs = familyDbs(root);
  if (!dbs.length) throw httpErr(500, `找不到任何会话库（${INDEX_DB} 等）`);

  assertPurgeable(root, ids);
  if (dryRun) return previewPurge(root, ids);

  // 闸 0：先把每个库都试开一次读写。任何一个开不了就整体不动 ——
  // 跨库删除最怕"删了索引、没删正文"或反过来。
  for (const d of dbs) {
    try { const t = new DatabaseSync(d.path); t.close(); }
    catch (err) { throw httpErr(500, `${d.name} 无法以读写方式打开，已整体放弃：${err.message}`); }
  }

  const before = dbSizes(root);
  if (before.free != null && before.free < before.total * 1.2) {
    throw httpErr(507,
      `可用空间不足：VACUUM 需要约 ${(before.total * 1.2 / 1073741824).toFixed(1)} GB，` +
      `当前只有 ${(before.free / 1073741824).toFixed(1)} GB。`);
  }
  if (!backupDir) throw httpErr(500, '未指定备份目录');

  // 闸 1：备份全部相关库（含侧文件）之后才动手
  const backup = path.join(backupDir, `${stamp()}-codex`);
  await fsp.mkdir(backup, { recursive: true });
  for (const d of dbs) {
    for (const p of SIDECARS(d.path)) {
      if (fs.existsSync(p)) await fsp.copyFile(p, path.join(backup, path.basename(p)));
    }
  }

  const perDb = [];
  const integrity = [];
  for (const d of dbs) {
    const db = new DatabaseSync(d.path);
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('BEGIN IMMEDIATE');
      const q = ids.map(() => '?').join(',');
      for (const t of threadTables(db)) {
        const r = db.prepare(`DELETE FROM ${q_ident(t.table)} WHERE ${q_ident(t.column)} IN (${q})`).run(...ids);
        if (r.changes) perDb.push({ name: d.name, table: t.table, column: t.column, deleted: r.changes });
      }
      // thread_spawn_edges 的父子两列都没声明外键，级联管不到，手动兜底
      try {
        const r = db.prepare(
          `DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${q}) OR child_thread_id IN (${q})`
        ).run(...ids, ...ids);
        if (r.changes) perDb.push({ name: d.name, table: 'thread_spawn_edges', column: 'parent/child', deleted: r.changes });
      } catch { /* 老版本没有这张表 */ }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw httpErr(500, `写入 ${d.name} 失败，已回滚该库：${err.message}`);
    } finally {
      try { db.exec('PRAGMA foreign_keys = OFF'); } catch {}
      db.close();
    }

    // 闸 2：VACUUM —— 不跑这一步，删掉的空间只进 freelist，文件不会变小
    const t0 = Date.now();
    const v = new DatabaseSync(d.path);
    try { v.exec('VACUUM'); } finally { v.close(); }

    // 闸 3：自检，结果如实报出来
    const c = openReadonlyOrThrow(d.path);
    try {
      integrity.push({
        name: d.name,
        integrity: c.prepare('PRAGMA integrity_check').get()?.integrity_check || 'ok',
        fkViolations: c.prepare('PRAGMA foreign_key_check').all().length,
        vacuumMs: Date.now() - t0,
      });
    } finally { c.close(); }
  }

  const after = dbSizes(root);
  return {
    ids, dryRun: false, perDb, integrity, backup, before, after,
    freed: Math.max(0, before.total - after.total),
    // 正文是文件，不在这里删 —— 由文件清理线（废纸篓/彻底删除）负责，那边有保护检查
    bodyBytes: 0,
  };
}

/**
 * 护栏：仍在主列表里、且正文文件还在的线程，不许从这里消失。
 * archived / 工作区丢失 / 正文已丢失 的放行；索引里根本没有的行（残骸）不在本入口。
 */
function assertPurgeable(root, ids) {
  const index = familyDbs(root).find((d) => d.role === 'index');
  if (!index) throw httpErr(500, `找不到 ${INDEX_DB}`);
  const db = openReadonlyOrThrow(index.path);
  let rows;
  try {
    const q = ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT id, cwd, archived, rollout_path FROM threads WHERE id IN (${q})`).all(...ids);
  } finally { db.close(); }

  const known = new Map(rows.map((r) => [r.id, r]));
  const blocked = ids.filter((id) => {
    const r = known.get(id);
    if (!r) return false;                 // 索引里没有：已经不在界面里，放行
    if (r.archived) return false;
    if (r.cwd && missing(r.cwd)) return false;
    if (r.rollout_path && !bodyFile(safeRealpath(root), r.rollout_path)) return false;
    return true;
  });
  if (blocked.length) {
    throw httpErr(409,
      `这些会话仍在 Codex 主列表里且正文还在，请先在 Codex 里归档或删除它们：${blocked.join('、')}`);
  }
}

/** 表名/列名来自库自己的 schema，不是用户输入；仍然过一遍白名单字符再拼。 */
function q_ident(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw httpErr(500, `非法表名或列名：${name}`);
  return `"${name}"`;
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
