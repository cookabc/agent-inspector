/**
 * 文件清单视图：分类卡 + 行。纯函数，不碰 DOM。
 *
 * 每个函数的入参就是它的全部输入 —— `ctx` 是一小袋状态（搜索词、筛选、
 * 展开的卡片、勾选集合、当前 app 的视图），由调用方（app.js）组装。
 * 这样这一层可以被 node --test 直接喂夹具断言，而不用假 DOM；
 * 也因此，重排 DOM 顺序、改模板写法都不会再让测试变红。
 */

import { esc, badge, STATUS_LABEL, STATUS_CLASS, bytesTip } from './shared.js';
/* fmtBytes 与 isSelectable 的实现在 logic.js（带单测）—— 直接引用，不复制第二份。 */
import { fmtBytes, isSelectable } from '../logic.js';

/**
 * 一行能不能被选中清理 —— 判据本体就是 logic.js 的 isSelectable。
 *
 * **所有批量入口都必须走这一个判据**：逐处各判一次，只要有一处漏掉软链接，
 * 选区就会混进删不掉的条目 → 服务端整批拒绝 → 界面上只报那一个文件。
 * 这里引用同一个实现，两个名字只是"有分类在手"与"按行反查"两种调用形态。
 */
export const canPickWith = isSelectable;

/**
 * 一个分类里最多渲染多少行 —— 再多就让用户用搜索缩小范围。
 *
 * 这个数只决定"画多少"，不决定"能删多少"：勾选与删除仍然作用于全部行
 * （见 app.js 的 selectableOnly 调用）。改小它只是少画一些 DOM。
 */
export const MAX_ROWS = 400;

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
  const disabled = !isSelectable({}, cat);
  const checked = selCount > 0 && selCount === pickableCount;
  const indeterminate = selCount > 0 && selCount < pickableCount;
  return `<input type="checkbox" data-group-box="${cat.id}"
            ${disabled ? 'disabled' : ''}
            ${checked ? 'checked' : ''}
            ${indeterminate ? 'data-indeterminate="1"' : ''}
            aria-label="${disabled ? '受保护内容，不可清理' : `选择 ${esc(cat.label)} 的全部条目`}">`;
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
  const protectedRow = !isSelectable(f, cat);
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
 * 搜索框、状态钮、分组筛选三个条件可能叠在一起，所以必须说清是哪一个
 * 筛空的、以及怎么撤；提示挂在工具栏正下方，紧挨着能改它的控件。
 */
export function emptyHintHtml({ q, statuses, group }) {
  const why = [];
  if (q) why.push(`搜索「${esc(q)}」`);
  if (statuses && statuses.size) {
    const names = [...statuses].map((s) => STATUS_LABEL[s] || s).join('、');
    why.push(`只看「${esc(names)}」`);
  }
  if (group) why.push('只在这一组里');
  if (!why.length) return { hidden: false, html: '没有匹配的条目。' };
  return {
    hidden: false,
    html: `没有匹配的条目 —— ${why.join(' + ')} 一起筛下来是空的。` +
      '<span class="empty-act">按 <kbd>Esc</kbd> 清掉搜索，或点已亮的筛选钮取消它。</span>',
  };
}

/* ── 三块分组（会话已不存在 / 会话仍在 / 非会话文件）────────── */

/**
 * 一块分组，它自己就是一个勾选框。
 *
 * `xs` 是这一组的全部文件，`hit` 是筛过之后看得见的那些。两者不同的
 * （搜索 / 状态筛选生效时）要在块上写清"筛出多少 / 一共多少" ——
 * 只印全量数字的话，上面三块加起来 1,360 个文件，下面分类卡却只剩 2 组，
 * 数字与内容对不上；只印筛后的数字又会让人以为文件真的只剩这么点。
 *
 * ctx 需要：selection（Set）、keyOf（行的稳定 key）、canPick（可选中判据）、
 * anyPicked（当前是否已有任何勾选 —— 它决定"选中"还是"换成"的说法）。
 */
export function splitBlockHtml(p) {
  const { cls, title, desc, xs, extra, split, hit, selection, keyOf, canPick, anyPicked } = p;
  const sum = (list) => list.reduce((a, f) => a + f.s, 0);
  const shown = hit || xs;
  const can = shown.filter((f) => canPick(f));
  const picked = can.filter((f) => selection.has(keyOf(f)));
  const allOn = can.length > 0 && picked.length === can.length;
  const part = picked.length > 0 && !allOn;     // 只勾了这一组的一部分
  const toggle = can.length < shown.length ? '（受保护的几项不会被勾上）' : '';
  // 空分组没有可勾的东西：不给 tabindex、不写"点这里选"，也不假装是复选框。
  // 留一个空的 role=checkbox 让人点下去没反应，比不放这块更糟。
  const empty = can.length === 0;
  // 筛选让这一组少了东西时，体积和条数都按"看得见的"算，并把全量写在后面。
  const filtered = shown.length !== xs.length;
  // 三种状态说三种话。勾一半时点下去是"补全"，不是"取消" —— 文案写反了就是骗人。
  // 没勾的那两块还要说明：点它不是"加进去"，是"换成它"。
  const flag = empty
    ? (filtered && xs.length ? '这一组当前筛选下没有条目' : '这一组没有可勾选的条目')
    : allOn
      ? `已选 <b>${picked.length.toLocaleString()}</b> 项，<b>${fmtBytes(sum(picked))}</b>，再点一下取消${toggle}`
      : part
        ? `已选 <b>${picked.length.toLocaleString()}</b> / <b>${can.length.toLocaleString()}</b> 项，` +
          `<b>${fmtBytes(sum(picked))}</b>　再点一下补全${toggle}`
        : anyPicked
          ? `点这里换成这一组${toggle}`
          : `点这里选中这一组${toggle}`;
  // 空分组整块退出交互：没有 tabindex、没有 role=checkbox、没有 data-split，
  // 点下去也不会触发任何选择逻辑。
  const cls2 = `split-block ${cls}${allOn ? ' is-on' : ''}${part ? ' is-part' : ''}` +
    `${empty ? ' is-empty' : ' is-clickable'}`;
  const attrs = empty
    ? ''
    : ` data-split="${split}" role="checkbox" tabindex="0" aria-checked="${part ? 'mixed' : String(allOn)}"`;
  const shownBytes = sum(shown);
  return `
    <section class="${cls2}"${attrs}>
      <header class="split-head">
        <h3><span class="box" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span>${esc(title)}</h3>
        <span class="split-size" title="${bytesTip(shownBytes)}">${fmtBytes(shownBytes)}</span>
      </header>
      <p class="split-desc">${esc(desc)}</p>
      <p class="split-meta">${
        filtered
          ? `筛出 ${shown.length.toLocaleString()} / ${xs.length.toLocaleString()} 个文件`
          : `${xs.length.toLocaleString()} 个文件`
      }${extra}</p>
      <p class="split-flag">${flag}</p>
    </section>`;
}

/* ── 文件清理抽屉的预览块 ─────────────────────────────────── */

/** 抽屉头上的三个读数：条目、合计、最大一项。 */
export function drawerStatsHtml(rows, { titleOf }) {
  const bytes = rows.reduce((s, f) => s + f.s, 0);
  const biggest = rows.reduce((a, b) => (a.s >= b.s ? a : b), rows[0]);
  return `
    <div class="dstat"><span>条目</span><b>${rows.length.toLocaleString()}</b></div>
    <div class="dstat"><span>合计</span><b title="${bytesTip(bytes)}">${fmtBytes(bytes)}</b></div>
    <div class="dstat"><span>最大一项</span><b title="${esc(titleOf(biggest))}，${bytesTip(biggest.s)}">${fmtBytes(biggest.s)}</b></div>`;
}

/** 这批里都是些什么 —— 按分类摊开，别只给一个总数。
 *  跨 app 时同名分类（各工具都有一类"缓存"）是不同的元信息对象，
 *  按对象 identity 求 key 会把同一类拆成好几项，所以按分类 id 合并。 */
export function drawerMixHtml(rows, catOf) {
  const mix = new Map();
  for (const f of rows) {
    const c = catOf(f);
    const hit = mix.get(c.id);
    if (hit) hit.bytes += f.s;
    else mix.set(c.id, { cat: c, bytes: f.s });
  }
  const sorted = [...mix.values()].sort((a, b) => b.bytes - a.bytes);
  const head = sorted.slice(0, 5);
  return '包含 ' + head.map(({ cat: c, bytes }) =>
    `<span class="mix-item ${STATUS_CLASS[c.status]}">
       <span class="swatch"></span>${esc(c.label)} <em>${fmtBytes(bytes)}</em>
     </span>`).join('')
    + (sorted.length > head.length
        ? `<span>…共 ${sorted.length} 类</span>` : '');
}

/** 抽屉里的预览清单：只列最大的 300 项。截断的只是这张表，不是删除范围
 *  —— 不写清楚，人会以为剩下的不删。 */
export function drawerListHtml(rows, { titleOf }) {
  const LIMIT = 300;
  const shown = rows.slice().sort((a, b) => b.s - a.s).slice(0, LIMIT);
  return shown.map((f) => {
    const cut = f.p.lastIndexOf('/');
    const dir = cut < 0 ? '' : f.p.slice(0, cut + 1);
    const name = cut < 0 ? f.p : f.p.slice(cut + 1);
    return `<li title="${esc(titleOf(f))}">
      <span class="dl-path"><span class="row-dir">${esc(dir)}</span><b>${esc(name)}</b></span>
      <span title="${bytesTip(f.s)}">${fmtBytes(f.s)}</span></li>`;
  }).join('')
    + (rows.length > LIMIT
        ? `<li class="drawer-more"><span>下面还有 ${(rows.length - LIMIT).toLocaleString()} 项没列出来` +
          `（这张表只列最大的 ${LIMIT} 项），<b>它们同样在这次的删除范围里</b>。</span><span></span></li>`
        : '');
}

/* ── 推荐清理的分类开关 ───────────────────────────────────── */

/** 推荐范围里的分类开关。`recOff` 是被排除的分类 id 集合 ——
 *  全排除那一条空态也要用它重画，所以排除状态由调用方传入。 */
export function recChipsHtml(list, recOff) {
  return list.map((c) => {
    const isOn = !recOff.has(c.id);
    return `<button type="button" class="rec-chip ${STATUS_CLASS[c.status]} ${isOn ? 'is-on' : ''}"
      data-rec="${c.id}" aria-pressed="${isOn}" title="${esc(c.what)}">
      <span class="box" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span>
      ${esc(c.label)} <em title="${bytesTip(c.bytes)}">${fmtBytes(c.bytes)}</em>
    </button>`;
  }).join('');
}
