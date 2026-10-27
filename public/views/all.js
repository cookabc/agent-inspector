/**
 * 「全部」视图的渲染：跨工具会话一览。纯函数，不碰 DOM。
 *
 * 这一屏回答的是"我刚才在哪个工具里干活"。它的效率问题很具体：
 * 实测 119 个会话分布在 12 个文件夹里，其中**一个文件夹装了 90 个**，
 * 全部铺开就是 3340px —— 整页 6 屏，而用户真正的目标是"找到刚才那段"，
 * 它通常在最上面几行。
 *
 * 所以这里的组织方式是：**按文件夹折叠，默认只展开最近的若干个**。
 * 每组的头一直可见（名字、路径、条数、体积），点一下展开。
 * 这样 12 个文件夹一屏能扫完，要找的那段要么在默认展开的前两组里，
 * 要么用搜索直达。
 */

import { esc, bytesTip, fmtDate, shortPath } from './shared.js';
/* fmtBytes 的实现在 logic.js（带单测）—— 直接引用，不复制第二份。 */
import { fmtBytes } from '../logic.js';

/**
 * 默认展开几组。
 *
 * 2 是根据"最近使用排序"定的：用户找的几乎总是最近那一两段。
 * 展开更多会把这一屏重新变成六屏，那就退回未优化的状态了。
 */
export const DEFAULT_OPEN_GROUPS = 2;

/** 一组里默认显示多少行（展开后）；超过这个数用"还有 N 个"。 */
export const ROWS_PER_GROUP = 20;

/**
 * 按文件夹分组，并把行按最近使用排序。
 *
 * @param {Array} tasks 跨工具会话行（每行自带 app / appLabel）
 * @param {{tools?: Set<string>, q?: string}} filter
 * @returns {{groups: Array, total: number, matched: number}}
 */
export function groupSessions(tasks, filter = {}) {
  const { tools, q = '' } = filter;
  const matched = tasks.filter((t) => {
    if (tools && tools.size && !tools.has(t.app)) return false;
    if (q && !`${t.title} ${t.workspace}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const byWs = new Map();
  for (const t of matched) {
    const key = t.workspace || '';
    let g = byWs.get(key);
    if (!g) byWs.set(key, g = { ws: key, rows: [], bytes: 0 });
    g.rows.push(t);
    g.bytes += t.bytes;
  }

  // 组内按最近使用降序：这一屏的用途就是"找刚才那段"，时间比体积更相关
  const groups = [...byWs.values()].map((g) => {
    const rows = g.rows.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return {
      ws: g.ws,
      rows,
      bytes: g.bytes,
      // 组头显示用得上的两个名字：完整路径（缩写）与最后一节
      path: g.ws ? shortPath(g.ws) : '（还原不出文件夹）',
      base: g.ws ? (g.ws.split('/').filter(Boolean).pop() || g.ws) : '（还原不出文件夹）',
      latest: rows[0]?.updatedAt || 0,
    };
  }).sort((a, b) => b.latest - a.latest);

  return { groups, total: tasks.length, matched: matched.length };
}

/** 组头。始终可见 —— 折叠状态下它就是唯一能看见的东西，必须信息完整。 */
export function sessionGroupHead(g, isOpen) {
  return `<header class="all-group-head">
      <button type="button" class="all-group-toggle" data-all-ws="${esc(g.ws)}"
        aria-expanded="${isOpen}" aria-label="${esc(g.base)}：${isOpen ? '收起' : '展开'} ${g.rows.length} 个会话">
        <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      <span class="all-group-name" title="${esc(g.ws || '库里只有工作区 id，还原不出路径')}">${esc(g.base)}</span>
      <span class="all-group-path">${esc(g.path)}</span>
      <span class="all-group-n" title="${bytesTip(g.bytes)}">${g.rows.length.toLocaleString()} 个，${fmtBytes(g.bytes)}</span>
    </header>`;
}

/**
 * 一组里的行。
 *
 * 展开时最多列 ROWS_PER_GROUP 行：一个 90 行的文件夹全铺开是 3340px，
 * 而它下面的组全被推到看不见的地方。多出来的那些用搜索找 ——
 * 组头写着总数，不会让人以为只剩这些。
 */
export function sessionGroupRows(g) {
  const shown = g.rows.slice(0, ROWS_PER_GROUP);
  const rest = g.rows.length - shown.length;
  const rows = shown.map((t) => `
        <div class="all-row">
          <span class="all-app" data-app-tone="${esc(t.app)}">${esc(t.appLabel)}</span>
          <span class="all-title" title="${esc(t.title)}">${esc(t.title)}</span>
          <span class="all-when">${fmtDate(t.updatedAt)}</span>
          <span class="all-size" title="${bytesTip(t.bytes)}">${fmtBytes(t.bytes)}</span>
        </div>`).join('');
  const more = rest > 0
    ? `<div class="all-more">还有 ${rest.toLocaleString()} 个会话 —— 用上面的搜索框按标题或文件夹找</div>`
    : '';
  return rows + more;
}

/** 一整组：组头 + （展开时）行。 */
export function sessionGroup(g, isOpen) {
  return `<section class="all-group${isOpen ? ' is-open' : ''}">
    ${sessionGroupHead(g, isOpen)}
    ${isOpen ? sessionGroupRows(g) : ''}
  </section>`;
}

/**
 * 工具筛选钮 / 状态标签。
 *
 * 三种状态要分开，别混成一句：
 *   读到 0 个      → 灰标签，说明"这次汇总里没有它的会话"
 *   读到了但有提示 → 正常筛选钮，提示放进 title（tooltip），不占版面
 *   真的读不到     → 红标签，说明原因
 *
 * 要分清三种：后端的 `problems` 里既有真错误（库打不开），也有说明性提示
 * （"有 2 条会话没有投影缓存，标题是从正文解压出来的"）。前端一律当 error
 * 渲染成红色的"读不到"—— 于是 DeepSeek 明明有 4 个会话、下面也正常列着，
 * 筛选条上却显示成故障。屏幕上说"读不到"而下面就有它的会话，比不显示更糟。
 */
export function toolFilterChip(t, selected) {
  /* 真有会话读不出来（count === 0 且有 error）才算故障。
     count > 0 时 error 承载的是提示，不该升格成红色。 */
  if (t.error && !t.count) {
    return `<span class="all-tool is-err" title="${esc(t.error)}">${esc(t.label)} 读不到</span>`;
  }
  if (!t.count) {
    return `<span class="all-tool" data-app-tone="${esc(t.app)}"
      title="${esc(t.label)}：这次汇总里没有它的会话">${esc(t.label)} 0</span>`;
  }
  const note = t.error ? `　提示：${t.error}` : '';
  return `<button type="button" class="chip ${selected ? 'is-on' : ''}" data-all-tool="${esc(t.app)}"
      aria-pressed="${selected}" title="${esc(`${t.label}：${t.count} 个会话${note}`)}">
      <i></i>${esc(t.label)} <em style="font-style:normal;opacity:.7">${t.count}</em>
    </button>`;
}

/** 汇总那句话。 */
export function allLedeHtml(d, shownCount) {
  const parts = [
    `${d.tools.length} 个工具一共 <b>${d.total.toLocaleString()}</b> 个会话、<b>${fmtBytes(d.bytes)}</b> 正文，`,
    `分布在 <b>${d.groups.length}</b> 个文件夹里。按最近使用排序。`,
  ];
  if (shownCount !== undefined && shownCount !== d.total) {
    parts.push(`当前筛出 <b>${shownCount.toLocaleString()}</b> 个。`);
  }
  parts.push('<span class="all-note">这一屏只读 —— 要清理请点进对应的工具。</span>');
  return parts.join('');
}
