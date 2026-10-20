/**
 * Gemini / Antigravity 的历史会话：只读摘要，不提供写路径。
 *
 * 会话的正文本机多半没有 —— Antigravity 是云同步形态，conversation_summaries.db
 * 里只有标题、预览、工作区与状态；conversations/ 目录（本机正文）在云形态下是空的。
 * 删掉摘要 = 界面里那条会话失去入口、云端正文还在：一个"半删"的坏状态。
 * 所以这个面板只读：告诉你有哪些会话、各占多少、归哪个项目；清理入口在工具自己。
 *
 * workspace_uris 是 JSON 数组（"file:///..." 形态），取第一个算工作区 ——
 * 按项目横切时它是 Gemini 侧的归并键，与其它工具同一种语言。
 */

import fs from 'node:fs';
import path from 'node:path';
import { openReadonly } from './sqlite-open.mjs';
import { normalizeRow, sortTasks, totalsOf } from './tasks-shape.mjs';

const DB_REL = path.join('antigravity', 'conversation_summaries.db');

/** 前端只读警示条直接引用：理由由适配器给，不在前端按 app 名硬编码。 */
export const READ_ONLY_NOTE =
  'Gemini/Antigravity 的会话正文在云端，本机的摘要库只是界面入口 —— 删掉它会制造"半删"状态' +
  '（入口没了、正文还在），回收不了空间。要清会话请在 Antigravity 里删。';

export function scanTasks(root) {
  const t0 = Date.now();
  const dbPath = path.join(root, DB_REL);
  const problems = [];

  if (!fs.existsSync(dbPath)) {
    return { tasks: [], totals: totalsOf([]), db: sizes(root), readOnly: true, scanMs: 0,
      problems: ['找不到 conversation_summaries.db'], readOnlyNote: READ_ONLY_NOTE };
  }

  const db = openReadonly(dbPath);
  if (!db) {
    return { tasks: [], totals: totalsOf([]), db: sizes(root), readOnly: true, scanMs: 0,
      problems: ['conversation_summaries.db 打不开（只读）'], readOnlyNote: READ_ONLY_NOTE };
  }

  try {
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT conversation_id, title, preview, step_count, last_modified_time,
               last_user_input_time, workspace_uris, status, agent_name,
               parent_conversation_id, nesting_depth, killed
        FROM conversation_summaries
      `).all();
    } catch (err) { problems.push(`conversation_summaries 读不出来：${err.message}`); }

    const tasks = rows.map((r) => {
      // workspace_uris 是 JSON 数组（file:/// URI）。取第一个能解析的当工作区：
      // 与其它工具一样给绝对路径，项目横切才能归并。解析不出就空着，不猜。
      let workspace = '';
      try {
        const uris = JSON.parse(r.workspace_uris || '[]');
        const first = Array.isArray(uris) ? uris.find((u) => typeof u === 'string' && u.startsWith('file://')) : null;
        if (first) workspace = decodeURIComponent(new URL(first).pathname);
      } catch { /* 不是合法 JSON：留空 */ }

      return normalizeRow({
        id: r.conversation_id,
        title: r.title || '(无标题)',
        workspace,
        // 正文不在本机：摘要删了也回收不了多少空间，还破坏界面入口 —— 一律不给清理理由
        state: r.killed ? 'archived' : 'active',
        reason: null,
        typeLabel: r.nesting_depth > 0 ? '子会话' : '对话',
        updatedAt: Date.parse(r.last_modified_time) || 0,
        rows: r.step_count || 0,
      });
    });

    sortTasks(tasks);

    return {
      tasks,
      readOnly: true,
      readOnlyNote: READ_ONLY_NOTE,
      totals: totalsOf(tasks),
      db: sizes(root),
      scanMs: Date.now() - t0,
      problems,
    };
  } finally {
    db.close();
  }
}

function sizes(root) {
  const info = (p) => {
    try { const st = fs.statSync(p); return { path: p, bytes: st.size, mtime: st.mtimeMs }; }
    catch { return { path: p, bytes: 0, mtime: 0 }; }
  };
  const main = info(path.join(root, DB_REL));
  let free = null;
  try { const s = fs.statfsSync(root); free = s.bavail * s.bsize; } catch {}
  return { dbs: [{ name: 'conversation_summaries.db', role: 'index', ...main }], main, total: main.bytes, free };
}
