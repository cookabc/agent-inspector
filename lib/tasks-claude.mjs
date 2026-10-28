/**
 * Claude Code 的历史会话：读文件，不写库。
 *
 * Claude Code 没有会话数据库 —— 会话正文就是 projects/<工作区 slug>/<会话 id>.jsonl，
 * 所以"删会话"等于删文件，走文件清理那条线（废纸篓 / 彻底删除，带保护检查）。
 * 这里只做列表与统计，**不提供任何写路径**：没有库可 VACUUM，也没有行可删。
 *
 * 唯一的读取例外：为了列出工作区和标题，每个会话文件只读开头一小段
 * （第一行 JSON 里有 cwd），不解析全文 —— 文件扫描那条线依然只 stat。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { normalizeRow, sortTasks, totalsOf } from './tasks-shape.mjs';
import { emptyContents, pushFile } from './session-contents.mjs';

/** 只读文件开头的这么多字节来找元数据；正文再大也不碰。 */
const HEAD_BYTES = 64 * 1024;

export async function scanTasks(root) {
  const t0 = Date.now();
  const base = path.join(root, 'projects');
  const problems = [];
  if (!fs.existsSync(base)) {
    return {
      tasks: [], totals: totalsOf([]), db: dbInfo([]),
      problems: ['找不到 projects/'], scanMs: 0,
    };
  }

  const files = await walkJsonl(base, problems);
  const tasks = [];
  for (const f of files) {
    const meta = await headMeta(f.abs, problems);
    // 目录名是把 cwd 的 / 换成 - 得到的，路径里也可能本来就有 - —— 反推不唯一，
    // 所以读不到 cwd 时宁可留空并按 slug 分组，不装作能还原出路径。
    const workspace = meta.cwd || '';
    tasks.push(normalizeRow({
      id: f.id,
      title: meta.title || `(无标题) ${f.rel}`,
      workspace,
      // Claude 没有"界面已删除"的中间态：文件在就代表会话在
      state: f.bytes === 0 ? 'empty' : 'active',
      /* 活跃会话也给 manual：删一个 .jsonl 是自包含操作，不留任何悬空引用
         （Claude Code 的 /resume 读的就是这些文件本身）。以前这里给 null，
         会话不可勾 —— 那时删除入口在文件清单，按文件删确实可行；现在正文
         归会话管理，不给勾就等于大多数会话根本没有删除入口。运行中的
         Claude Code 由进程闸拦（assertAppStopped），勾选本身不做的事。 */
      reason: f.bytes === 0 ? 'empty'
        : (workspace && missing(workspace) ? 'wsMissing' : 'manual'),
      // Claude 没有模型名以外的行内元数据，也就没有"钉住"
      model: meta.model || '',
      typeLabel: meta.sidechain ? '子 Agent' : '对话',
      createdAt: meta.timestamp || f.mtime,
      updatedAt: f.mtime,
      bytes: f.bytes,
      bodyRel: `projects/${f.rel}`,
      // 清理方式：删文件，不是删行
      residual: true,
    }));
  }

  sortTasks(tasks);

  return {
    tasks,
    totals: totalsOf(tasks),
    // 没有会话库：体积全在 .jsonl 文件里，bodies 才是诚实的分母（否则构成条分母为 0）
    db: dbInfo(files),
    scanMs: Date.now() - t0,
    problems,
  };
}

/**
 * Claude 一条会话在磁盘上的牵连：就一个 .jsonl。
 *
 * 有一处说法要诚实：`paste-cache/`（粘贴的大段文本）与 `file-history/`
 * （文件编辑的历史版本）都可能来自某条会话，但它们的路径里没有会话 id，
 * 无法精确归到某一条。所以这里不列它们，只在抽屉里说明"可能还有残留"。
 */
export function sessionContents(root, tasks, problems = []) {
  const out = new Map();
  for (const t of tasks) {
    const c = emptyContents();
    if (t.bodyRel) {
      let st = null;
      try { st = fs.statSync(path.join(root, t.bodyRel)); }
      catch (err) { if (err.code !== 'ENOENT') problems.push(`${t.bodyRel}：${err.code || '读取失败'}`); }
      pushFile(c, { rel: t.bodyRel, role: 'body', bytes: st?.size || t.bytes || 0, removable: true });
    }
    out.set(t.id, c);
  }
  return out;
}

function dbInfo(files) {
  return {
    dbs: [],
    total: 0,
    free: null,
    bodies: { count: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) },
  };
}

async function walkJsonl(base, problems) {
  const out = [];
  const stack = [base];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); }
    catch (err) { problems.push(`会话目录读取失败 ${cur}：${err.code || err.message}`); continue; }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(abs); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      let st; try { st = await fs.promises.stat(abs); }
      catch (err) { problems.push(`会话文件读取失败 ${abs}：${err.code || err.message}`); continue; }
      out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/'), id: e.name.replace(/\.jsonl$/, ''), bytes: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

/** 读文件开头，解析出第一条带 cwd 的记录；解析不了就返回空对象。 */
async function headMeta(abs, problems) {
  let fh;
  try {
    fh = await fsp.open(abs, 'r');
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, (await fh.stat()).size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    let cwd = '', title = '', model = '', sidechain = false, timestamp = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }   // 截断的最后一行
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      if (!cwd && typeof obj.cwd === 'string') { cwd = obj.cwd; timestamp = Date.parse(obj.timestamp || '') || 0; sidechain = !!obj.isSidechain; }
      if (!model && typeof obj.model === 'string') model = obj.model;
      if (!title && obj.type === 'user' && typeof obj.message?.content === 'string') title = clip(obj.message.content);
      if (cwd && title) break;
    }
    return { cwd, title, model, sidechain, timestamp };
  } catch (err) {
    problems.push(`会话元数据读取失败 ${abs}：${err.code || err.message}`);
    return {};
  } finally {
    try { await fh?.close(); } catch {}
  }
}

function clip(s) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 70 ? one.slice(0, 70) + '…' : one;
}

function missing(p) {
  try { fs.statSync(p); return false; } catch (err) { return err.code === 'ENOENT'; }
}
