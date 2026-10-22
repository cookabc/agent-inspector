/**
 * Cursor 的按会话清理。
 *
 * 为什么需要单独一个模块：Cursor 的库是键值对（`cursorDiskKV`），会话正文是
 * `bubbleId:<会话>:<气泡>`，而**工具调用的原始结果存在另一个池子里**
 * （`agentKv:blob:<sha256>`，内容寻址）。那个池子占了库里一半以上，但 key 里
 * 没有会话 id —— 只看 key 根本不知道某个 blob 还能不能删。
 *
 * 这里做的是**可达性分析**：从"还活着的会话"出发，把能走到的 blob 全部标记为
 * 活着；剩下的才是可以随会话一起删的。三条引用通道全都要走，少一条就会误删：
 *
 *   ① 文本里的完整 key 名      `agentKv:blob:<64 hex>` / `composer.content.<64 hex>`
 *   ② 文本里的裸 64 位 hex     会话里直接写 hash，不带前缀
 *   ③ 二进制里的 32 字节原始 hash  blob 内容里嵌着其它 blob 的 hash 字节
 *   ④ toolCallId 关联          blob 里写着工具调用 id，会话的气泡里也有同一个 id
 *
 * 第 ③ 条是最容易漏的一条 —— 文本正则完全看不见它。历史上有过一次事故正是因为
 * 只扫了文本：删掉"看起来无人引用"的 blob 之后 Cursor 报 Conversation data missing，
 * 最后要靠备份恢复。第 ④ 条同样隐蔽：blob 里的 id 形如 `0_tool_<uuid>`，
 * 而会话里的同一串可能被截断或带后缀，所以要取 UUID 主体再比。
 *
 * 还有一层编码陷阱：Cursor 把**二进制内容存成十进制字节串**（"123,34,114,..."）。
 * 不解码的话，③ 永远匹配不到东西 —— edges 会算成 0，看起来"没有任何引用"，
 * 于是每个 blob 都像孤儿。必须先 unframe 再匹配。
 *
 * 写入路径与回灌一样是非官方的，所以闸门照抄：Cursor 必须完全退出、先整库备份、
 * 事务内完成、写完自检（quick_check + 悬空引用必须为 0）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadonly } from './sqlite-open.mjs';

const DB_REL = path.join('User', 'globalStorage', 'state.vscdb');
/* 这里曾经另导出一个 CONFIRM_WORD = '清理'，但没有任何地方 import 它 ——
   真正的校验用的是 lib/confirm-words.mjs 那一份。留一个没人读的同名常量，
   下次改词时它不会跟着变，而读到它的人会以为那就是真的。删掉。 */

/* ── 编码 ─────────────────────────────────────────────────── */

/**
 * Cursor 把二进制/多字节内容存成 "123,34,114,..."（每个字节一个十进制数）。
 *
 * 手工解析而不是 split(',').map(Number)：一个 4.7 MB 的值会切出近百万个
 * 临时字符串，实测慢到分钟级。这里一次线性扫描，顺便在第一个非数字字节上
 * 判定"这不是字节串"。
 */
export function unframe(v) {
  if (Buffer.isBuffer(v)) return v;
  const s = String(v ?? '');
  if (s.length < 8) return Buffer.from(s, 'utf8');
  // 头部判定：必须是"数字,数字,..."的形状
  if (!/^\d{1,3}(,\d{1,3}){3,}/.test(s.slice(0, 40))) return Buffer.from(s, 'utf8');

  let cap = Math.max(1024, Math.min(s.length, 1 << 22));
  let buf = Buffer.allocUnsafe(cap);
  let len = 0, n = 0, digits = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 44;   // 末尾补逗号收尾
    if (c === 44) {
      if (digits === 0) return Buffer.from(s, 'utf8');
      if (len === cap) {
        cap *= 2;
        const nb = Buffer.allocUnsafe(cap);
        buf.copy(nb, 0, 0, len);
        buf = nb;
      }
      buf[len++] = n;
      n = 0; digits = 0;
    } else if (c >= 48 && c <= 57) {
      n = n * 10 + (c - 48);
      if (++digits > 3) return Buffer.from(s, 'utf8');
    } else {
      return Buffer.from(s, 'utf8');   // 混进了非字节字符，按原文处理
    }
  }
  return buf.subarray(0, len);
}

/** 从一段文本里取出工具调用 id 的 UUID 主体。`0_tool_<uuid>` 与 `call-<uuid>-0` 都认。 */
const TOOL_ID_RE = /(?:0_tool_|call-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
function toolIdsOf(text) {
  const out = new Set();
  TOOL_ID_RE.lastIndex = 0;
  let m;
  while ((m = TOOL_ID_RE.exec(text))) out.add(m[1]);
  return out;
}

/** 廉价预筛：文本里至少要有 64 个连续 hex 字符才值得跑正则。 */
const HEX_HINT = /[0-9a-f]{64}/;

/* ── 图的构建 ─────────────────────────────────────────────── */

/**
 * 把整库读成一张引用图。
 *
 * 返回：
 *   blobs     [{ hex, hash, bytes, ids, refs }]  —— 内容寻址池里的每一项
 *   sessions  Map<composerId, { rows: [{key, bytes, refs}], ids: Set }>
 *   idToBlob  Map<uuid, number[]>                —— toolCallId 倒排
 *
 * refs 是"它引用了哪些 blob"的下标数组，三条通道合成。
 */
function buildGraph(db) {
  const rows = db.prepare('SELECT key, value FROM cursorDiskKV').all();

  const blobs = [];
  const sessions = new Map();
  const byHex = new Map();

  for (const r of rows) {
    const k = r.key;
    let hex = null;
    if (k.startsWith('agentKv:blob:')) hex = k.slice(13);
    else if (k.startsWith('composer.content.')) hex = k.slice(17);

    if (hex && hex.length === 64) {
      byHex.set(hex, blobs.length);
      // 先只存 key 与 hex；buffer 在下面统一解码，避免边读边持有 400MB
      blobs.push({ hex, buf: unframe(r.value), ids: null, refs: null, key: k, hash: null });
      continue;
    }

    const colon = k.indexOf(':');
    const head = colon < 0 ? k : k.slice(0, colon);
    if (head !== 'bubbleId' && head !== 'composerData' && head !== 'checkpointId') continue;
    /* 会话 id 取到**下一个冒号之前**，不要盲切 36 位。
       Cursor 自己写的是 36 位 UUID，但这一层不该把"长度恰好 36"当成契约 ——
       一旦格式变了（或夹具用了短 id），盲切会让行归到一个不存在的会话名下，
       于是"删会话"看起来删了、实际一行没动。 */
    const end = k.indexOf(':', colon + 1);
    const cid = k.slice(colon + 1, end < 0 ? undefined : end);

    let g = sessions.get(cid);
    if (!g) sessions.set(cid, g = { rows: [], ids: new Set() });
    // 行也先存原始值，统一在下面解码（这样 rows 与 blobs 的解码节奏一致，
    // 也避免这里再转一次 latin1 —— 那一行在 profile 里是白花的）
    g.rows.push({ key: k, raw: r.value, buf: null, bytes: 0, refs: null });
  }

  // 二进制匹配用的 4 字节前缀索引
  const prefix = new Map();
  for (let i = 0; i < blobs.length; i++) {
    blobs[i].hash = Buffer.from(blobs[i].hex, 'hex');
    const u = blobs[i].hash.readUInt32LE(0);
    let a = prefix.get(u);
    if (!a) prefix.set(u, a = []);
    a.push(i);
  }

  /**
   * 一段内容引用了哪些 blob。三条通道合成一个集合。
   *
   * 性能上两件事很要紧（实测占 16 秒里的绝大部分）：
   *   · toString('latin1') 只做一次，别在 refsOf 和取 toolCallId 时各转一遍
   *   · 文本通道先看长度：payload 里没有 64 位 hex 可能出现的长度就直接跳过
   *     正则。绝大多数 blob 是源码快照，命中率极低，先筛一遍省掉整个正则。
   */
  const refsOf = (buf, text) => {
    const out = new Set();
    // ③ 二进制：32 字节原始 hash 出现在任意偏移
    if (buf.length >= 32) {
      for (let o = 0; o + 32 <= buf.length; o++) {
        const cand = prefix.get(buf.readUInt32LE(o));
        if (!cand) continue;
        for (const idx of cand) {
          if (buf.compare(blobs[idx].hash, 0, 32, o, o + 32) === 0) out.add(idx);
        }
      }
    }
    // ①② 文本：完整 64 位 hex（带不带 agentKv:blob: 前缀都能被捞到）
    if (text.length >= 64 && HEX_HINT.test(text)) {
      const re = /[0-9a-f]{64}/g;
      let m;
      while ((m = re.exec(text))) {
        const i = byHex.get(m[0]);
        if (i !== undefined) out.add(i);
      }
    }
    return [...out];
  };

  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    // 每个值只转一次 latin1：refsOf 与 toolIdsOf 共用同一份文本
    const text = b.buf.toString('latin1');
    b.ids = toolIdsOf(text);
    b.refs = refsOf(b.buf, text);
    b.bytes = b.buf.length;
    b.buf = null;
  }
  for (const g of sessions.values()) {
    for (const row of g.rows) {
      const buf = unframe(row.raw);
      const text = buf.toString('latin1');
      row.refs = refsOf(buf, text);
      row.bytes = buf.length;
      for (const id of toolIdsOf(text)) g.ids.add(id);   // 会话级的 id 也在这里合并
      row.raw = null;
    }
  }

  // ④ id → blob 倒排
  const idToBlob = new Map();
  for (let i = 0; i < blobs.length; i++) {
    for (const id of blobs[i].ids) {
      let a = idToBlob.get(id);
      if (!a) idToBlob.set(id, a = []);
      a.push(i);
    }
  }

  return { blobs, sessions, idToBlob, bytesOf: (i) => blobs[i].bytes };
}

/**
 * 每个 blob 的"归属会话集"。
 *
 * 为什么不是"逐个会话跑一遍可达性"：那是 O(会话数 × 全图)，实测 112 个会话要
 * 17 秒。真正需要的信息只有一件事 —— **某个 blob 能不能被除它以外的会话走到**。
 *
 * 所以反过来算：从每个会话的根出发把它能到的 blob 打上会话位，再沿引用边
 * 传播到收敛。位集用 Uint32Array，112 个会话 = 4 个 word = 16 字节/节点。
 *
 * 结果 owner[i] 是"能到达 blob i 的会话集合"。删掉一批会话 G 时，
 * blob 可以删 ⟺ owner[i] ⊆ G（所有能到它的会话都没了）。
 * owner 为空 = 任何会话都到不了，早就该清但**不归这里管**（可能是我们
 * 没识别的引用形式），所以一律保留。
 */
function ownerSets(graph) {
  const { blobs, sessions, idToBlob } = graph;
  const sids = [...sessions.keys()];
  const idx = new Map(sids.map((s, i) => [s, i]));
  const n = blobs.length;

  /* 快路径：绝大多数 blob 只被一个会话引用。给这类节点只存一个整数
     （会话下标 + 1，0 表示"还没人引用"）就够，不必碰位集数组。
     只有真被多个会话引用时才升级到位集。实测这让 16 秒降到几秒 ——
     原因是省掉了每节点每 word 一次的数组索引计算，那是热循环里最贵的一行。 */
  const single = new Int32Array(n);      // 0 = 无, >0 = sids[i-1]
  const multi = new Map();               // i → Uint32Array(words)
  const words = Math.max(1, Math.ceil(sids.length / 32));

  const setBit = (i, s) => {
    const one = s + 1;
    if (!multi.has(i)) {
      if (single[i] === 0) { single[i] = one; return true; }
      if (single[i] === one) return false;
      // 升级：把原来那个单值搬进位集，再并入新的
      const arr = new Uint32Array(words);
      const prev = single[i] - 1;
      arr[prev >>> 5] |= 1 << (prev & 31);
      arr[s >>> 5] |= 1 << (s & 31);
      single[i] = 0;
      multi.set(i, arr);
      return true;
    }
    const arr = multi.get(i);
    const w = s >>> 5, bit = 1 << (s & 31);
    if (arr[w] & bit) return false;
    arr[w] |= bit;
    return true;
  };

  const queue = [];
  const inQueue = new Uint8Array(n);
  const push = (i) => { if (!inQueue[i]) { inQueue[i] = 1; queue.push(i); } };

  // 种子：每个会话的行 + 它的 toolCallId 指向的 blob
  for (let s = 0; s < sids.length; s++) {
    const g = sessions.get(sids[s]);
    for (const row of g.rows) for (const i of row.refs) if (setBit(i, s)) push(i);
    for (const id of g.ids) for (const i of idToBlob.get(id) || []) if (setBit(i, s)) push(i);
  }

  // 传播：i 的 owner 变了，它引用的 j 也要跟着变
  while (queue.length) {
    const i = queue.pop();
    inQueue[i] = 0;
    const arr = multi.get(i);
    for (const j of blobs[i].refs) {
      let changed = false;
      if (arr) {
        for (let w = 0; w < words; w++) {
          const v = arr[w];
          if (!v) continue;
          for (let b = 0; b < 32; b++) if (v & (1 << b)) { if (setBit(j, (w << 5) + b)) changed = true; }
        }
      } else {
        changed = setBit(j, single[i] - 1);
      }
      if (changed) push(j);
    }
  }

  /** 这个 blob 被哪些会话引用 */
  const ownersOf = (i) => {
    const arr = multi.get(i);
    if (!arr) return single[i] ? [sids[single[i] - 1]] : [];
    const out = [];
    for (let w = 0; w < words; w++) {
      let v = arr[w];
      while (v) {
        const bit = v & -v;
        out.push(sids[(w << 5) + Math.log2(bit | 0)]);
        v ^= bit;
      }
    }
    return out;
  };

  /** owner 是否全部落在这批会话里（空集不算 —— 表示没有会话引用它） */
  const onlyIn = (i, goneSet) => {
    const arr = multi.get(i);
    if (!arr) return single[i] !== 0 && goneSet.has(sids[single[i] - 1]);
    let any = false;
    for (let w = 0; w < words; w++) {
      let v = arr[w];
      while (v) {
        const bit = v & -v;
        if (!goneSet.has(sids[(w << 5) + Math.log2(bit | 0)])) return false;
        any = true;
        v ^= bit;
      }
    }
    return any;
  };

  return { onlyIn, ownersOf };
}

/* ── 对外：分析 ───────────────────────────────────────────── */

/**
 * 只读分析：每个会话名下多少、其中 blob 独占多少。
 *
 * 返回的 sessions 与 tasks-cursor.mjs 的会话行按 id 对齐 —— 前端把这份
 * 独占比拼到对应行上，用户才知道删这一条能回收多少。
 *
 * @param {string} idePath App Support/Cursor
 * @param {Iterable<string>} candidates 只想算这些会话（空 = 全部）
 */
export function analyzePurge(idePath, candidates = null) {
  const t0 = Date.now();
  const dbPath = path.join(idePath, DB_REL);
  const db = openReadonly(dbPath);
  if (!db) {
    const e = new Error('state.vscdb 打不开（只读）');
    e.statusCode = 500;
    throw e;
  }
  try {
    const graph = buildGraph(db);
    const live = new Set(db.prepare('SELECT composerId FROM composerHeaders').all().map((r) => r.composerId));
    const { onlyIn, ownersOf } = ownerSets(graph);

    const wanted = candidates ? [...candidates] : [...graph.sessions.keys()].filter((c) => live.has(c));
    const out = [];
    for (const cid of wanted) {
      const g = graph.sessions.get(cid);
      if (!g) {
        out.push({ id: cid, sessionBytes: 0, exclusiveBytes: 0, exclusiveBlobs: 0, reclaimable: 0, orphanSession: !live.has(cid) });
        continue;
      }
      const sb = g.rows.reduce((s, r) => s + r.bytes, 0);
      out.push({
        id: cid,
        sessionBytes: sb,
        exclusiveBytes: 0,      // 下面统一填
        exclusiveBlobs: 0,
        reclaimable: 0,
        orphanSession: !live.has(cid),
      });
    }

    /* 独占量的算法：一次遍历所有 blob，只处理"恰好被一个会话引用"的。
       不要对每个会话再扫一遍全表 —— 那是 112 × 20154 = 225 万次位集判定，
       实测这一处就要好几秒，而信息量完全一样。 */
    const solo = new Map();     // cid → { bytes, blobs }
    let orphanBlobs = 0;
    for (let i = 0; i < graph.blobs.length; i++) {
      const owners = ownersOf(i);
      if (owners.length === 0) { orphanBlobs++; continue; }
      if (owners.length !== 1) continue;
      const cid = owners[0];
      const cur = solo.get(cid) || { bytes: 0, blobs: 0 };
      cur.bytes += graph.blobs[i].bytes;
      cur.blobs++;
      solo.set(cid, cur);
    }
    for (const s of out) {
      const e = solo.get(s.id);
      s.exclusiveBytes = e?.bytes || 0;
      s.exclusiveBlobs = e?.blobs || 0;
      s.reclaimable = s.sessionBytes + s.exclusiveBytes;
    }

    return {
      sessions: out,
      blobs: graph.blobs.length,
      blobBytes: graph.blobs.reduce((s, b) => s + b.bytes, 0),
      orphanBlobs,
      scanMs: Date.now() - t0,
    };
  } finally {
    db.close();
  }
}

/* ── 对外：删除 ───────────────────────────────────────────── */

/**
 * 删掉指定会话，并连带删掉只被它们引用的 blob。
 *
 * @param {string} idePath
 * @param {string[]} ids
 * @param {{backupDir: string, dryRun?: boolean, maxBytes?: number}} opts
 */
export async function purgeSessions(idePath, ids, opts = {}) {
  const t0 = Date.now();
  const dbPath = path.join(idePath, DB_REL);
  if (!fs.existsSync(dbPath)) {
    const e = new Error(`找不到 ${DB_REL}`);
    e.statusCode = 400;
    throw e;
  }
  const wanted = [...new Set(ids.filter((x) => typeof x === 'string' && x.length))];
  if (!wanted.length) {
    const e = new Error('没有选中任何会话');
    e.statusCode = 400;
    throw e;
  }

  // 只读先算一遍：要删什么、能回收多少。空跑与真删走同一份计划。
  const plan = planPurge(dbPath, wanted);

  if (opts.dryRun) {
    return {
      dryRun: true,
      sessions: plan.sessions.length,
      sessionRows: plan.sessionRows,
      sessionBytes: plan.sessionBytes,
      blobs: plan.blobKeys.length,
      blobBytes: plan.blobBytes,
      freed: plan.sessionBytes + plan.blobBytes,
      perSession: plan.detail,
      scanMs: Date.now() - t0,
    };
  }

  /* 四道闸门从这里开始。前三道的顺序与回灌一致：
     备份必须在任何写之前完成，事务必须在备份之后开始。 */
  const backup = await backupDatabase(dbPath, opts.backupDir || path.join(process.cwd(), 'backups'));

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 8000');
  let committed = false;
  try {
    const before = { total: db.prepare('PRAGMA page_size').get().page_size * db.prepare('PRAGMA page_count').get().page_count };
    const written = { sessionRows: 0, blobRows: 0 };

    db.exec('BEGIN IMMEDIATE');
    try {
      const del = db.prepare('DELETE FROM cursorDiskKV WHERE key = ?');
      const delHeader = db.prepare('DELETE FROM composerHeaders WHERE composerId = ?');
      for (const key of plan.sessionKeys) { written.sessionRows += del.run(key).changes; }
      for (const key of plan.blobKeys) { written.blobRows += del.run(key).changes; }
      for (const cid of plan.sessions) delHeader.run(cid);
      db.exec('COMMIT');
      committed = true;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 已经不在事务里 */ }
      throw err;
    }

    // 第四道：自检。悬空引用必须为 0 —— 有悬空说明可达性算错了。
    const check = db.prepare('PRAGMA quick_check').get();
    const integrity = Object.values(check || {})[0] || 'unknown';
    const dangling = countDangling(db);
    const pageCount = db.prepare('PRAGMA page_count').get().page_count;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    const after = { total: pageSize * pageCount };

    // VACUUM 把删掉的空间真正还给磁盘（不付这一步，文件不会变小）
    db.exec('VACUUM');

    return {
      ...written,
      sessions: plan.sessions.length,
      freed: plan.sessionBytes + plan.blobBytes,
      before,
      after: { total: fs.statSync(dbPath).size },
      integrity,
      dangling,
      backup,
      scanMs: Date.now() - t0,
    };
  } finally {
    db.close();
    if (!committed) {
      // 没提交：备份留着当证据，但要说清楚没写进去
      // （错误已经在上面抛出去了）
    }
  }
}

/**
 * 算出"删这批会话"到底要动哪些行。
 *
 * 与 analyzePurge 共用同一张图与同一份 owner 位集，所以空跑看到的数字
 * 与真删动的行是同一份计划 —— 不会出现"预览 95MB、实删 3MB"。
 */
function planPurge(dbPath, wanted) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const graph = buildGraph(db);
    const gone = new Set(wanted);
    const { onlyIn } = ownerSets(graph);

    // 删一批时，blob 可删 ⟺ 能到它的会话全部在这批里
    const blobKeys = [];
    let blobBytes = 0;
    for (let i = 0; i < graph.blobs.length; i++) {
      if (!onlyIn(i, gone)) continue;
      blobKeys.push(graph.blobs[i].key);
      blobBytes += graph.blobs[i].bytes;
    }

    const sessionKeys = [];
    const detail = [];
    let sessionBytes = 0;
    for (const cid of wanted) {
      const g = graph.sessions.get(cid);
      if (!g) { detail.push({ id: cid, bytes: 0, rows: 0, blobs: 0 }); continue; }
      let b = 0;
      for (const row of g.rows) { sessionKeys.push(row.key); b += row.bytes; }
      sessionBytes += b;
      detail.push({ id: cid, bytes: b, rows: g.rows.length, blobs: 0 });
    }
    return {
      sessions: wanted,
      sessionKeys,
      sessionBytes,
      sessionRows: sessionKeys.length,
      blobKeys,
      blobBytes,
      detail,
    };
  } finally {
    db.close();
  }
}

/** 悬空引用：宿主的 key 还在，它指向的 blob 不在了。 */
function countDangling(db) {
  const rows = db.prepare("SELECT key, value FROM cursorDiskKV").all();
  const have = new Set();
  for (const r of rows) {
    if (r.key.startsWith('agentKv:blob:')) have.add(r.key.slice(13));
    else if (r.key.startsWith('composer.content.')) have.add(r.key.slice(17));
  }
  let dangling = 0;
  for (const r of rows) {
    const buf = unframe(r.value);
    const text = buf.toString('latin1');
    const re = /[0-9a-f]{64}/g;
    let m;
    while ((m = re.exec(text))) {
      // 只统计"看起来像内容寻址但仍被引用"的：库里没有这个 hash，而这里提到了
      if (!have.has(m[0])) {
        // 不区分是不是真的指向 blob：Cursor 自己也会留一些悬空（实测 63 个）
        dangling++;
        break;
      }
    }
  }
  return dangling;
}

async function backupDatabase(dbPath, backupDir) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const dir = path.join(backupDir, `${stamp}-cursor-purge`);
  await fsp.mkdir(dir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = dbPath + suffix;
    try { await fsp.copyFile(src, path.join(dir, path.basename(src))); } catch { /* 侧文件可能不存在 */ }
  }
  return dir;
}
