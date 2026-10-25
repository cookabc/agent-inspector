/**
 * 文件清单视图：分类卡 + 行。纯函数，不碰 DOM。
 *
 * 每个函数的入参就是它的全部输入 —— `ctx` 是一小袋状态（搜索词、筛选、
 * 展开的卡片、勾选集合、当前 app 的视图），由调用方（app.js）组装。
 * 这样这一层可以被 node --test 直接喂夹具断言，而不用假 DOM；
 * 也因此，重排 DOM 顺序、改模板写法都不会再让测试变红。
 */

import { esc, badge, STATUS_LABEL } from './shared.js';
/* fmtBytes 的实现在 logic.js（带单测）—— 这里直接引用，不复制第二份。 */
import { fmtBytes } from '../logic.js';

/** 悬停时看的精确字节数。与 app.js 的 bytesTip 同一份语义，但这里不能
 *  反向 import（视图层不该依赖 app.js），所以就地定义一个等价的。 */
const bytesTipLocal = (n) => `${Number(n || 0).toLocaleString()} 字节`;
const bytesTip = bytesTipLocal;

/**
 * 一个分类里最多渲染多少行 —— 再多就让用户用搜索缩小范围。
 *
 * 这个数只决定"画多少"，不决定"能删多少"：勾选与删除仍然作用于全部行
 * （见 app.js 的 selectableOnly 调用）。改小它只是少画一些 DOM。
 */
export const MAX_ROWS = 400;

/**
 * 一行能不能被选中清理 —— **只看传进来的分类**，不自己查。
 *
 * 判据与 logic.js 的 isSelectable 必须同源；logic.js 那份有单测（含脏输入），
 * 这里做的是一件事的两种输入形态：明明有分类对象在手时不必再反查一遍。
 * app.js 那侧的 canPick 会先 `cat || catOfRow(f)` 兜底，再交到这里。
 *
 * **所有批量入口都必须走这一个判据** —— 曾经散着四份判断，行级那份是对的，
 * 而「分组全选」「推荐清理」「三块分组」各自漏了软链接，于是点「推荐清理」→
 * 选区混进一个软链接 → 服务端整批拒绝 → 界面上只报那一个文件。
 */
export const canPickWith = (file, cat) => {
  if (file.link) return false;
  const verdict = cat?.verdict;
  if (!verdict) return false;
  return verdict !== 'never';
};

/** 一批文件里真正能被选中的那些。 */
export const selectableOnlyWith = (files, cat) => files.filter((f) => canPickWith(f, cat));

/**
 * 分类的展开/收起按钮。
 *
 * 单独一个 button，而不是让整个 group-head 可点：组头里还嵌着"全选"
 * 复选框，套 role=button 会把 checkbox 卷进按钮语义里，读屏用户听到的是
 * "按钮，选择全部条目"，而它其实是一个复选框。
 */
export function caretBtn(cat, isOpen) {
  return `<button class="caret-btn" type="button" data-group-toggle="${cat.id}"
          aria-expanded="${isOpen}" aria-label="${esc(cat.label)}：${isOpen ? '收起' : '展开'}清单">
          <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </button>`;
}

/**
 * 分组头的复选框。
 *
 * 状态只能按"真正能勾的行"算（pickable）。用全部行算的话，软链接与受保护项
 * 永远勾不上，这个框就永远停在 indeterminate —— 点一次还是半选，点两次才
 * 取消，人看到的是"这个框坏了"。
 */
export function groupBox(cat, selCount, pickableCount) {
  const disabled = cat.verdict === 'never';
  const checked = selCount > 0 && selCount === pickableCount;
  const indeterminate = selCount > 0 && selCount < pickableCount;
  return `<input type="checkbox" data-group-box="${cat.id}"
            ${disabled ? 'disabled aria-label="受保护内容，不可清理"' : ''}
            ${checked ? 'checked' : ''}
            ${indeterminate ? 'data-indeterminate="1"' : ''}
            aria-label="选择 ${esc(cat.label)} 的全部条目">`;
}

/**
 * 单行。
 *
 * ctx 需要：selection（Set）、multiTarget（bool）、canReveal（bool）、
 * targets（数组）、appLabel（这一屏的工具名，用于 title）。
 */
export function rowHtml(f, cat, ctx) {
  const on = ctx.selection.has(f.k || f.key);
  // 软链接：扫描时按链接本身记录（不跟随），服务端也一律拒绝删除。
  // 所以这里既不能勾，也要在行上说明白 —— 画成可勾的条目等于骗人点一下再报错。
  const isLink = Boolean(f.link);
  const protectedRow = cat.verdict === 'never' || isLink;
  const when = new Date(f.m).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const cut = f.p.lastIndexOf('/');
  const dir = cut < 0 ? '' : f.p.slice(0, cut + 1);
  const name = cut < 0 ? f.p : f.p.slice(cut + 1);

  // 一个 app 有多个根（Cursor 的 ~/.cursor 与 App Support）时，
  // 相对路径看不出它落在哪一边。
  const tView = (ctx.targets || []).find((t) => t.key === f.t) || {};
  const tTag = ctx.multiTarget
    ? `<span class="row-tag" title="位于 ${esc(tView.short || f.t)}">${esc(tView.label || f.t)}</span>` : '';

  // 只给可清理的那一种打标。会话 id 是 8 位十六进制，摆在行里没人读得懂，
  // 也没人能拿它做什么 —— 挪进 tooltip，行里只留"孤儿"两个字。
  const sidTag = f.sid && f.orphan
    ? `<span class="row-tag is-orphan" title="会话 ${esc(f.sid)} 已不在 ${esc(ctx.appLabel)} 的会话库里，文件是残骸">孤儿</span>`
    : '';
  const linkTag = isLink
    ? `<span class="row-tag" title="符号链接：不跟随、不删除，删它等于去改别的目录">软链接</span>` : '';

  return `<div class="row ${on ? 'is-on' : ''}${isLink ? ' is-link' : ''}">
    <input type="checkbox" data-key="${esc(f.k || f.key)}" ${on ? 'checked' : ''}
      ${protectedRow ? `disabled aria-label="${isLink ? '符号链接，不可清理' : '受保护内容'}"` : ''}>
    <span class="row-path" title="${esc(tView.short || f.t)}/${esc(f.p)}">
      <span class="row-dir">${esc(dir)}</span><b class="row-name">${esc(name)}</b>${tTag}${linkTag}${sidTag}
    </span>
    <span class="row-size" title="${bytesTip(f.s)}">${fmtBytes(f.s)}</span>
    <span class="row-time">${when}</span>
    ${ctx.canReveal ? `<button class="row-reveal" data-reveal="${esc(f.k || f.key)}" title="在 Finder 中显示" aria-label="在 Finder 中显示">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>
    </button>` : ''}
  </div>`;
}

/**
 * 一张分类卡。
 *
 * @param {object} p
 * @param {object} p.cat        分类元信息（含 verdict/label/outcome/what/why）
 * @param {Array}  p.files      这一卡当前可见的行（已排序）
 * @param {number} p.totalHere  这个分类一共多少行（不筛时等于 files.length）
 * @param {number} p.selCount   其中已勾选、且可勾的行数
 * @param {number} p.pickable   可勾的总行数
 * @param {boolean} p.isOpen    展开
 * @param {boolean} p.explain   展开"这是什么"
 * @param {object} p.rowCtx     传给 rowHtml 的上下文
 */
export function groupCard(p) {
  const all = p.files;
  const filtered = all.length !== p.totalHere;
  const visBytes = all.reduce((a, f) => a + f.s, 0);
  // 只有两个数格式化之后真的不一样，才值得把"整类多大"补在后面。
  // 否则会印出 "2.84 GB / 2.84 GB" —— 筛没筛、差多少，全靠读者自己猜。
  const visLabel = fmtBytes(visBytes);
  const allLabel = fmtBytes(p.cat.bytes);
  const showAll = filtered && visLabel !== allLabel;

  const shown = p.isOpen ? all.slice(0, MAX_ROWS) : [];
  const rows = shown.map((f) => rowHtml(f, p.cat, p.rowCtx)).join('');
  const more = p.isOpen && all.length > MAX_ROWS
    ? `<div class="more">还有 ${(all.length - MAX_ROWS).toLocaleString()} 项，用搜索缩小范围</div>` : '';
  const none = p.isOpen && !all.length ? '<div class="more">没有匹配的条目</div>' : '';

  return `<article class="group ${p.isOpen ? 'is-open' : ''} ${p.cat.verdict === 'never' ? 'is-locked' : ''}" data-cat="${p.cat.id}">
      <header class="group-head">
        ${caretBtn(p.cat, p.isOpen)}
        <div class="group-title">
          <h3>${esc(p.cat.label)}</h3>
          ${badge(p.cat)}
          <span class="count">${
            all.length === p.totalHere
              ? `${p.totalHere.toLocaleString()} 项`
              : `筛出 ${all.length.toLocaleString()} / ${p.totalHere.toLocaleString()} 项`
          }${p.selCount ? `，已选 ${p.selCount.toLocaleString()}` : ''}</span>
        </div>
        <div class="group-right">
          <span class="group-size" title="${bytesTip(visBytes)}${
            filtered ? `（整个分类 ${p.cat.bytes.toLocaleString()} 字节）` : ''}">${
            visLabel}${showAll ? `<em> / ${allLabel}</em>` : ''}</span>
          ${groupBox(p.cat, p.selCount, p.pickable)}
        </div>
      </header>

      <div class="group-outcome">
        <span class="outcome-label">删了会怎样</span>
        <span class="outcome-text">${esc(p.cat.outcome)}</span>
        <button class="group-more" data-more="${p.cat.id}" aria-expanded="${p.explain}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          ${p.explain ? '收起说明' : '这是什么，为什么在这里'}
        </button>
      </div>

      ${p.explain ? `<div class="group-explain">
        <section><h4>这是什么</h4><p>${esc(p.cat.what)}</p></section>
        <section><h4>为什么在这里</h4><p>${esc(p.cat.why)}</p></section>
      </div>` : ''}

      ${p.isOpen ? `<div class="group-body">${rows}${none}${more}</div>` : ''}
    </article>`;
}

/**
 * 空态文案：说清是**哪个条件**筛空的，并给出下一步。
 *
 * 原来只有一句"没有匹配的条目"，而搜索框、状态钮、分组筛选三个条件可能
 * 叠在一起，用户不知道该改哪个；提示还挂在列表末尾，离搜索框一百多像素。
 */
export function emptyHintHtml({ q, statuses, group, catFilter, catLabel }) {
  const why = [];
  if (q) why.push(`搜索「${esc(q)}」`);
  if (statuses && statuses.size) {
    const names = [...statuses].map((s) => STATUS_LABEL[s] || s).join('、');
    why.push(`只看「${esc(names)}」`);
  }
  if (group) why.push('只在这一组里');
  if (catFilter) why.push(`只看「${esc(catLabel ?? catFilter)}」`);
  if (!why.length) return { hidden: false, html: '没有匹配的条目。' };
  return {
    hidden: false,
    html: `没有匹配的条目 —— ${why.join(' + ')} 一起筛下来是空的。` +
      '<span class="empty-act">按 <kbd>Esc</kbd> 清掉搜索，或点已亮的筛选钮取消它。</span>',
  };
}
