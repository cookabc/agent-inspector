/**
 * DeepSeek Harness 的历史会话：读索引，删文件。
 *
 * 它和另外四家都不同：**没有会话数据库，正文是 zstd 压缩的 JSONL**，
 * 一个会话一个目录：
 *
 *   sessions/<工作区 slug>/session-<uuid>/session.v4.jsonl.zstd
 *   sessions/<工作区 slug>/session-<uuid>/session.lock
 *
 * 元数据不在正文里，而在两份**未压缩**的 JSON：
 *   storages/workspace.json                       工作区表（路径、会话归属、归档、置顶）
 *   storages/session_projcache/sessions/<id>.json  每个会话的投影（标题、cwd、模型、步数）
 *
 * 所以列表**不需要解压任何东西** —— 投影缓存已经把要显示的都写好了。
 * 只有投影缺失（会话建了但没在界面上渲染过）时才回落到解压正文，
 * 而且只读开头一段。zstd 是 Node 自带的（`zlib.zstdDecompressSync`，
 * 22.15 / 23.8 起有），老版本上自动降级：仍然列出会话与体积，只是没有标题，
 * 并把原因写进 problems —— 不假装"这个工具没有会话"。
 *
 * 删除走文件清理那条线：没有库可 VACUUM，也没有行可删。
 * 删掉的是正文文件，会话目录里那个空的 session.lock 会留下 ——
 * 它归在「会话锁文件」那一类（safe），在文件清单里一键可清。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { normalizeRow, sortTasks, totalsOf } from './tasks-shape.mjs';
import { emptyContents, addTree, pushFile } from './session-contents.mjs';

const WORKSPACE_JSON = path.join('storages', 'workspace.json');
const PROJ_DIR = path.join('storages', 'session_projcache', 'sessions');
const BODY_SUFFIX = '.jsonl.zstd';

/** 兜底解压只读正文开头这么多行 —— 标题与 cwd 都在最前面。 */
const HEAD_LINES = 400;
/** 解压输出的上限，防一条畸形文件把内存吃穿。 */
const MAX_INFLATE = 96 * 1024 * 1024;

const zstdSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;

export async function scanTasks(root) {
  const t0 = Date.now();
  const problems = [];

  const base = path.join(root, 'sessions');
  if (!fs.existsSync(base)) {
    return {
      tasks: [], totals: totalsOf([]), db: dbInfo([]),
      problems: ['找不到 sessions/'], scanMs: 0,
    };
  }

  const index = readIndex(root, problems);
  const projections = await readProjections(root, problems);
  const dirs = await walkSessions(root, problems);

  const tasks = [];
  let bodyless = 0;

  for (const d of dirs) {
    const body = d.files.find((f) => f.name.endsWith(BODY_SUFFIX));
    // 没有正文文件的会话目录只剩一个空锁 —— 这里没有东西可删，
    // 也不该画成一条"可勾但删不动"的会话（那个空锁在文件清单里能清）。
    if (!body) { bodyless += 1; continue; }

    const proj = projections.get(d.id) || null;
    const meta = proj || await fallbackMeta(body.abs, body.bytes, problems);

    // 工作区优先取索引表里的归属：投影里的 cwd 可能被会话自己改过（cd 到别处），
    // 而索引记录的是"这个会话挂在哪个工作区"。
    const workspace = index.workspaceOf.get(d.id) || meta.cwd || '';
    const archived = index.archived.has(d.id);
    const empty = body.bytes === 0;

    tasks.push(normalizeRow({
      id: d.id,
      title: meta.title || `(无标题) ${d.id}`,
      workspace,
      // Harness 没有"界面已删除"这个中间态：目录在就代表会话在
      state: empty ? 'empty' : (archived ? 'archived' : 'active'),
      reason: empty ? 'empty' : (archived ? 'archived' : reasonOf(workspace)),
      pinned: index.pinned.has(d.id),
      model: meta.model || '',
      typeLabel: meta.preset && meta.preset !== 'standard' ? meta.preset : '对话',
      createdAt: meta.createdAt || d.mtime,
      // 正文文件的 mtime 才是"最后一次写" —— 投影里的 lastPromptAt 只记提问时刻，
      // 一轮里后面的工具调用与回复不算进去。
      updatedAt: body.mtime || meta.createdAt || 0,
      bytes: body.bytes,
      rows: meta.steps || 0,
      bodyRel: body.rel,
      // 清理方式：删文件，不是删行
      residual: true,
    }));
  }

  if (bodyless) {
    problems.push(
      `有 ${bodyless} 个会话目录里已经没有正文文件（只剩 session.lock），不在这里列出 —— ` +
      `那些空锁归在「会话锁文件」一类，可以在文件清单里清掉。`
    );
  }

  /* 投影缺失、又解不开正文的会话会退回 id 占位。这件事必须说出来 ——
     否则那几条看起来像"这个工具读不出标题"，而实际原因可能是这台机器的
     Node 太老（`zlib.zstdDecompressSync` 要到 22.15 / 23.8 才有）。
     只在真的缺标题时才提，正常情况下不拿这句话占版面。 */
  const untitled = tasks.filter((t) => !projections.has(t.id)).length;
  if (untitled) {
    problems.push(
      !zstdSync
        ? `有 ${untitled} 条会话没有投影缓存，而当前 Node（${process.version}）没有内置 zstd 解压` +
          `（22.15 / 23.8 起才有）—— 那几条按会话 id 显示。升级 Node 后重新扫描即可读到标题。`
        : `有 ${untitled} 条会话没有投影缓存，标题是从正文开头解压出来的；` +
          `解不开的那几条按会话 id 显示。`
    );
  }

  sortTasks(tasks);

  return {
    tasks,
    totals: totalsOf(tasks),
    // 没有会话库：体积全在正文文件里，bodies 才是诚实的分母
    db: dbInfo(dirs.map((d) => d.files.find((f) => f.name.endsWith(BODY_SUFFIX))).filter(Boolean)),
    scanMs: Date.now() - t0,
    problems,
  };
}

function dbInfo(bodies) {
  return {
    dbs: [],
    total: 0,
    free: null,
    bodies: { count: bodies.length, bytes: bodies.reduce((s, f) => s + f.bytes, 0) },
  };
}

/**
 * 为什么这条会话可清。
 *
 * 与 Claude Code 的关键差别：Claude 那边 `reason` 为 null 就真的选不中 ——
 * 它的 .jsonl 是**唯一**的正文，删活跃会话等于让 --resume 指向不存在的文件，
 * 而索引里还留着那条记录。所以"还在用的"不该由这个工具替你删。
 *
 * Harness 这边一个会话就是一个自包含的目录：正文、锁、投影各归各位，
 * 删掉不会留下任何指向不存在目录的**受管**引用（workspace.json 里那个 id
 * 是它自己的投影，下次启动会重建）。所以用户明确勾哪一条，就是在明确说
 * "这段对话我不要了" —— 不给勾选反而是替人做主。这与 Cursor 的 manual 同理。
 *
 * 工作区路径没了的那条另有说法（wsMissing），因为它更可能是"项目删了"。
 */
function reasonOf(workspace) {
  if (workspace && missing(workspace)) return 'wsMissing';
  return 'manual';
}

/**
 * DSH 一条会话在磁盘上的牵连 —— 五个工具里最"有结构"的一个：
 *   整个 sessions/<slug>/session-<id>/ 目录   正文 zstd + session.lock
 *   storages/session_projcache/sessions/<id>.json   投影（标题/cwd/模型/步数）
 *   storages/workspace.json 里的 id                归档表、置顶表、工作区归属
 *
 * 前两项是文件，删了就干净了。第三项是 JSON 索引里的一个字符串，
 * 本工具没有任何 JSON 写路径 —— 所以这里只如实标为「不可删」，并在
 * notes 里说清后果：删完会话后 workspace.json 里会留下一个指向不存在目录的
 * id，下次启动 Harness 重建索引时会自然消失，但那之前它是悬空的。
 */
export function sessionContents(root, tasks, problems = []) {
  const out = new Map();
  for (const t of tasks) {
    const c = emptyContents();
    // 正文所在目录（含 session.lock）—— 从 bodyRel 往上退两级拿到会话目录
    const dirRel = t.bodyRel ? path.posix.dirname(t.bodyRel) : null;
    if (dirRel) addTree(c, { root, rel: dirRel, role: 'body', problems });
    pushFile(c, {
      rel: `storages/session_projcache/sessions/${t.id}.json`,
      role: 'projection',
      bytes: sizeOf(root, `storages/session_projcache/sessions/${t.id}.json`),
      removable: true,
    });
    c.notes.push({
      text: 'workspace.json 里的归档/置顶记录会留下一个悬空 id，下次启动 Harness 重建索引时消失',
      tone: 'info',
    });
    out.set(t.id, c);
  }
  return out;
}

function sizeOf(root, rel) {
  try { return fs.statSync(path.join(root, rel)).size; } catch { return 0; }
}

/* ── 索引 ─────────────────────────────────────────────────── */

/**
 * workspace.json：工作区表 + 全局的归档/置顶集合。
 * 读不到就返回空集合 —— 此时所有会话都按 active 处理，不猜。
 */
function readIndex(root, problems) {
  const out = { workspaceOf: new Map(), archived: new Set(), pinned: new Set() };
  const abs = path.join(root, WORKSPACE_JSON);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') problems.push(`工作区索引读不出来（${err.code || err.message}）：归档与置顶状态判不了`);
    return out;
  }

  let malformed = !doc || typeof doc !== 'object' || Array.isArray(doc);
  const ids = value => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) { malformed = true; return []; }
    return value.filter(id => {
      if (typeof id === 'string' && id) return true;
      malformed = true; return false;
    });
  };
  const g = doc?.global || {};
  for (const id of ids(g.archivedSessionIds)) out.archived.add(id);
  for (const id of ids(g.pinnedSessionIds)) out.pinned.add(id);
  for (const w of Object.values(doc?.tables?.workspaces || {})) {
    for (const sid of ids(w?.sessionIds)) out.workspaceOf.set(sid, typeof w?.path === 'string' ? w.path : '');
  }
  if (malformed) problems.push('工作区索引格式异常：已忽略无效字段，部分归属、归档与置顶状态无法判断');
  return out;
}

/**
 * 投影缓存：每个会话一份 JSON，字段都在 record.rows.<名>.val 里。
 * 这是列表的主数据源 —— 不需要解压。
 */
async function readProjections(root, problems) {
  const out = new Map();
  const dir = path.join(root, PROJ_DIR);
  let names;
  try { names = await fsp.readdir(dir); }
  catch (err) {
    if (err.code !== 'ENOENT') problems.push(`会话投影缓存读不出来（${err.code || err.message}）`);
    return out;
  }

  let bad = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    let doc;
    try { doc = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')); }
    catch { bad += 1; continue; }
    if (!doc?.record || typeof doc.record !== 'object' || Array.isArray(doc.record)) { bad += 1; continue; }
    out.set(id, projectMeta(doc));
  }
  if (bad) problems.push(`有 ${bad} 份会话投影解析失败，那几条会话改用解压正文取标题`);
  return out;
}

/** 把一份投影摊平成列表要的那几个字段。缺失就留空，不编。 */
function projectMeta(doc) {
  const row = (name) => doc?.record?.rows?.[name]?.val;
  const identity = doc?.record?.identity || {};
  const sel = row('modelSelection');
  const stats = row('sessionStats');
  const listMeta = row('sessionListMetadata');

  const title = row('title');
  const firstPrompt = row('titleInput')?.first?.text;

  return {
    cwd: identity.cwd || '',
    createdAt: Number(identity.createdAt) || 0,
    title: (typeof title === 'string' && title.trim()) || clip(firstPrompt) || '',
    model: sel?.lastUsed ? [sel.lastUsed.provider, sel.lastUsed.model].filter(Boolean).join(' / ') : '',
    preset: row('agentPreset') || '',
    steps: Number(stats?.steps) || 0,
    lastPromptAt: Number(listMeta?.lastPromptAt) || 0,
  };
}

/* ── 兜底：解压正文开头 ───────────────────────────────────── */

/**
 * 投影缺失时的回落。只解前 HEAD_LINES 行 —— 标题与 cwd 都在最前面。
 *
 * 拿不到 zstd 就返回空对象：会话照样列出、体积照样算，只是标题显示成 id。
 * 这件事由 problems 明说，不要让界面看起来像读坏了。
 */
async function fallbackMeta(abs, bytes, problems) {
  if (!zstdSync || !bytes) return {};
  let text;
  try {
    const buf = await fsp.readFile(abs);
    text = zstdSync(buf, { maxOutputLength: MAX_INFLATE }).toString('utf8');
  } catch (err) {
    problems.push(`会话正文解压失败 ${abs}：${err.code || err.message}`);
    return {};
  }

  let cwd = '', createdAt = 0, title = '', preset = '';
  const lines = text.split('\n');
  for (let i = 0; i < Math.min(lines.length, HEAD_LINES); i += 1) {
    const line = lines[i];
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    if (obj.type === 'session') {
      cwd = typeof obj.cwd === 'string' ? obj.cwd : cwd;
      createdAt = Number(obj.createdAt) || createdAt;
      preset = obj.agentPreset || preset;
    } else if (obj.type === 'session/title') {
      // 后写的覆盖先写的 —— 标题可能被改名过，最后一条才是当前值
      const v = obj.data?.title ?? obj.data?.val ?? obj.data;
      if (typeof v === 'string' && v.trim()) title = v;
    } else if (!title && obj.type === 'user/message' && obj.data?.source?.kind === 'user') {
      const content = Array.isArray(obj.data.content) ? obj.data.content : [];
      const part = content.find((c) => c?.type === 'text' && typeof c.text === 'string' && c.text);
      if (part) title = clip(part.text);
    }
  }
  return { cwd, createdAt, title, preset };
}

/* ── 目录遍历 ─────────────────────────────────────────────── */

/**
 * sessions/<slug>/session-<id>/ —— 只 stat，不读内容。
 *
 * `rel` 必须是**相对扫描根**（~/.dsh）的路径，不能相对 sessions/：
 * 前端拿它去文件清单里找对应那一行（openTaskAsFiles），两边的基准必须一致。
 * 差一层 `sessions/` 就会变成"勾上的会话在文件清单里找不到对应正文"，
 * 界面上看起来像目录刚被改过 —— 而其实只是路径拼错了。
 */
async function walkSessions(root, problems) {
  const base = path.join(root, 'sessions');
  const out = [];
  let slugs;
  try { slugs = await fsp.readdir(base, { withFileTypes: true }); }
  catch (err) { problems.push(`会话目录读取失败 ${base}：${err.code || err.message}`); return out; }

  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugAbs = path.join(base, slug.name);
    let entries;
    try { entries = await fsp.readdir(slugAbs, { withFileTypes: true }); }
    catch (err) { problems.push(`会话目录读取失败 ${slugAbs}：${err.code || err.message}`); continue; }

    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith('session-')) continue;
      const dirAbs = path.join(slugAbs, ent.name);
      let files;
      try { files = await fsp.readdir(dirAbs, { withFileTypes: true }); }
      catch (err) { problems.push(`会话目录读取失败 ${dirAbs}：${err.code || err.message}`); continue; }

      const stats = [];
      for (const f of files) {
        if (!f.isFile()) continue;
        const abs = path.join(dirAbs, f.name);
        let st;
        try { st = await fsp.stat(abs); }
        catch (err) { problems.push(`会话文件读取失败 ${abs}：${err.code || err.message}`); continue; }
        stats.push({
          name: f.name,
          abs,
          rel: path.relative(root, abs).split(path.sep).join('/'),
          bytes: st.size,
          mtime: st.mtimeMs,
        });
      }
      out.push({
        id: ent.name,
        abs: dirAbs,
        mtime: Math.max(0, ...stats.map((s) => s.mtime)),
        files: stats,
      });
    }
  }
  return out;
}

/* ── 小工具 ───────────────────────────────────────────────── */

function clip(s) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > 70 ? one.slice(0, 70) + '…' : one;
}

function missing(p) {
  try { fs.statSync(p); return false; } catch (err) { return err.code === 'ENOENT'; }
}
