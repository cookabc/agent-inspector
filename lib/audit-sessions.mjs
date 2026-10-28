/**
 * 凭据外泄审计：各工具会话正文 → 事件流 → lib/audit.mjs 的判定核心。
 *
 * 四家的正文形状（2026-10 实测自本机真实数据，全部只读）：
 *
 *   claude  projects/<slug>/<id>.jsonl —— message.content[] 里的 tool_use /
 *           tool_result 块，按 tool_use_id 配对
 *   codex   sessions/日期/rollout-*.jsonl —— response_item.payload：
 *           custom_tool_call（name=exec，input 是 JS 源码）配 call_id，
 *           function_call（arguments 是 JSON 串）；输出在 *_call_output
 *   zcode   cli/db/db.sqlite 的 part 表 —— data.type='tool' 自带
 *           state.input（command/file_path）与 state.output，输入输出同 row
 *   dsh     sessions/<slug>/session.v4.jsonl.zstd —— tool/call（data.arguments
 *           JSON 串）配 data.callId，tool/result（data.toolCallId）
 *
 * Cursor 不参与：正文散在内容寻址 blob 里，解开整池要十几秒起步，
 * 这个代价留给"按会话清理"那条线（那边有明确的动作要配），审计这里
 * 宁可明说"暂不支持"。
 *
 * 读取纪律与别处同一条：只读、只读打开、副本打开（WAL 库不建 shm）。
 * 这是本工具第二个"读正文"的地方（第一个是 Codex 首行判分页），README
 * 里的"文件清单只 stat"承诺不受影响 —— 那条线仍然不读内容。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { SessionAudit } from './audit.mjs';
import { openReadonly } from './sqlite-open.mjs';
import { rolloutFiles } from './tasks-codex.mjs';

/** 超过这个大小的文件整读进内存太狠，改读开头一段。 */
const READ_FILE_CHUNK = 48 * 1024 * 1024;
/** 单行超过这个长度直接跳过（不解析，计数如实报）。 */
const MAX_LINE = 512 * 1024;

const zstdSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;

function clip(s, n = 80) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

/** 读一个 JSONL 文件的前 READ_FILE_CHUNK 字节，按行产出 {obj|skipped}。
 *  截断的最后一行不解析。超长行跳过并计数。 */
async function* jsonlLines(abs, size, problems) {
  try {
    let text;
    let truncated = false;
    if (size > READ_FILE_CHUNK) {
      const fh = await fsp.open(abs, 'r');
      try {
        const buf = Buffer.alloc(READ_FILE_CHUNK);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        text = buf.subarray(0, bytesRead).toString('utf8');
        truncated = true;
      } finally { await fh.close(); }
    } else {
      text = await fsp.readFile(abs, 'utf8');
    }
    const lines = text.split('\n');
    if (truncated) lines.pop(); // 最后一行多半被截断
    for (const line of lines) {
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE) { yield { skipped: Buffer.byteLength(line) }; continue; }
      try { yield { obj: JSON.parse(line) }; }
      catch { /* 非 JSON 行（各家都会夹纯文本）*/ }
    }
    yield { truncated };
  } catch (err) {
    problems.push(`会话读取失败（${err.code || '读取错误'}）`);
    yield { truncated: true };
  }
}

/** 数组或字符串形态的 content 摊平成纯文本。
 *
 *  `text` / `input_text` / `output_text` 三种块类型都要认：
 *  Codex 的 tool output 用的是 `input_text`，只认 `text` 会让整条输出
 *  静默变成空串 —— 于是"读到的凭据"永远进不了 bank，high 一条也报不出来。
 *  这个 bug 在夹具上表现为"只报 info 不报 high"，很容易被误当成判定写错了。 */
const flattenContent = (c) => {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => {
    if (typeof b === 'string') return b;
    if (typeof b?.text === 'string') return b.text;
    if (typeof b?.content === 'string') return b.content;
    return '';
  }).filter(Boolean).join('\n');
};

/* ── Claude Code ──────────────────────────────────────────── */

export async function auditClaude(root) {
  const base = path.join(root, 'projects');
  if (!fs.existsSync(base)) return emptyResult('找不到 projects/');
  const t0 = Date.now();
  const out = [];
  const problems = [];

  const stack = [base];
  const files = [];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); }
    catch (err) { problems.push(`${relOf(root, cur)}：${err.code || '读取失败'}`); continue; }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(abs); continue; }
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { files.push({ abs, st: await fsp.stat(abs) }); }
        catch (err) { problems.push(`${relOf(root, abs)}：${err.code || '读取失败'}`); }
      }
    }
  }

  for (const { abs, st } of files) {
    const audit = new SessionAudit();
    let title = '';
    let cwd = '';
    let truncated = false;
    for await (const line of jsonlLines(abs, st.size, problems)) {
      if (line.truncated) truncated = true;
      if (line.skipped) { audit.bytes += line.skipped; truncated = true; continue; }
      const o = line.obj;
      if (!o) continue;
      if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
      if (!title && o.type === 'user' && typeof o.message?.content === 'string') title = o.message.content;
      const content = o.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === 'tool_use') {
          const input = b.input || {};
          const id = b.id || null;
          if (typeof input.file_path === 'string') audit.call({ kind: 'read', path: input.file_path, id });
          else if (typeof input.notebook_path === 'string') audit.call({ kind: 'read', path: input.notebook_path, id });
          else if (typeof input.command === 'string') audit.call({ kind: 'cmd', text: input.command, id });
          else if (typeof input.url === 'string') audit.call({ kind: 'web', url: input.url, text: input.prompt || '', id });
          else if (typeof input.query === 'string') audit.call({ kind: 'web', url: '', text: input.query, id });
          else if (typeof input.pattern === 'string') {
            // Grep 也会把匹配行连凭据一起打回来 —— 按命令认路径，输出照样入库
            audit.call({ kind: 'cmd', text: `grep ${input.pattern} ${input.path || ''} ${input.glob || ''}`, id });
          }
        } else if (b?.type === 'tool_result') {
          audit.out({ id: b.tool_use_id, text: flattenContent(b.content) });
        }
      }
      if (audit.full) { truncated = true; break; }
    }
    out.push(sessionResult({
      id: path.basename(abs, '.jsonl'),
      title, workspace: cwd,
      bodyRel: path.relative(root, abs).split(path.sep).join('/'),
      audit, truncated,
    }));
  }
  return { sessions: out, ms: Date.now() - t0, problems };
}

/* ── Codex ────────────────────────────────────────────────── */

export async function auditCodex(root) {
  const t0 = Date.now();
  const out = [];
  const problems = [];
  for (const f of rolloutFiles(root, problems)) {
    const audit = new SessionAudit();
    let cwd = '';
    let truncated = false;
    for await (const line of jsonlLines(f.abs ?? path.join(root, f.rel), f.bytes, problems)) {
      if (line.truncated) truncated = true;
      if (line.skipped) { audit.bytes += line.skipped; truncated = true; continue; }
      const o = line.obj;
      const p = o?.payload;
      if (!p) continue;
      if (o.type === 'session_meta') cwd = p.cwd || p.originator || '';
      if (p.type === 'custom_tool_call') {
        // exec 的 input 是 JS 源码：curl 变成 fetch、读文件变成 fs/tools 调用，
        // 全在文本里 —— 按 code 判（外发判据与 shell 不同）
        audit.call({ kind: 'code', text: String(p.input || ''), id: p.call_id });
      } else if (p.type === 'function_call') {
        const mapped = mapJsonArgs(p.arguments);
        if (mapped) audit.call({ ...mapped, id: p.call_id });
        else if (typeof p.name === 'string' && /web|fetch|search|browse/i.test(p.name)) {
          audit.call({ kind: 'web', url: '', text: String(p.arguments || ''), id: p.call_id });
        }
      } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
        audit.out({ id: p.call_id, text: flattenContent(p.output) });
      }
      if (audit.full) { truncated = true; break; }
    }
    out.push(sessionResult({
      id: f.id,
      title: '', workspace: cwd,
      bodyRel: f.rel,
      audit, truncated,
    }));
  }
  return { sessions: out, ms: Date.now() - t0, problems };
}

/** Codex function_call 的 arguments（JSON 串）→ 事件。认不出的形状返回 null ——
 *  审计线宁可少看一类调用，也不用错误的语义去猜。 */
function mapJsonArgs(argsText) {
  if (typeof argsText !== 'string' || !argsText) return null;
  let args;
  try { args = JSON.parse(argsText); } catch { return null; }
  if (!args || typeof args !== 'object') return null;
  if (typeof args.command === 'string') return { kind: 'cmd', text: args.command };
  if (typeof args.cmd === 'string') return { kind: 'cmd', text: args.cmd };
  if (typeof args.file_path === 'string') return { kind: 'read', path: args.file_path };
  if (typeof args.url === 'string') return { kind: 'web', url: args.url, text: args.prompt || '' };
  if (typeof args.code === 'string') return { kind: 'code', text: args.code };
  return null;
}

/* ── ZCode ────────────────────────────────────────────────── */

/**
 * part 表的 data.type='tool' 行自带 input 与 output —— 输入输出同 row，
 * call 和 out 背靠背喂即可。子 Agent 会话（parent_id 非空）按家族归并，
 * 与「会话管理」那张表的口径一致：审计出的命中挂到家族根上。
 *
 * 大库纪律：不做一次 SELECT * 的全表物化（1.4 GB 的库会把内存吃穿），
 * 每个会话按 sequence 键集分页，每页 500 行；家族累计超限就停。
 */
export function auditZcode(root) {
  const t0 = Date.now();
  const main = path.join(root, 'cli', 'db', 'db.sqlite');
  if (!fs.existsSync(main)) return { ...emptyResult('找不到 db.sqlite'), ms: 0 };
  const db = openReadonly(main);
  if (!db) return { ...emptyResult('db.sqlite 打不开（只读）'), ms: 0 };

  const out = [];
  try {
    const rows = db.prepare('SELECT id, parent_id, title, directory, time_created FROM session').all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const rootOf = (id) => {
      const seen = new Set();
      let cur = byId.get(id);
      while (cur?.parent_id && !seen.has(cur.parent_id)) {
        seen.add(cur.id);
        const parent = byId.get(cur.parent_id);
        if (!parent) break;
        cur = parent;
      }
      return cur;
    };
    const families = new Map();
    for (const r of rows) {
      const root = rootOf(r.id);
      if (!families.has(root.id)) families.set(root.id, { root, members: [] });
      families.get(root.id).members.push(r);
    }
    for (const fam of families.values()) {
      fam.members.sort((a, b) => (a.time_created || 0) - (b.time_created || 0));
    }

    /* 分页游标用 rowid，不能用 sequence。
       实测本机库：一个会话 9568 行 part，sequence 的取值范围只有 0–9 ——
       同一 sequence 上有上千行。按 `sequence >= ?` + LIMIT 500 分页时，
       游标取到的还是同一个值，下一轮把同一批又取回来，于是**死循环**，
       整个 /api/audit 挂住不返回（真机上表现为"点了安全审计一直转圈"）。
       rowid 在 SQLite 里对所有表（包括 WITHOUT ROWID 之外的一切）单调且唯一，
       按它分页才真的推进。顺序仍按 sequence, rowid —— 落盘顺序由 sequence 决定，
       rowid 只用来定分页边界。 */
    const selectParts = db.prepare(
      'SELECT rowid AS rid, sequence, data FROM part WHERE session_id = ? AND rowid > ? ORDER BY rowid LIMIT 500'
    );
    for (const fam of [...families.values()].sort((a, b) => (b.root.time_created || 0) - (a.root.time_created || 0))) {
      const audit = new SessionAudit();
      let truncated = false;
      let n = 0;
      for (const m of fam.members) {
        let cursor = 0;
        for (;;) {
          const chunk = selectParts.all(m.id, cursor);
          if (!chunk.length) break;
          for (const row of chunk) {
            cursor = row.rid;
            let d;
            try { d = JSON.parse(row.data); } catch { continue; }
            if (d?.type !== 'tool') continue;
            const st = d.state || {};
            const input = st.input || {};
            const id = `z${n++}`;
            if (typeof input.file_path === 'string') audit.call({ kind: 'read', path: input.file_path, id });
            else if (typeof input.command === 'string') audit.call({ kind: 'cmd', text: input.command, id });
            else if (typeof input.url === 'string') audit.call({ kind: 'web', url: input.url, text: input.prompt || input.query || '', id });
            else continue;
            audit.out({ id, text: typeof st.output === 'string' ? st.output : flattenContent(st.output) });
          }
          if (chunk.length < 500) break;
          if (audit.full) { truncated = true; break; }
        }
        if (truncated || audit.full) { truncated = true; break; }
      }
      out.push(sessionResult({
        id: fam.root.id,
        title: fam.root.title || '',
        workspace: fam.root.directory || '',
        bodyRel: null,
        audit, truncated,
      }));
    }
  } finally { db.close(); }
  return { sessions: out, ms: Date.now() - t0, problems: [] };
}

/* ── DeepSeek Harness ─────────────────────────────────────── */

export async function auditDsh(root) {
  const t0 = Date.now();
  const base = path.join(root, 'sessions');
  if (!fs.existsSync(base)) return emptyResult('找不到 sessions/');
  if (!zstdSync) {
    return { ...emptyResult(`当前 Node（${process.version}）没有内置 zstd 解压，DeepSeek 会话正文解不开（22.15 / 23.8 起才有）`), ms: 0 };
  }
  const out = [];
  const problems = [];

  const stack = [base];
  const bodies = [];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); }
    catch (err) { problems.push(`${relOf(root, cur)}：${err.code || '读取失败'}`); continue; }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(abs); continue; }
      if (e.isFile() && e.name.endsWith('.jsonl.zstd')) {
        try { bodies.push({ abs, st: await fsp.stat(abs) }); }
        catch (err) { problems.push(`${relOf(root, abs)}：${err.code || '读取失败'}`); }
      }
    }
  }

  for (const { abs, st } of bodies) {
    const audit = new SessionAudit();
    let title = '';
    let truncated = false;
    let text;
    try {
      const decoded = zstdSync(await fsp.readFile(abs), { maxOutputLength: 96 * 1024 * 1024 });
      truncated = decoded.length > READ_FILE_CHUNK;
      text = decoded.subarray(0, READ_FILE_CHUNK).toString('utf8');
    } catch (err) {
      problems.push(`${relOf(root, abs)}：正文读取或解压失败（${err.code || '解压错误'}）`);
      continue;
    }
    const lines = text.split('\n');
    for (const line of (truncated ? lines.slice(0, lines.length - 1) : lines)) {
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE) { audit.bytes += Buffer.byteLength(line); truncated = true; continue; }
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || typeof o !== 'object') continue;
      const d = o?.data;
      if (o.type === 'user/message' && !title) {
        const part = (Array.isArray(d?.content) ? d.content : []).find(c => c?.type === 'text' && typeof c.text === 'string');
        if (part) title = part.text;
      }
      if (o.type === 'tool/call' && d) {
        const args = mapJsonArgs(typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? {}));
        if (args) audit.call({ ...args, id: d.callId });
        else if (typeof d.name === 'string' && /web|fetch|search|browse/i.test(d.name)) {
          audit.call({ kind: 'web', url: '', text: String(d.arguments || ''), id: d.callId });
        }
      } else if (o.type === 'tool/result' && d) {
        audit.out({ id: d.toolCallId || d.callId, text: flattenContent(d.content) || flattenContent(d.message?.content) });
      }
      if (audit.full) { truncated = true; break; }
    }
    out.push(sessionResult({
      id: path.basename(path.dirname(abs)),
      title, workspace: '',
      bodyRel: relOf(root, abs),
      audit, truncated,
    }));
    void st;
  }
  return { sessions: out, ms: Date.now() - t0, problems };
}

const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

/* ── 汇总出口 ─────────────────────────────────────────────── */

function emptyResult(problem) {
  return { sessions: [], ms: 0, problems: [problem] };
}

function sessionResult({ id, title, workspace, bodyRel, audit, truncated }) {
  const done = audit.done();
  return {
    id: audit.redact(id), title: clip(audit.redact(title)) || '(无标题)',
    workspace: audit.redact(workspace) || '', bodyRel: audit.redact(bodyRel) || null,
    ...done,
    truncated: Boolean(truncated || done.truncated),
    // 高/中两级是"要处理的事"，info 只是"该知道的事"——列表排序按这个口径
    serious: done.findings.filter((f) => f.level !== 'info').length,
  };
}

/**
 * 按 app.history 分发。与 scanTasks 同一张路由表 —— 加一家支持改这里，
 * 不在 server 里散落 if。
 */
export async function auditApp(app, targets) {
  const root = targets[0].path;
  const byHistory = {
    'claude-files': auditClaude,
    'codex-db': auditCodex,
    'zcode-db': auditZcode,
    'dsh-files': auditDsh,
  };
  const empty = { sessionsScanned: 0, bytesScanned: 0, truncatedSessions: 0, hits: [], hitsDropped: 0, totals: { high: 0, medium: 0, info: 0 } };
  if (app.history === 'cursor-db') {
    return { supported: false, reason: 'Cursor 的会话正文在内容寻址 blob 里，解开整池的代价留给"按会话清理"那条线，审计暂不支持', ...empty, ms: 0, problems: [] };
  }
  const fn = byHistory[app.history];
  if (!fn) return { supported: false, reason: `不认识的历史类型：${app.history}`, ...empty, ms: 0, problems: [] };
  let result;
  try {
    result = await fn(root);
  } catch (err) {
    return { supported: true, ...empty, ms: 0, problems: [new SessionAudit().redact(err.message || String(err))] };
  }

  /* 列表只收"有高危或疑似"的会话。只读过敏感文件的会话（P3-only）不进 ——
     读 .env 是极常见的常规操作，全列出来会把真正的外发淹掉。它们的数量
     仍在 totals.info 里如实报出，前端据此说明"另有 N 次读取"。 */
  const hits = result.sessions.filter((s) => s.findings.some((f) => f.level === 'high' || f.level === 'medium'));
  hits.sort((a, b) => (b.findings.filter((f) => f.level === 'high').length - a.findings.filter((f) => f.level === 'high').length)
    || (b.findings.length - a.findings.length));
  const capped = hits.slice(0, 120);
  return {
    supported: true,
    sessionsScanned: result.sessions.length,
    bytesScanned: result.sessions.reduce((s, x) => s + x.bytes, 0),
    truncatedSessions: result.sessions.filter((x) => x.truncated).length,
    hits: capped,
    hitsDropped: Math.max(0, hits.length - capped.length),
    totals: {
      high: sum(result.sessions, (s) => count(s, 'high')),
      medium: sum(result.sessions, (s) => count(s, 'medium')),
      info: sum(result.sessions, (s) => count(s, 'info')),
    },
    ms: result.ms,
    problems: (result.problems || []).map(p => new SessionAudit().redact(p)),
  };
}

const count = (s, level) => s.findings.filter((f) => f.level === level).length;
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
