/**
 * Cursor 孤儿会话：把"界面里已经看不到、但 .jsonl 还留在磁盘上"的会话找回来。
 *
 * 为什么会有孤儿：
 *   Cursor 的会话列表只认 state.vscdb 的 composerHeaders。transcript 文件
 *   （~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl）是另一份存储，
 *   两者没有同步机制。配置目录被重建、迁移失败或清理过后，头没了，正文却还在。
 *
 * 这里做两件事：
 *   scanOrphans    只读——把头里没有的 transcript 列出来（标题/日期/消息数/工作区）
 *   reimportOrphans 受控写入——按 Cursor 自己的结构合成
 *                   composerHeaders + cursorDiskKV(composerData / bubbleId) 三组行
 *
 * 写入是**非官方路径**，所以闸门写在服务端：Cursor 必须完全退出、先整库备份、
 * 事务内完成、写完自检；已存在头的会话一律跳过，绝不覆盖任何现有会话。
 *
 * 恢复的是文本正文。工具调用以引用行保留，检查点（checkpointId）与
 * 内容寻址 blob（agentKv）没有可重建的来源，不伪造。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { writeDatabases } from './database-write.mjs';
import { validateIds, validateDryRun } from './validation.mjs';
import { openReadonly, cleanupCopies } from './sqlite-open.mjs';

const DB_REL = path.join('User', 'globalStorage', 'state.vscdb');
const VERSION_KEY = 'composer.composerHeaders.version';
/* 确认串不在这里定义 —— 三条改动磁盘的路径共用 lib/confirm-words.mjs 那一份，
   由服务端校验、随 /api/scan 下发给前端做门控。本地另存一份，改词时必然漏。 */

/* ── 只读扫描 ─────────────────────────────────────────────── */

/**
 * 列出界面看不到的会话。
 *
 * @param {string} cliPath  ~/.cursor
 * @param {string} idePath  ~/Library/Application Support/Cursor
 * @returns {Promise<{sessions: Array, total: number, headers: number, transcripts: number,
 *   orphanBytes: number, problems: string[], scanMs: number}>}
 */
export async function scanOrphans(cliPath, idePath) {
  const t0 = Date.now();
  const problems = [];
  const dbPath = path.join(idePath, DB_REL);

  let headers = new Set();
  if (fs.existsSync(dbPath)) {
    const db = openReadonly(dbPath);
    if (db) {
      try {
        for (const r of db.prepare('SELECT composerId FROM composerHeaders').all()) headers.add(r.composerId);
      } catch (err) {
        problems.push(`composerHeaders 读不出来：${err.message}`);
      } finally { db.close(); }
    } else {
      problems.push('state.vscdb 打不开（只读）');
    }
  } else {
    problems.push(`找不到 ${DB_REL}`);
  }

  if (problems.length) {
    await cleanupCopies();
    return { sessions: [], total: 0, headers: 0, transcripts: 0, orphanBytes: 0,
      problems, scanMs: Date.now() - t0 };
  }
  const files = transcriptFiles(cliPath);
  const sessions = [];
  let empty = 0;
  for (const item of files) {
    if (headers.has(item.id)) continue;
    try {
      const summary = await summarize(item.file);
      // 空 transcript（只有 turn_ended 或几行元数据）没有可回灌的正文 ——
      // 列出来也只会让人选中后得到 "导入 0 条"，不如直接跳过并说明。
      if (!summary.entries.length) { empty++; continue; }
      const resolved = workspacePath(item.workspace);
      sessions.push({
        id: item.id,
        workspaceSlug: item.workspace,
        workspace: resolved || item.workspace,
        workspaceResolved: Boolean(resolved),
        title: summary.title,
        date: summary.date,
        messages: summary.messages,
        userMessages: summary.userMessages,
        assistantMessages: summary.assistantMessages,
        tools: summary.tools,
        bubbles: summary.bubbles,
        bytes: fs.statSync(item.file).size,
        errors: summary.errors,
        transcript: path.relative(cliPath, item.file),
      });
    } catch (err) {
      problems.push(`${item.workspace}/${item.id}：${err.message}`);
    }
  }

  sessions.sort((a, b) => b.date - a.date);
  if (empty) problems.push(`${empty} 个 transcript 没有任何正文（只剩元数据），已跳过`);
  await cleanupCopies();
  return {
    sessions,
    total: sessions.length,
    headers: headers.size,
    transcripts: files.length,
    orphanBytes: sessions.reduce((s, x) => s + x.bytes, 0),
    problems,
    scanMs: Date.now() - t0,
  };
}

/** ~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl */
function transcriptFiles(cliPath) {
  const base = path.join(cliPath, 'projects');
  const out = [];
  let names;
  try { names = fs.readdirSync(base); } catch { return out; }
  for (const workspace of names) {
    const dir = path.join(base, workspace, 'agent-transcripts');
    let ids;
    try { ids = fs.readdirSync(dir); } catch { continue; }
    for (const id of ids) {
      const file = path.join(dir, id, `${id}.jsonl`);
      try { if (fs.statSync(file).isFile()) out.push({ id, workspace, file }); } catch { /* 不是文件 */ }
    }
  }
  return out;
}

/**
 * 把 transcript 逐行读成"气泡"级别的条目。流式读取，几十 MB 的会话也不会一次性进内存。
 */
async function summarize(file) {
  const entries = [];
  let firstTs = null;
  let firstUser = '';
  let userMessages = 0, assistantMessages = 0, tools = 0, errors = 0;
  let turnError = '';

  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type === 'turn_ended') {
      if (obj.status && obj.status !== 'success') { errors++; turnError = String(obj.error || obj.status); }
      continue;
    }
    const blocks = contentBlocks(obj);
    if (obj?.role === 'user') {
      const raw = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
      const { ts, text } = cleanUserText(raw);
      if (ts && !firstTs) firstTs = ts;
      if (!text) continue;
      userMessages++;
      if (!firstUser) firstUser = text;
      entries.push({ type: 1, text });
    } else if (obj?.role === 'assistant') {
      const parts = [];
      for (const b of blocks) {
        if (b?.type === 'text' && String(b.text || '').trim()) parts.push(String(b.text).trim());
        else if (b?.type === 'tool_use') {
          tools++;
          parts.push(toolLine(b));
        }
      }
      if (!parts.length) continue;
      assistantMessages++;
      entries.push({ type: 2, text: parts.join('\n\n') });
    }
  }

  const stat = fs.statSync(file);
  const date = parseTimestamp(firstTs) ?? Math.round(stat.mtimeMs);
  const title = firstLine(firstUser) || '未命名会话';
  return {
    entries, title, date, userMessages, assistantMessages, tools, errors,
    turnError, messages: userMessages + assistantMessages, bubbles: entries.length,
  };
}

function contentBlocks(obj) {
  const c = obj?.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c.filter((b) => b && typeof b === 'object') : [];
}

function cleanUserText(raw) {
  let text = String(raw || '');
  let ts = null;
  const m = /<timestamp>([\s\S]*?)<\/timestamp>/i.exec(text);
  if (m) { ts = m[1].trim(); text = text.replace(m[0], ''); }
  const q = /<user_query>([\s\S]*?)<\/user_query>/i.exec(text);
  if (q) text = q[1];
  text = text.replace(/<\/?user_query>/gi, '').trim();
  return { ts, text };
}

const HINT_KEYS = ['path', 'file_path', 'command', 'query', 'url', 'pattern', 'target_directory', 'description'];

function toolLine(block) {
  const name = block.name || 'tool';
  let input = block.input;
  let hint = '';
  if (typeof input === 'string') hint = oneLine(input);
  else if (input && typeof input === 'object') {
    for (const key of HINT_KEYS) {
      if (typeof input[key] === 'string' && input[key].trim()) { hint = oneLine(input[key]); break; }
    }
  }
  return `> 🔧 \`${name}\`${hint ? ` — ${hint}` : ''}`;
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 140);
const firstLine = (s) => String(s || '').split('\n').map((x) => x.trim()).find(Boolean)?.slice(0, 80) || '';

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "Tuesday, May 19, 2026, 3:43 PM (UTC+8)" → epoch ms。解析不了就返回 null。 */
function parseTimestamp(raw) {
  if (!raw) return null;
  const m = /([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(raw);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (mon == null) return null;
  let hour = Number(m[4]) % 12;
  if (/pm/i.test(m[6])) hour += 12;
  const off = /\(UTC([+-]\d{1,2})\)/i.exec(raw);
  const base = Date.UTC(Number(m[3]), mon, Number(m[2]), hour, Number(m[5]));
  return base - (off ? Number(off[1]) * 3600_000 : 0);
}

/**
 * 把 projects/ 下的目录名还原成真实路径。
 *
 * Cursor 用 "路径里每个 / 换成 -" 生成 slug，所以一个 slug 可能对应多种切分。
 * 这里只承认**磁盘上真实存在**的切法；多个都成立时取最深的那个（最贴近完整路径）。
 * 一个都还原不出来就返回 null —— 不猜。
 */
export function workspacePath(slug) {
  const home = os.homedir();
  const prefix = home.replace(/^\/+/, '').replace(/\//g, '-');
  if (slug === prefix) return home;
  if (!slug.startsWith(prefix + '-')) return null;
  const rest = slug.slice(prefix.length + 1);
  const dashes = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === '-') dashes.push(i);
  if (dashes.length > 12) return null;                 // 2^12 已是上限，再长就不枚举
  const parts = [];
  const total = 1 << dashes.length;
  for (let mask = 0; mask < total; mask++) {
    let s = rest;
    // 从后往前替换，避免下标错位
    for (let k = dashes.length - 1; k >= 0; k--) {
      if (mask & (1 << k)) s = s.slice(0, dashes[k]) + path.sep + s.slice(dashes[k] + 1);
    }
    const abs = path.join(home, s);
    try { if (fs.statSync(abs).isDirectory()) parts.push(abs); } catch { /* 不存在 */ }
  }
  if (!parts.length) return null;
  return parts.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)[0];
}

/* ── 回灌 ─────────────────────────────────────────────────── */

/**
 * 把孤儿会话写回 state.vscdb。
 *
 * @param {string} cliPath
 * @param {string} idePath
 * @param {string[]} ids       要恢复的会话 id（空 = 全部孤儿）
 * @param {{backupDir:string, dryRun?:boolean}} opts
 */
export async function reimportOrphans(cliPath, idePath, ids = [], opts = {}) {
  validateIds(ids);
  validateDryRun(opts.dryRun ?? false);
  const dbPath = path.join(idePath, DB_REL);
  if (!fs.existsSync(dbPath)) {
    throw Object.assign(new Error(`找不到 ${DB_REL}`), { statusCode: 400 });
  }

  const scan = await scanOrphans(cliPath, idePath);
  const wanted = scan.sessions.filter((s) => ids.includes(s.id));
  if (!wanted.length) {
    return { imported: 0, bubbles: 0, sessions: [], skipped: ids.length, dryRun: Boolean(opts.dryRun) };
  }

  // 空跑只需要数目：正文解析在 scanOrphans 里已经做过
  if (opts.dryRun) {
    return {
      dryRun: true,
      imported: wanted.length,
      bubbles: wanted.reduce((s, x) => s + x.bubbles, 0),
      sessions: wanted.map((s) => ({ id: s.id, title: s.title, bubbles: s.bubbles })),
      backup: null,
    };
  }

  const { result, backup } = await writeDatabases([dbPath],
    { backupDir: opts.backupDir || path.join(process.cwd(), 'backups'), label: 'cursor-recover', vacuum: false, root: idePath },
    async ([db]) => {
      assertSchema(db);
      const templates = loadTemplates(db);
      const existing = new Set(db.prepare('SELECT composerId FROM composerHeaders').all().map(r => r.composerId));
      const byPath = workspaceIndex(db);
      const rows = [];
      for (const s of wanted) {
        if (existing.has(s.id)) continue;
        // A missing header does not imply the body is missing. Never replace orphan KV data.
        const owned = db.prepare(`SELECT 1 AS found FROM cursorDiskKV WHERE key = ? OR substr(key,1,?) = ? OR substr(key,1,?) = ? LIMIT 1`)
          .get(`composerData:${s.id}`, `bubbleId:${s.id}:`.length, `bubbleId:${s.id}:`,
            `checkpointId:${s.id}:`.length, `checkpointId:${s.id}:`);
        if (owned?.found === 1) continue;
        const full = await summarize(path.join(cliPath, s.transcript));
        if (!full.entries.length) continue;
        rows.push(buildRows(s, full, templates, byPath));
        existing.add(s.id);
      }
      const headerStmt = db.prepare(`INSERT INTO composerHeaders
        (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency,
         checkpointAt, subagentTypeName, value) VALUES (?,?,?,?,0,0,?,NULL,'',?)`);
      // Explicit OR ABORT also overrides a schema-level ON CONFLICT REPLACE policy.
      const kvStmt = db.prepare('INSERT OR ABORT INTO cursorDiskKV (key, value) VALUES (?,?)');
      for (const r of rows) {
        headerStmt.run(r.header.composerId, r.workspaceId, r.header.createdAt, r.header.lastUpdatedAt,
          r.header.lastUpdatedAt, JSON.stringify(r.header));
        kvStmt.run(`composerData:${r.header.composerId}`, JSON.stringify(r.composer));
        for (const b of r.bubbles) kvStmt.run(`bubbleId:${r.header.composerId}:${b.bubbleId}`, JSON.stringify(b));
      }
      if (rows.length) db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?,?)').run(VERSION_KEY, `${Date.now()}-1`);
      return { imported: rows.length, bubbles: rows.reduce((s, r) => s + r.bubbles.length, 0),
        sessions: rows.map(r => ({ id: r.header.composerId, title: r.header.name })),
        skipped: wanted.length - rows.length, db: dbStats(db) };
    });
  return { ...result, backup, integrity: 'ok' };
}

function assertSchema(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const t of ['composerHeaders', 'cursorDiskKV', 'ItemTable']) {
    if (!tables.has(t)) {
      throw Object.assign(new Error(`state.vscdb 里没有 ${t} 表，无法回灌`), { statusCode: 400 });
    }
  }
}

function loadTemplates(db) {
  const row = db.prepare(`
    SELECT h.composerId, h.value, d.value AS composer
    FROM composerHeaders h
    JOIN cursorDiskKV d ON d.key = 'composerData:' || h.composerId
    ORDER BY COALESCE(h.lastUpdatedAt, h.createdAt) DESC LIMIT 1
  `).all()[0];
  if (!row) throw Object.assign(new Error('库里没有可作模板的会话（需要至少一条可见会话）'), { statusCode: 400 });

  // 注意：json_extract 返回 INTEGER，参数必须也是数字。
  // 传 '1' 时 SQLite 不会做类型转换，INTEGER 与 TEXT 永不相等。
  const bubble = (type) => db.prepare(`
    SELECT value FROM cursorDiskKV
    WHERE key LIKE ? AND json_extract(value, '$.type') = ?
      AND length(COALESCE(json_extract(value, '$.text'), '')) > 20
    LIMIT 1
  `).all(`bubbleId:${row.composerId}:%`, type)[0];

  const header = JSON.parse(row.value);
  const composer = JSON.parse(row.composer);
  const fallbackWid = db.prepare(`
    SELECT workspaceId FROM composerHeaders
    GROUP BY workspaceId ORDER BY count(*) DESC LIMIT 1
  `).get()?.workspaceId;
  const workspaceId = header.workspaceIdentifier?.id || fallbackWid;
  if (!workspaceId) {
    throw Object.assign(new Error('库里没有可用的 workspaceId，无法回灌'), { statusCode: 400 });
  }
  return {
    header, composer,
    userBubble: bubble(1) ? JSON.parse(bubble(1).value) : null,
    assistantBubble: bubble(2) ? JSON.parse(bubble(2).value) : null,
    workspaceId,
    workspaceIdentifier: header.workspaceIdentifier || null,
  };
}

/** 现有会话头里出现过的 fsPath → { workspaceId, identifier }，按路径复用工作区。 */
function workspaceIndex(db) {
  const out = new Map();
  for (const r of db.prepare('SELECT workspaceId, value FROM composerHeaders').all()) {
    let h;
    try { h = JSON.parse(r.value); } catch { continue; }
    const p = h.workspaceIdentifier?.uri?.fsPath;
    if (p && !out.has(p)) out.set(p, { workspaceId: r.workspaceId, identifier: h.workspaceIdentifier });
  }
  return out;
}

function buildRows(session, full, templates, byPath) {
  const start = full.date || Date.now();
  // 路径还原不出来（项目目录已删除）时不要把 slug 当成路径写进库：
  // 宁可沿用模板会话的工作区，让会话先出现在列表里，界面会标注"路径未还原"。
  const ws = byPath.get(session.workspace) || {
    workspaceId: templates.workspaceId,
    identifier: templates.workspaceIdentifier,
  };
  const identifier = ws.identifier || { id: ws.workspaceId, uri: uriFor(session.workspace) };

  const bubbles = full.entries.map((e, i) => {
    const tpl = e.type === 1 ? templates.userBubble : templates.assistantBubble;
    if (!tpl) throw Object.assign(new Error('库里缺少可作模板的气泡'), { statusCode: 400 });
    const b = { ...tpl };
    b.bubbleId = randomUUID();
    b.type = e.type;
    b.text = e.text;
    b.richText = richText(e.text);
    b.createdAt = new Date(start + i * 1000).toISOString();
    b.tokenCount = { inputTokens: 0, outputTokens: 0 };
    b.requestId = '';
    b.conversationState = '~';
    b.context = emptyContext(tpl.context);
    b.toolResults = [];
    b.codeBlocks = [];
    b.isAgentic = false;
    b.unifiedMode = 2;
    delete b.checkpointId;
    if (e.type === 1) {
      b.agentMode = 1;
      b.modelInfo = { modelName: 'auto' };
    } else {
      b.startedAtMs = start + i * 1000;
      b.turnDurationMs = 0;
    }
    return b;
  });

  const createdMs = start;
  const updatedMs = start + bubbles.length * 1000;
  const title = session.title;

  const header = {
    ...templates.header,
    type: 'head',
    composerId: session.id,
    name: title,
    createdAt: createdMs,
    lastUpdatedAt: updatedMs,
    hasUnreadMessages: false,
    contextUsagePercent: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    filesChangedCount: 0,
    subtitle: '',
    hasBlockingPendingActions: false,
    hasPendingPlan: false,
    isDraft: false,
    isEphemeral: false,
    trackedGitRepos: [],
    workspaceIdentifier: identifier,
  };
  delete header.conversationCheckpointLastUpdatedAt;

  const composer = {
    ...templates.composer,
    composerId: session.id,
    name: title,
    createdAt: createdMs,
    lastUpdatedAt: updatedMs,
    hasLoaded: true,
    text: '',
    richText: emptyRichText(),
    fullConversationHeadersOnly: bubbles.map((b) => ({
      bubbleId: b.bubbleId,
      type: b.type,
      grouping: { isRenderable: true, hasText: true, isShortPlainText: true, toolDisplayComputed: true },
      contentHeightHint: 42,
      createdAt: b.createdAt,
    })),
    conversationMap: {},
    status: 'completed',
    generatingBubbleIds: [],
    context: emptyContext(templates.composer.context),
    originalFileStates: {},
    newlyCreatedFiles: [],
    newlyCreatedFolders: [],
    capabilities: [],
    usageData: {},
    contextUsagePercent: 0,
    contextTokensUsed: 0,
    contextTokenLimit: 200000,
    promptTokenBreakdown: { totalUsedTokens: 0, maxTokens: 0, categories: [] },
    allAttachedFileCodeChunksUris: [],
    subComposerIds: [],
    subagentComposerIds: [],
    capabilityContexts: [],
    todos: [],
    hasUnreadMessages: false,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    trackedGitRepos: [],
    isDraft: false,
    isAgentic: true,
    unifiedMode: 'agent',
    forceMode: 'edit',
    workspaceIdentifier: identifier,
    subtitle: '',
    filesChangedCount: 0,
    latestChatGenerationUUID: randomUUID(),
    queueItems: [],
    isNAL: true,
    isEphemeral: false,
  };
  for (const key of ['conversationState', 'blobEncryptionKey', 'speculativeSummarizationEncryptionKey',
    'conversationCheckpointLastUpdatedAt']) delete composer[key];

  return { header, composer, bubbles, workspaceId: ws.workspaceId };
}

function uriFor(p) {
  return { $mid: 1, fsPath: p, external: `file://${p}`, path: p, scheme: 'file' };
}

function emptyContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(ctx)) out[k] = Array.isArray(v) ? [] : v && typeof v === 'object' ? {} : null;
  return out;
}

function emptyRichText() {
  return JSON.stringify({ root: { children: [], format: '', indent: 0, type: 'root', version: 1 } });
}

function richText(text) {
  return JSON.stringify({
    root: {
      children: [{
        children: [{ detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 }],
        direction: 'ltr', format: '', indent: 0, type: 'paragraph', version: 1,
      }],
      direction: 'ltr', format: '', indent: 0, type: 'root', version: 1,
    },
  });
}

function dbStats(db) {
  const headers = db.prepare('SELECT count(*) n FROM composerHeaders').get()?.n || 0;
  const kv = db.prepare("SELECT count(*) n FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").get()?.n || 0;
  return { headers, bubbles: kv };
}
