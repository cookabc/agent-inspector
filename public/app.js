/* ZCode 磁盘审计 —— 前端 */

const $ = (id) => document.getElementById(id);

const els = {
  rootPath: $('rootPath'), scanNote: $('scanNote'), rescanBtn: $('rescanBtn'), themeBtn: $('themeBtn'),
  heroBytes: $('heroBytes'), heroSub: $('heroSub'),
  diagnosis: $('diagnosis'), diagLede: $('diagLede'), diagTitleText: $('diagTitleText'),
  rec: $('rec'), recBtn: $('recBtn'), recCap: $('recCap'), recScope: $('recScope'),
  recFigure: $('recFigure'), recSub: $('recSub'),
  taskQuick: $('taskQuick'), tqFigure: $('tqFigure'), tqSub: $('tqSub'),
  taskQuickBtn: $('taskQuickBtn'), taskQuickCap: $('taskQuickCap'),
  taskAge: $('taskAge'), taskSkipPinned: $('taskSkipPinned'),
  split: $('split'), splitLede: $('splitLede'), fileSelAll: $('fileSelAll'),
  search: $('search'), statusChips: $('statusChips'), sortSel: $('sortSel'),
  clearSelBtn: $('clearSelBtn'),
  groups: $('groups'), emptyHint: $('emptyHint'),
  actionbar: $('actionbar'), abCount: $('abCount'), abBytes: $('abBytes'),
  abReveal: $('abReveal'), abClean: $('abClean'),
  scrim: $('scrim'), drawer: $('drawer'), drawerClose: $('drawerClose'),
  drawerStats: $('drawerStats'), drawerMix: $('drawerMix'),
  drawerList: $('drawerList'), drawerListCount: $('drawerListCount'),
  purgeConfirm: $('purgeConfirm'), purgeWord: $('purgeWord'),
  drawerMsg: $('drawerMsg'), drawerCancel: $('drawerCancel'), drawerGo: $('drawerGo'),
  tooltip: $('tooltip'),
};

const state = {
  index: null,
  selection: new Set(),
  open: new Set(),
  explain: new Set(),    // 展开了"这是什么 / 为什么在这里"的分类
  q: '',
  statuses: new Set(),   // 空 = 全部
  sort: 'size',
  group: null,           // 三块里被勾上的那一组：orphan / live / other；null = 不筛
  recOff: new Set(),     // 被排除在"推荐清理"之外的分类
  recReady: false,
  busy: false,
};

/* ── 工具 ───────────────────────────────────────────────── */

const GB = 1024 ** 3, MB = 1024 ** 2, KB = 1024;

function fmtBytes(n) {
  if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + ' TB';
  if (n >= 10 * GB)   return (n / GB).toFixed(1) + ' GB';
  if (n >= GB)        return (n / GB).toFixed(2) + ' GB';
  if (n >= MB)        return (n / MB).toFixed(1) + ' MB';
  if (n >= KB)        return (n / KB).toFixed(0) + ' KB';
  return n + ' B';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_CLASS = { good: 'st-good', warning: 'st-warning', serious: 'st-serious', critical: 'st-critical' };

const ICONS = {
  alert:    '<path d="M12 8v4.5M12 16h.01M10.3 3.9 2.6 17.2A1.9 1.9 0 0 0 4.3 20h15.4a1.9 1.9 0 0 0 1.7-2.8L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z"/>',
  terminal: '<path d="M4 7l4 5-4 5M12 17h8"/>',
  box:      '<path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5v-7Z"/><path d="M3 8.5 12 13l9-4.5M12 13v7"/>',
  trash:    '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  doc:      '<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/>',
  db:       '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>',
  key:      '<circle cx="8" cy="14" r="4"/><path d="M11 11l9-9M17 5l2 2M14 8l2 2"/>',
  gear:     '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
};

const icon = (name, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.box}</svg>`;

const badge = (cat) =>
  `<span class="badge ${STATUS_CLASS[cat.status]}">${icon(cat.icon)}${esc(cat.action || STATUS_LABEL[cat.status])}</span>`;

const STATUS_LABEL = { good: '可安全清理', warning: '谨慎清理', serious: '异常，建议清理', critical: '请勿删除' };

/* 推荐清理的范围：rules.mjs 里标了 recommend 的那几类 —— 就是"删了不影响
   会话、配置和凭据"的那些（日志、缓存、系统垃圾）。其中标了 recommendDefaultOff
   的默认不勾，但用户随时可以放回来。 */

const recommendAll = () => state.index.categories.filter((c) => c.recommend);
const recommendOn = () => recommendAll().filter((c) => !state.recOff.has(c.id));

const sumCats = (cats) => ({
  cats,
  bytes: cats.reduce((s, c) => s + c.bytes, 0),
  count: cats.reduce((s, c) => s + c.count, 0),
});

const REC_KEY = 'zci-rec-off';

function loadRecOff() {
  const defaults = () =>
    new Set(recommendAll().filter((c) => c.recommendDefaultOff).map((c) => c.id));
  try {
    const raw = localStorage.getItem(REC_KEY);
    if (raw) {
      const ids = JSON.parse(raw);
      // 只认得当前存在的分类；旧版留下的 id 直接丢掉
      if (Array.isArray(ids)) return new Set(ids.filter((id) => recommendAll().some((c) => c.id === id)));
    }
  } catch {}
  return defaults();
}

function saveRecOff() {
  try { localStorage.setItem(REC_KEY, JSON.stringify([...state.recOff])); } catch {}
}


/* ── 数据 ───────────────────────────────────────────────── */

async function load(refresh = false) {
  els.scanNote.textContent = '扫描中…';
  const res = await fetch('/api/scan' + (refresh ? '?refresh=1' : ''));
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  state.index = await res.json();
  state.selection.clear();
  state.group = null;   // 重扫一次，筛选也从头开始

  // 按分类预分组，避免每次渲染都全量过滤
  state.byCat = new Map();
  for (const f of state.index.files) {
    let arr = state.byCat.get(f.c);
    if (!arr) state.byCat.set(f.c, (arr = []));
    arr.push(f);
  }


  els.rootPath.textContent = state.index.rootShort || state.index.root;
  // 只留"这次扫描花了多久"这一条瞬时状态 —— 文件数写在首屏，不在这儿再说一遍
  els.scanNote.textContent = `扫描用时 ${(state.index.durationMs / 1000).toFixed(1)}s`;

  renderAll();
}

function catById(id) {
  return (state.index.catalog || state.index.categories).find((c) => c.id === id)
    || state.index.catalog[state.index.catalog.length - 1];
}

function filesOf(catId) {
  return state.byCat.get(catId) || [];
}

/* ── 首屏 ───────────────────────────────────────────────── */

function renderHero() {
  const t = state.index.totals;
  els.heroBytes.textContent = fmtBytes(t.bytes);

  const runaway = state.index.categories.filter((c) => c.id === 'runaway');
  const runawayBytes = runaway.reduce((s, c) => s + c.bytes, 0);
  const runawayCount = runaway.reduce((s, c) => s + c.count, 0);

  // 总量下面只说一件事：这里面有多少是失控日志。其余的分档数字交给下面的筛选条，
  // 不在这里重复一遍。
  const shape = `共计 <b>${t.files.toLocaleString()}</b> 个文件、<b>${t.dirs.toLocaleString()}</b> 个目录。`;
  els.heroSub.innerHTML = runawayBytes > 0
    ? shape + `其中 <b>${fmtBytes(runawayBytes)}</b> 来自 <b>${runawayCount}</b> 个失控放大的日志，` +
      `占 <b>${((runawayBytes / t.bytes) * 100).toFixed(0)}%</b>。`
    : shape;

  /* 诊断段。数字全部从这次扫描里现算 —— 写死"4 个文件 / 34 GB"只对写出它的那台机器成立，
     换一台就是撒谎。这里唯一固定的东西是机器无关的成因。 */
  els.diagnosis.hidden = runawayBytes <= 0;
  if (runawayBytes > 0) {
    const files = (state.index.files || []).filter((f) => f.c === 'runaway');
    const biggest = files.reduce((a, f) => Math.max(a, f.s), 0);
    const rootShort = state.index.rootShort || state.index.root;
    els.diagTitleText.textContent = `这 ${fmtBytes(runawayBytes)} 是怎么来的`;
    els.diagLede.innerHTML =
      `不是你的文件多，是 <b>${runawayCount}</b> 个文件失控了。Agent 把每条命令的完整输出写进 ` +
      `<code>${esc(rootShort)}/cli/exec/</code>，而某次只读搜索恰好把搜索范围设成了这个目录本身 —— ` +
      `于是 grep 匹配到自己正在写入的输出，层层嵌套、指数膨胀，最大的一个长到 <b>${fmtBytes(biggest)}</b>。`;
  }
}

/* ── 清单筛选 ───────────────────────────────────────────── */

const MAX_ROWS = 400;

/* 每个文件正好落进三组之一，跟上面那三块一一对应。
   读不到会话库时 scan.mjs 不给 f.orphan 赋值 —— 那种情况下按"会话仍在"算，
   绝不把不确定的东西标成可清理的孤儿。 */
function groupOf(f) {
  if (!f.sid) return 'other';
  return f.orphan === true ? 'orphan' : 'live';
}

function matches(f) {
  if (state.group && groupOf(f) !== state.group) return false;
  if (state.q && !f.p.toLowerCase().includes(state.q)) return false;
  if (state.statuses.size) {
    const cat = catById(f.c);
    if (!state.statuses.has(cat.status)) return false;
  }
  return true;
}

function sortFiles(list) {
  const s = state.sort;
  return list.sort((a, b) =>
    s === 'size' ? b.s - a.s :
    s === 'time' ? b.m - a.m :
    a.p.localeCompare(b.p, 'zh'));
}

/* 搜索和筛选都会让整个分类从清单里消失 —— 一行都不会显示的分类，
   留着只会让人以为里面还有东西。 */
function visibleCategories() {
  return state.index.categories.filter((c) => filesOf(c.id).some(matches));
}

function renderGroups() {
  const cats = visibleCategories();

  els.emptyHint.hidden = cats.length > 0;

  els.groups.innerHTML = cats.map((cat) => {
    // 一切以"当前看得见的这些行"为准：卡片头上的勾选框、计数、已选数都算这一批。
    // 没有筛选时它就是这个分类的全部。
    const all = sortFiles(filesOf(cat.id).filter(matches));
    const isOpen = state.open.has(cat.id);
    const totalHere = filesOf(cat.id).length;
    const selCount = all.filter((f) => state.selection.has(f.p)).length;
    // 右上角那个数说的是"这张卡里现在装着的东西"，不是这个分类一共有多少 ——
    // 筛过之后还写整类的体积，就会跟卡里勾着的行对不上（2.84 GB 的卡里躺着 9.2 MB 的勾）。
    const filtered = all.length !== totalHere;
    const visBytes = all.reduce((a, f) => a + f.s, 0);
    // 只有两个数格式化之后真的不一样，才值得把"整类多大"补在后面。
    // 否则会印出 "2.84 GB / 2.84 GB" 这种 —— 筛没筛、差多少，全靠读者自己猜。
    const visLabel = fmtBytes(visBytes);
    const allLabel = fmtBytes(cat.bytes);
    const showAll = filtered && visLabel !== allLabel;

    const shown = isOpen ? all.slice(0, MAX_ROWS) : [];
    const rows = shown.map((f) => rowHtml(f, cat)).join('');
    const more = isOpen && all.length > MAX_ROWS
      ? `<div class="more">还有 ${(all.length - MAX_ROWS).toLocaleString()} 项，用搜索缩小范围</div>` : '';
    const none = isOpen && !all.length ? `<div class="more">没有匹配的条目</div>` : '';

    return `<article class="group ${isOpen ? 'is-open' : ''} ${cat.verdict === 'never' ? 'is-locked' : ''}" data-cat="${cat.id}">
      <header class="group-head">
        <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        <div class="group-title">
          <h3>${esc(cat.label)}</h3>
          ${badge(cat)}
          <span class="count">${
            all.length === totalHere
              ? `${totalHere.toLocaleString()} 项`
              : `筛出 ${all.length.toLocaleString()} / ${totalHere.toLocaleString()} 项`
          }${selCount ? ` · 已选 ${selCount.toLocaleString()}` : ''}</span>
        </div>
        <div class="group-right">
          <span class="group-size">${visLabel}${showAll ? `<em> / ${allLabel}</em>` : ''}</span>
          <input type="checkbox" data-group-box="${cat.id}"
            ${cat.verdict === 'never' ? 'disabled aria-label="受保护内容，不可清理"' : ''}
            ${selCount && selCount === all.length ? 'checked' : ''}
            ${selCount && selCount < all.length ? 'data-indeterminate="1"' : ''}
            aria-label="选择 ${esc(cat.label)} 的全部条目">
        </div>
      </header>

      <div class="group-outcome">
        <span class="outcome-label">删了会怎样</span>
        <span class="outcome-text">${esc(cat.outcome)}</span>
        <button class="group-more" data-more="${cat.id}" aria-expanded="${state.explain.has(cat.id)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          ${state.explain.has(cat.id) ? '收起说明' : '这是什么 · 为什么在这里'}
        </button>
      </div>

      ${state.explain.has(cat.id) ? `<div class="group-explain">
        <section><h4>这是什么</h4><p>${esc(cat.what)}</p></section>
        <section><h4>为什么在这里</h4><p>${esc(cat.why)}</p></section>
      </div>` : ''}

      ${isOpen ? `<div class="group-body">${rows}${none}${more}</div>` : ''}
    </article>`;
  }).join('');

  els.groups.querySelectorAll('[data-indeterminate]').forEach((el) => { el.indeterminate = true; });
}

function rowHtml(f, cat) {
  const on = state.selection.has(f.p);
  const protectedRow = cat.verdict === 'never';
  const when = new Date(f.m).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const cut = f.p.lastIndexOf('/');
  const dir = cut < 0 ? '' : f.p.slice(0, cut + 1);
  const name = cut < 0 ? f.p : f.p.slice(cut + 1);
  // 只给可清理的那一种打标。会话 id 是 8 位十六进制，摆在行里没人读得懂，
  // 也没人能拿它做什么 —— 挪进 tooltip，行里只留"孤儿"这两个字。
  const sidTag = f.sid && f.orphan
    ? `<span class="row-tag is-orphan" title="会话 ${esc(f.sid)} 已不在 ZCode 的会话库里，文件是残骸">孤儿</span>`
    : '';
  return `<div class="row ${on ? 'is-on' : ''}">
    <input type="checkbox" data-path="${esc(f.p)}" ${on ? 'checked' : ''}
      ${protectedRow ? 'disabled aria-label="受保护内容"' : ''}>
    <span class="row-path" title="${esc(f.p)}">
      <span class="row-dir">${esc(dir)}</span><b class="row-name">${esc(name)}</b>${sidTag}
    </span>
    <span class="row-size">${fmtBytes(f.s)}</span>
    <span class="row-time">${when}</span>
    ${canReveal() ? `<button class="row-reveal" data-reveal="${esc(f.p)}" title="在 Finder 中显示" aria-label="在 Finder 中显示">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>
    </button>` : ''}
  </div>`;
}

/* ── 勾选 ───────────────────────────────────────────────── */

function selectedBytes() {
  let sum = 0;
  for (const f of state.index.files) if (state.selection.has(f.p)) sum += f.s;
  return sum;
}

/* "在 Finder 中显示"是 macOS 的 open -R。别处没有这个动作，
   服务端会报 canReveal:false，那就干脆不摆这个按钮 —— 摆了也只是让人白按。 */
const canReveal = () => state.index?.canReveal !== false;

function renderActionbar() {
  const n = state.selection.size;
  els.actionbar.hidden = n === 0;
  els.abCount.textContent = n.toLocaleString();
  els.abBytes.textContent = fmtBytes(selectedBytes());
  els.abReveal.hidden = !canReveal();
}

/* ── 抽屉 ───────────────────────────────────────────────── */

function openDrawer() {
  const paths = [...state.selection];
  if (!paths.length) return;
  const byPath = new Map(state.index.files.map((f) => [f.p, f]));
  const rows = paths.map((p) => byPath.get(p)).filter(Boolean);
  const bytes = rows.reduce((s, f) => s + f.s, 0);
  const biggest = rows.reduce((a, b) => (a.s >= b.s ? a : b), rows[0]);

  els.drawerStats.innerHTML = `
    <div class="dstat"><span>条目</span><b>${rows.length.toLocaleString()}</b></div>
    <div class="dstat"><span>合计</span><b>${fmtBytes(bytes)}</b></div>
    <div class="dstat"><span>最大一项</span><b title="${esc(biggest.p)}">${fmtBytes(biggest.s)}</b></div>`;

  // 这批里都是些什么 —— 按分类摊开，别只给一个总数
  const mix = new Map();
  for (const f of rows) {
    const c = catById(f.c);
    mix.set(c, (mix.get(c) || 0) + f.s);
  }
  const mixSorted = [...mix.entries()].sort((a, b) => b[1] - a[1]);
  const head = mixSorted.slice(0, 5);
  els.drawerMix.innerHTML = '包含 ' + head.map(([c, s]) =>
    `<span class="mix-item ${STATUS_CLASS[c.status]}">
       <span class="swatch"></span>${esc(c.label)} <em>${fmtBytes(s)}</em>
     </span>`).join('')
    + (mixSorted.length > head.length
        ? `<span>…共 ${mixSorted.length} 类</span>` : '');

  const shown = rows.slice().sort((a, b) => b.s - a.s).slice(0, 300);
  els.drawerList.innerHTML = shown.map((f) => {
    const cut = f.p.lastIndexOf('/');
    const dir = cut < 0 ? '' : f.p.slice(0, cut + 1);
    const name = cut < 0 ? f.p : f.p.slice(cut + 1);
    return `<li title="${esc(f.p)}">
      <span class="dl-path"><span class="row-dir">${esc(dir)}</span><b>${esc(name)}</b></span>
      <span>${fmtBytes(f.s)}</span></li>`;
  }).join('')
    + (rows.length > 300 ? `<li><span>…还有 ${(rows.length - 300).toLocaleString()} 项按体积排在后面</span><span></span></li>` : '');
  els.drawerListCount.textContent = `${rows.length.toLocaleString()} 项`;

  els.drawerMsg.textContent = '';
  els.drawerMsg.className = 'drawer-msg';
  els.purgeWord.value = '';
  els.drawerGo.disabled = false;

  // 两条路各有各的堵法：受保护内容不能彻底删除；非 macOS 没有废纸篓可用。
  const anyProtected = rows.some((f) => catById(f.c).verdict === 'never');
  const noTrash = state.index.canTrash === false;
  const purgeRadio = document.querySelector('input[name="mode"][value="purge"]');
  const trashRadio = document.querySelector('input[name="mode"][value="trash"]');
  purgeRadio.disabled = anyProtected;
  trashRadio.disabled = noTrash;

  if (anyProtected && noTrash) {
    // 两条都堵死：这批东西在这台机器上没法清，说清楚，别让人按了没反应
    els.drawerGo.disabled = true;
    els.drawerMsg.textContent =
      '这批里有受保护内容（彻底删除被拒绝），而这台机器不是 macOS（没有废纸篓可用）。请先取消勾选受保护的那几项。';
    els.drawerMsg.className = 'drawer-msg is-err';
  } else if (anyProtected) {
    trashRadio.checked = true;
  } else if (noTrash) {
    purgeRadio.checked = true;
    els.drawerMsg.textContent = '这台机器不是 macOS，没有废纸篓可用，只能彻底删除。';
  }
  syncDrawerMode();

  els.scrim.hidden = false;
  els.drawer.hidden = false;
}

function closeDrawer() {
  els.scrim.hidden = true;
  els.drawer.hidden = true;
}

const mode = () => document.querySelector('input[name="mode"]:checked').value;

function syncDrawerMode() {
  const purge = mode() === 'purge';
  els.purgeConfirm.hidden = !purge;
  els.drawerGo.textContent = purge ? '彻底删除' : '移入废纸篓';
  els.drawerGo.className = 'btn ' + (purge ? 'btn-danger' : 'btn-primary');
}

async function runClean() {
  const paths = [...state.selection];
  const purge = mode() === 'purge';
  if (purge && els.purgeWord.value !== '彻底删除') {
    els.drawerMsg.textContent = '确认串不正确，请输入「彻底删除」四个字。';
    els.drawerMsg.className = 'drawer-msg is-err';
    return;
  }

  els.drawerGo.disabled = true;
  els.drawerMsg.textContent = purge ? '正在彻底删除…' : '正在移入废纸篓…';
  els.drawerMsg.className = 'drawer-msg';

  try {
    const res = await fetch(purge ? '/api/purge' : '/api/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(purge ? { paths, confirm: els.purgeWord.value } : { paths }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    const done = (data.moved || data.deleted || []).length;
    const failed = data.failed || [];
    if (failed.length) {
      els.drawerMsg.className = 'drawer-msg is-err';
      els.drawerMsg.textContent = `完成 ${done} 项，${failed.length} 项失败：${failed.map((f) => f.path).join('、')}`;
    } else {
      els.drawerMsg.className = 'drawer-msg is-ok';
      els.drawerMsg.textContent = purge
        ? `已彻底删除 ${done} 项。`
        : `已把 ${done} 项移入废纸篓，可在 Finder 的「废纸篓」中恢复。`;
    }
    await load(true);
    if (!failed.length) setTimeout(closeDrawer, 1200);
  } catch (err) {
    els.drawerMsg.className = 'drawer-msg is-err';
    els.drawerMsg.textContent = err.message;
  } finally {
    els.drawerGo.disabled = false;
  }
}

/* ── 提示气泡 ───────────────────────────────────────────── */

function showTip(target, text) {
  els.tooltip.textContent = text;
  els.tooltip.hidden = false;
  const r = target.getBoundingClientRect();
  const t = els.tooltip.getBoundingClientRect();
  let left = Math.min(r.left, window.innerWidth - t.width - 10);
  let top = r.top - t.height - 9;
  if (top < 8) top = r.bottom + 9;
  els.tooltip.style.left = Math.max(8, left) + 'px';
  els.tooltip.style.top = top + 'px';
}
const hideTip = () => { els.tooltip.hidden = true; };

/* ── 渲染总入口 ─────────────────────────────────────────── */

function renderAll() {
  if (!state.recReady) { state.recOff = loadRecOff(); state.recReady = true; }
  renderHero();
  renderRecommend();
  renderChips();
  renderSplit();
  renderGroups();
  renderActionbar();
}

/* ── 会话与非会话 ──────────────────────────────────────────
   会话相关：文件路径里带 sess_<id>，按会话是否仍在会话库里分成两组。
   非会话：日志、缓存、配置等，不属于任何会话。
   孤儿会话（会话库已无）是最干净可删的，单独高亮。 */
function renderSplit() {
  const files = state.index?.files || [];
  const groups = { orphan: [], live: [], other: [] };
  for (const f of files) groups[groupOf(f)].push(f);
  const { orphan, live, other } = groups;

  const sum = (xs) => xs.reduce((a, f) => a + f.s, 0);
  const sids = (xs) => new Set(xs.map((f) => f.sid)).size;

  // 数字全部长在下面三块上，这里只交代"为什么这么分"，不再把同一批数字念一遍
  els.splitLede.innerHTML =
    `按<b>会话是否还在</b>分成三组 —— 点一块就选中那一组，再点一下取消。` +
    `受保护的内容不会被选中。`;

  /* 每块自己就是一个勾选框：点一下把这一组整个勾上，行也跟着筛到这一组，
     在下面的清单里能看见勾。再点一下取消。
     计数用真正"能勾"的条数 —— 受保护的内容（凭据、会话库、配置）不进勾选，
     所以「非会话文件」那块的已选数会比它自己的文件数少，这是对的，照实写。 */
  const protectedIds = new Set(state.index.categories.filter((c) => c.verdict === 'never').map((c) => c.id));
  const selectable = (xs) => xs.filter((f) => !protectedIds.has(f.c));

  const anyPicked = state.selection.size > 0;
  const block = (cls, title, desc, xs, extra, split) => {
    const can = selectable(xs);
    const picked = can.filter((f) => state.selection.has(f.p));
    const allOn = can.length > 0 && picked.length === can.length;
    const part = picked.length > 0 && !allOn;     // 只勾了这一组的一部分
    const toggle = can.length < xs.length ? '（受保护的几项不会被勾上）' : '';
    // 三种状态说三种话。勾一半时点下去是"补全"，不是"取消" —— 文案写反了就是骗人。
    // 没勾的那两块还要说明：点它不是"加进去"，是"换成它"。
    const flag = allOn
      ? `已选 <b>${picked.length.toLocaleString()}</b> 项 · <b>${fmtBytes(sum(picked))}</b>　再点一下取消${toggle}`
      : part
        ? `已选 <b>${picked.length.toLocaleString()}</b> / <b>${can.length.toLocaleString()}</b> 项 · ` +
          `<b>${fmtBytes(sum(picked))}</b>　再点一下补全${toggle}`
        : anyPicked
          ? `点这里换成这一组${toggle}`
          : `点这里选中这一组${toggle}`;
    return `
    <section class="split-block ${cls}${allOn ? ' is-on' : ''}${part ? ' is-part' : ''} is-clickable"
      data-split="${split}" role="checkbox" tabindex="0"
      aria-checked="${part ? 'mixed' : String(allOn)}">
      <header class="split-head">
        <h3><span class="box" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span>${esc(title)}</h3>
        <span class="split-size">${fmtBytes(sum(xs))}</span>
      </header>
      <p class="split-desc">${esc(desc)}</p>
      <p class="split-meta">${xs.length.toLocaleString()} 个文件${extra}</p>
      <p class="split-flag">${flag}</p>
    </section>`;
  };

  els.split.innerHTML = [
    block('is-orphan', '会话已不存在', '会话库里找不到它，只剩文件残留。可以直接清理。', orphan,
      sids(orphan) ? ` · ${sids(orphan).toLocaleString()} 个会话` : '', 'orphan'),
    block('is-live', '会话仍在', '这些会话还在 ZCode 里，文件有用，请谨慎。', live,
      sids(live) ? ` · ${sids(live).toLocaleString()} 个会话` : '', 'live'),
    block('is-other', '非会话文件', '日志、缓存、配置等，不属于任何会话。', other, '', 'other'),
  ].join('');
}

/* 按钮上直接写出这批有多大，点之前就知道会发生什么。
   下面的条目可以逐项开关，按钮数字跟着变。 */
function renderRecommend() {
  const all = recommendAll();
  if (!all.length) { els.rec.hidden = true; return; }
  els.rec.hidden = false;

  const { cats, bytes, count } = sumCats(recommendOn());
  const off = all.filter((c) => state.recOff.has(c.id));

  els.recFigure.textContent = fmtBytes(bytes);
  els.recSub.innerHTML =
    `日志、缓存与系统垃圾，共 <b>${count.toLocaleString()}</b> 项。删掉不影响会话、配置和凭据。`;

  els.recBtn.disabled = !count;
  els.recBtn.innerHTML = count
    ? `推荐清理 <span class="rec-size">${fmtBytes(bytes)}</span>`
    : '推荐清理';
  els.recBtn.title = count
    ? `${count.toLocaleString()} 项 · 共 ${fmtBytes(bytes)}（${cats.map((c) => c.label).join('、')}）`
    : '已经一项都不剩了，把上面的条目勾回来';

  els.recCap.innerHTML =
    `勾选后摊开确认清单，<b>不会立刻删除任何东西</b>。` +
    (off.length
      ? `<span class="rec-off">已排除 <code>${off.map((c) => esc(c.label)).join('、')}</code> — 点上面的条目可以放回来。</span>`
      : '');

  els.recScope.innerHTML = all.map((c) => {
    const on = !state.recOff.has(c.id);
    return `<button type="button" class="rec-chip ${STATUS_CLASS[c.status]} ${on ? 'is-on' : ''}"
      data-rec="${c.id}" aria-pressed="${on}" title="${esc(c.what)}">
      <span class="box" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span>
      ${esc(c.label)} <em>${fmtBytes(c.bytes)}</em>
    </button>`;
  }).join('');
}

function renderChips() {
  const order = ['good', 'warning', 'serious', 'critical'];
  els.statusChips.innerHTML = order.map((s) => {
    const cats = state.index.categories.filter((c) => c.status === s);
    if (!cats.length) return '';
    const bytes = cats.reduce((a, c) => a + c.bytes, 0);
    return `<button type="button" class="chip ${STATUS_CLASS[s]} ${state.statuses.has(s) ? 'is-on' : ''}"
      data-status="${s}" aria-pressed="${state.statuses.has(s)}">
      <i></i>${STATUS_LABEL[s]} <em style="font-style:normal;opacity:.7">${fmtBytes(bytes)}</em>
    </button>`;
  }).join('');
}

/* ── 事件 ───────────────────────────────────────────────── */

document.addEventListener('click', async (e) => {
  const t = e.target;

  // "这是什么 / 为什么在这里"的展开开关（跟展开文件列表是两回事）
  const more = t.closest('[data-more]');
  if (more) {
    const id = more.dataset.more;
    state.explain.has(id) ? state.explain.delete(id) : state.explain.add(id);
    renderGroups();
    return;
  }

  // 分组展开 / 收起
  const head = t.closest('.group-head');
  if (head && !t.matches('input[type="checkbox"]')) {
    const id = head.closest('.group').dataset.cat;
    state.open.has(id) ? state.open.delete(id) : state.open.add(id);
    renderGroups();
    return;
  }

  // 分组全选
  const gbox = t.closest('[data-group-box]');
  if (gbox) {
    const id = gbox.dataset.groupBox;
    const checked = gbox.checked;
    // 只动当前看得见的那些行，跟卡片头上那个框自身的勾选状态对得上
    for (const f of filesOf(id).filter(matches)) {
      checked ? state.selection.add(f.p) : state.selection.delete(f.p);
    }
    state.open.add(id);
    renderGroups(); renderActionbar(); renderSplit();
    return;
  }

  // 单文件
  const fbox = t.closest('input[data-path]');
  if (fbox) {
    fbox.checked ? state.selection.add(fbox.dataset.path) : state.selection.delete(fbox.dataset.path);
    // 三块上的"已选 N"要跟着走 —— 手动取消一项，那块就该显示勾了一半
    renderGroups(); renderActionbar(); renderSplit();
    return;
  }

  // 在 Finder 中显示
  const reveal = t.closest('[data-reveal]');
  if (reveal) {
    await fetch('/api/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: reveal.dataset.reveal }),
    });
    return;
  }

  // 状态筛选
  const chip = t.closest('[data-status]');
  if (chip) {
    const s = chip.dataset.status;
    state.statuses.has(s) ? state.statuses.delete(s) : state.statuses.add(s);
    renderChips(); renderGroups();
    return;
  }

  // 三块中的任意一块 → 整组勾上 / 取消，并把清单筛到这一组，好让人看见勾在哪。
  // 受保护的内容（凭据、会话库、配置）不进勾选 —— 跟「全选」同一条规矩。
  const sp = t.closest('[data-split]');
  if (sp) {
    const g = sp.dataset.split;
    const protectedIds = new Set(state.index.categories.filter((c) => c.verdict === 'never').map((c) => c.id));
    const mine = state.index.files.filter((f) => groupOf(f) === g && !protectedIds.has(f.c));
    const allOn = mine.length > 0 && mine.every((f) => state.selection.has(f.p));
    // 三块互斥：它们是把全部文件劈成三份，一组就是一组。
    // 所以换一组是"换成它"，不是"再加上它" —— 先清干净再勾。
    state.selection.clear();
    if (allOn) {
      state.group = null;                             // 再点一下 = 整组取消
    } else {
      for (const f of mine) state.selection.add(f.p);
      state.group = g;
    }
    renderSplit();
    renderGroups();
    renderActionbar();
    document.getElementById('files').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }


  // 抽屉
  if (t.closest('#abClean')) { openDrawer(); return; }
  if (t.closest('#abReveal')) {
    const first = [...state.selection][0];
    if (first) await fetch('/api/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: first }),
    });
    return;
  }
  if (t.closest('#drawerClose') || t.closest('#drawerCancel') || t === els.scrim) { closeDrawer(); return; }
  if (t.closest('#drawerGo')) { runClean(); return; }

  // 开关推荐范围里的某一项，按钮上的数字当场跟着变
  const rc = t.closest('[data-rec]');
  if (rc) {
    const id = rc.dataset.rec;
    state.recOff.has(id) ? state.recOff.delete(id) : state.recOff.add(id);
    saveRecOff();
    renderRecommend();
    return;
  }

  // 推荐清理：清掉筛选（免得勾中的东西被滤掉看不见），勾满当前推荐范围，
  // 然后直接把确认清单摊开 —— 到此为止，不执行任何删除。
  if (t.closest('#recBtn')) {
    state.q = '';
    els.search.value = '';
    state.statuses.clear();
    state.group = null;   // 先清掉筛选，否则勾中的东西会被筛掉、看不见
    state.selection.clear();
    for (const c of recommendOn()) {
      for (const f of filesOf(c.id)) state.selection.add(f.p);
    }
    renderChips(); renderSplit(); renderGroups(); renderActionbar();
    openDrawer();
    return;
  }
  if (t.closest('#clearSelBtn')) {
    // 取消勾选就一起把分组筛选撤了 —— 否则清单还筛着，三块却全是没勾的样子
    state.selection.clear();
    state.group = null;
    renderSplit(); renderGroups(); renderActionbar(); return;
  }
  if (t.closest('#fileSelAll')) {
    for (const cat of visibleCategories()) {
      if (cat.verdict === 'never') continue;   // 受保护内容不进全选
      for (const f of filesOf(cat.id).filter(matches)) state.selection.add(f.p);
    }
    renderSplit(); renderGroups(); renderActionbar(); return;
  }
  if (t.closest('#rescanBtn')) {
    els.rescanBtn.disabled = true;
    await load(true);
    await loadTasks(true);
    els.rescanBtn.disabled = false;
    return;
  }
  if (t.closest('#themeBtn')) {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    next ? document.documentElement.setAttribute('data-theme', next)
         : document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('zci-theme', next); } catch {}
    return;
  }
});

els.search.addEventListener('input', () => {
  state.q = els.search.value.trim().toLowerCase();
  renderGroups();
});

els.sortSel.addEventListener('change', () => {
  state.sort = els.sortSel.value;
  renderGroups();
});

document.addEventListener('change', (e) => {
  if (e.target.name === 'mode') syncDrawerMode();
});

els.purgeWord.addEventListener('input', () => {
  if (els.purgeWord.value === '彻底删除' && els.drawerMsg.classList.contains('is-err')) {
    els.drawerMsg.textContent = '';
    els.drawerMsg.className = 'drawer-msg';
  }
});

// 提示气泡
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t) showTip(t, t.dataset.tip); else hideTip();
});
document.addEventListener('scroll', hideTip, true);

// 键盘
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault(); els.search.focus(); els.search.select();
  }
  if (e.key === 'Escape') {
    if (!els.drawer.hidden) closeDrawer();
    else if (document.activeElement === els.search) { els.search.value = ''; state.q = ''; els.search.blur(); renderGroups(); }
  }

  // 分组头是 role=button，回车 / 空格要能折叠，和点击行为一致
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-ws-toggle]')) {
    e.preventDefault();
    e.target.click();
  }

  // 会话分块也是 role=button
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-split]')) {
    e.preventDefault();
    e.target.click();
  }
});

window.addEventListener('resize', () => { hideTip(); renderSplit(); });

/* ════════════════════════════════════════════════════════════
   历史任务
   ════════════════════════════════════════════════════════════ */

const tEls = {
  warn: $('taskWarn'), lede: $('taskLede'), dbBar: $('dbBar'),
  chips: $('taskChips'), search: $('taskSearch'), sort: $('taskSort'),
  pickAll: $('taskPickAll'), clearSel: $('taskClearSel'),
  list: $('taskList'), empty: $('taskEmpty'), foot: $('taskFoot'),
  tfCount: $('tfCount'), tfBytes: $('tfBytes'), purgeBtn: $('taskPurgeBtn'),
  scrim: $('tscrim'), drawer: $('tdrawer'), close: $('tdrawerClose'), cancel: $('tdrawerCancel'),
  stats: $('tdrawerStats'), note: $('tdrawerNote'), listD: $('tdrawerList'), countD: $('tdrawerCount'),
  dryWrap: $('tdryWrap'), dryList: $('tdryList'), dryBtn: $('tdryBtn'),
  confirmBox: $('tConfirmBox'), word: $('tWord'), msg: $('tdrawerMsg'), go: $('tdrawerGo'),
};

const taskState = { data: null, sel: new Set(), q: '', states: new Set(), sort: 'size', group: false, foldedWs: new Set() };

/* 可清理 = 已删除或已归档。活跃任务还在 ZCode 主列表里，服务端也会拒绝，
   所以前端从一开始就不让选它，免得选中后才被挡回来。 */
/* 可清理 = 后端给出了 reason。判定只在服务端做一次，前端照着用。 */
const isPurgeable = (t) => t.reason != null;

/* 可删的原因，每一种都标出来，让人一眼看到"为什么它能删" */
const REASON_LABEL = {
  deleted:   '已在界面删除',
  archived:  '已归档',
  wsMissing: '工作区已丢失',
  untracked: '界面不可见',
};
const REASON_TONE = { deleted: 'st-serious', archived: 'st-warning', wsMissing: 'st-serious', untracked: 'st-serious' };

const stateLabel = (t) => t.reason ? REASON_LABEL[t.reason] : STATE_META_CN[t.state];
const stateTone = (t) => t.reason ? REASON_TONE[t.reason] : STATE_TONE[t.state];

const STATE_TONE = { deleted: 'st-serious', archived: 'st-warning', active: 'st-good', untracked: 'st-warning' };

const shortPath = (p) => (p || '').replace(/^\/Users\/[^/]+/, '~');
const fmtDate = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

async function loadTasks(refresh = false) {
  tEls.lede.textContent = '正在读取会话库…（首次约需 8 秒）';
  try {
    const res = await fetch('/api/tasks' + (refresh ? '?refresh=1' : ''));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    taskState.data = data;
    taskState.sel.clear();
    renderTasks();
  } catch (err) {
    tEls.lede.innerHTML = `<b>读取失败：</b>${esc(err.message)}`;
  }
}

const visibleTasks = () => {
  const d = taskState.data;
  if (!d) return [];
  const q = taskState.q;
  let list = d.tasks.filter((t) => {
    if (taskState.states.size && !taskState.states.has(t.state)) return false;
    if (q && !(`${t.title} ${t.workspace}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const s = taskState.sort;
  list = list.sort((a, b) =>
    s === 'size' ? b.bytes - a.bytes :
    s === 'time' ? b.updatedAt - a.updatedAt :
    a.title.localeCompare(b.title, 'zh'));
  return list;
};

function renderTasks() {
  const d = taskState.data;
  // 选中之后又变成活跃的（比如在 ZCode 里恢复了），不能留在清理范围里
  if (d) for (const id of [...taskState.sel]) {
    const t = d.tasks.find((x) => x.id === id);
    if (!t || !isPurgeable(t)) taskState.sel.delete(id);
  }
  if (!d || !d.tasks.length) {
    tEls.lede.textContent = d ? '没有读到任何历史任务。' : tEls.lede.textContent;
    tEls.list.innerHTML = '';
    return;
  }

  const del = d.totals.byState.find((g) => g.state === 'deleted');
  const text = d.totals.bytes;

  tEls.lede.innerHTML =
    `会话库 <b>${fmtBytes(d.db.total)}</b>，装着 <b>${d.totals.count}</b> 个任务、` +
    `<b>${fmtBytes(text)}</b> 的正文。` +
    (del
      ? `其中 <b>${del.count}</b> 个已在界面上删除，仍占 <b>${fmtBytes(del.bytes)}</b>。`
      : '');

  // 运行状态提示：这是能不能动手的前提
  const app = d.app;
  tEls.warn.hidden = false;
  if (app.running) {
    tEls.warn.className = 'app-warn';
    tEls.warn.innerHTML =
      `${icon('alert')}<div><b>ZCode 正在运行</b>（${app.hits.map((h) => `${esc(h.name)} ×${h.pids}`).join('、')}）。` +
      `清理需要往会话库里写数据，必须先<b>完全退出 ZCode</b>，否则可能损坏数据库。` +
      `下面可以正常浏览和勾选，只是删除按钮会被拒。</div>`;
  } else {
    tEls.warn.className = 'app-warn is-ok';
    tEls.warn.innerHTML = `${icon('box')}<div>ZCode 没在运行，可以安全清理。动手前会自动把两个库完整备份到 <code>${esc(shortPath(d.backupDir))}</code>。</div>`;
  }

  renderDbBar();
  renderTaskChips();
  renderTaskList();
  renderTaskFoot();
  renderTaskQuick();
}

/** 这 1.4 GB 花在哪：按任务状态等比切开，剩下的是索引与开销。 */
function renderDbBar() {
  const d = taskState.data;
  const total = d.db.total || 1;
  const segs = [
    ...d.totals.byState.map((g) => ({
      label: STATE_META_CN[g.state], bytes: g.bytes, tone: STATE_TONE[g.state], key: g.state,
    })),
    {
      label: '索引与其他开销', bytes: Math.max(0, total - d.totals.bytes), tone: 'is-neutral', key: 'overhead',
      // 这一块是技术性的：库文件不只有正文。名字写在块上，解释挂在 tooltip 里，
      // 不占版面。
      tip: '数据库文件里不属于任何任务正文的部分 —— 索引、已释放的空页、页对齐等。删掉任务后它才会跟着缩。',
    },
  ].filter((s) => s.bytes > 0);

  const W = 100;
  const pct = segs.map((s) => (s.bytes / total) * W);
  const floors = pct.map(Math.floor);
  let rest = Math.round(W - floors.reduce((a, b) => a + b, 0));
  const order = pct.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) floors[order[k][1]] += 1;

  // 名称直接写进色块里，不再另起一行图例 —— 那一行把体积、状态又念了一遍，
  // 而下面那排筛选按钮本来就说的是同一件事。窄到写不下的块靠 tooltip 兜底。
  tEls.dbBar.innerHTML =
    `<div class="dbbar-track">` +
    segs.map((s, i) => {
      const cls = s.tone === 'is-neutral' ? 'is-neutral' : STATUS_CLASS_TONE[s.tone];
      const wide = floors[i] > 14;
      const mid = floors[i] > 7;
      return `<div class="dbbar-seg ${cls}" style="width:${floors[i]}%"
        data-tip="${esc(s.tip || `${s.label} · ${fmtBytes(s.bytes)}`)}">
        ${wide ? `<span>${esc(s.label)} ${fmtBytes(s.bytes)}</span>`
               : mid ? `<span>${fmtBytes(s.bytes)}</span>` : ''}</div>`;
    }).join('') +
    `</div>`;
}

const STATE_META_CN = {
  deleted: '已删除任务', archived: '已归档任务', active: '活跃任务', untracked: '无索引任务',
};
const STATUS_CLASS_TONE = { 'st-serious': 'st-serious', 'st-warning': 'st-warning', 'st-good': 'st-good', 'st-critical': 'st-critical' };

function renderTaskChips() {
  const d = taskState.data;
  // 体积写在上面那根条上，这里改说"几个任务" —— 换个数字，不把同一件事念两遍
  tEls.chips.innerHTML = d.totals.byState.map((g) =>
    `<button type="button" class="chip ${STATE_TONE[g.state]} ${taskState.states.has(g.state) ? 'is-on' : ''}"
      data-tstate="${g.state}" aria-pressed="${taskState.states.has(g.state)}"
      title="${esc(STATE_META_CN[g.state])} ${g.count} 个 · ${fmtBytes(g.bytes)}">
      <i></i>${esc(STATE_META_CN[g.state])} <em style="font-style:normal;opacity:.7">${g.count}</em>
    </button>`).join('');
}

function renderTaskList() {
  const list = visibleTasks();
  tEls.empty.hidden = list.length > 0;

  const rowHtml = (t) => {
    const sel = taskState.sel.has(t.id);
    const meta = [
      taskState.group ? '' : shortPath(t.workspace),
      `${fmtDate(t.updatedAt)} 最后使用`,
      t.children ? `${t.children} 子会话` : '',
      t.typeLabel,
    ].filter(Boolean).join(' · ');
    return `<div class="trow ${sel ? 'is-on' : ''}" data-task="${esc(t.id)}">
      <input type="checkbox" data-task-box="${esc(t.id)}" ${sel ? 'checked' : ''}
        ${isPurgeable(t) ? '' : 'disabled'} aria-label="选择任务 ${esc(t.title)}">
      <div class="trow-main">
        <span class="trow-title" title="${esc(t.title)}">${esc(t.title)}</span>
        <span class="trow-meta" title="${esc(t.workspace)}"><b class="trow-state-m">${esc(stateLabel(t))}</b>${esc(meta)}</span>
      </div>
      <span class="trow-pill ${stateTone(t)}">${esc(stateLabel(t))}</span>
      <span class="trow-size">${fmtBytes(t.bytes)}</span>
    </div>`;
  };

  if (!taskState.group) {
    tEls.list.innerHTML = list.map(rowHtml).join('');
    return;
  }

  // 按工作区聚合。组按正文合计降序；组内保持当前排序（list 已经排好了）。
  const byWs = new Map();
  for (const t of list) {
    const key = t.workspace || '(未知工作区)';
    let g = byWs.get(key);
    if (!g) byWs.set(key, (g = { ws: key, tasks: [], bytes: 0 }));
    g.tasks.push(t);
    g.bytes += t.bytes;
  }
  const groups = [...byWs.values()].sort((a, b) => b.bytes - a.bytes);

  tEls.list.innerHTML = groups.map((g) => {
    const folded = taskState.foldedWs.has(g.ws);
    const selN = g.tasks.filter((t) => taskState.sel.has(t.id)).length;
    return `<section class="tgroup ${folded ? 'is-folded' : ''}" data-ws="${esc(g.ws)}">
      <header class="tgroup-head" data-ws-toggle="${esc(g.ws)}" role="button" tabindex="0"
        aria-expanded="${!folded}" title="${esc(g.ws)}">
        <svg class="tgroup-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        <span class="tgroup-ws">${esc(shortPath(g.ws))}</span>
        <span class="tgroup-n">${g.tasks.length} 个${selN ? ` · 已选 ${selN}` : ''}</span>
        <span class="tgroup-size">${fmtBytes(g.bytes)}</span>
      </header>
      ${folded ? '' : `<div class="tgroup-body">${g.tasks.map(rowHtml).join('')}</div>`}
    </section>`;
  }).join('');
}

function taskSelTotals() {
  const d = taskState.data;
  if (!d) return { count: 0, bytes: 0, children: 0 };
  const picked = d.tasks.filter((t) => taskState.sel.has(t.id));
  return {
    count: picked.length,
    bytes: picked.reduce((s, t) => s + t.bytes, 0),
    children: picked.reduce((s, t) => s + t.children, 0),
    picked,
  };
}

function renderTaskFoot() {
  const { count, bytes } = taskSelTotals();
  tEls.foot.hidden = count === 0;
  tEls.tfCount.textContent = count.toLocaleString();
  tEls.tfBytes.textContent = fmtBytes(bytes);

  // 这个按钮永远可点 —— 它只是打开抽屉。空跑核对是只读的，ZCode 开着也安全，
  // 拦住用户看清单没有任何好处。真正被拦的是抽屉里那个「删除」。
  const running = taskState.data?.app?.running;
  tEls.purgeBtn.title = running
    ? 'ZCode 正在运行：可以先空跑核对，但要完全退出 ZCode 才能删除'
    : `清理这 ${count} 个任务；动手前会自动备份`;
}

/* ── 首屏的任务快捷项 ───────────────────────────────────── */

/* 默认收紧范围：只动"界面上删过、且确实放着没用了"的。
   近期还在用的、置顶的，一律先放过 —— 它们也可能是你回头还要翻的旧对话。 */
const tq = { ageDays: 30, skipPinned: true };

const TQ_KEY = 'zci-task-quick';

function loadTqScope() {
  try {
    const raw = localStorage.getItem(TQ_KEY);
    if (raw) { const v = JSON.parse(raw); tq.ageDays = Number(v.ageDays) || 0; tq.skipPinned = !!v.skipPinned; }
  } catch {}
}
const saveTqScope = () => {
  try { localStorage.setItem(TQ_KEY, JSON.stringify(tq)); } catch {}
};

function taskQuickSet() {
  const d = taskState.data;
  if (!d) return { tasks: [], bytes: 0, total: 0, totalBytes: 0, skippedRecent: 0, skippedPinned: 0 };
  const base = d.tasks.filter((t) => t.state === 'deleted');
  const cutoff = tq.ageDays > 0 ? Date.now() - tq.ageDays * 86400000 : 0;
  const picked = base.filter((t) =>
    (!tq.skipPinned || !t.pinned) && (!cutoff || t.updatedAt < cutoff));
  return {
    tasks: picked,
    bytes: picked.reduce((s, t) => s + t.bytes, 0),
    total: base.length,
    totalBytes: base.reduce((s, t) => s + t.bytes, 0),
    skippedRecent: cutoff ? base.filter((t) => t.updatedAt >= cutoff).length : 0,
    skippedPinned: base.filter((t) => t.pinned).length,
  };
}

function renderTaskQuick() {
  const d = taskState.data;
  const del = d?.totals.byState.find((g) => g.state === 'deleted');
  if (!del) { els.taskQuick.hidden = true; return; }
  els.taskQuick.hidden = false;

  const s = taskQuickSet();
  els.tqFigure.textContent = fmtBytes(s.bytes);
  els.tqSub.innerHTML =
    `ZCode 界面上你删过的 <b>${del.count}</b> 个任务。它的"删除"只是打个标记 —— ` +
    `正文一行没少，${fmtBytes(del.bytes)} 还躺在会话库里。`;

  els.taskAge.value = String(tq.ageDays);

  // 已删除的任务里根本没有置顶的，就别摆一个按了没反应的开关
  const anyPinned = d.tasks.some((t) => t.state === 'deleted' && t.pinned);
  els.taskSkipPinned.hidden = !anyPinned;
  els.taskSkipPinned.classList.toggle('is-on', tq.skipPinned);
  els.taskSkipPinned.setAttribute('aria-pressed', String(tq.skipPinned));

  els.taskQuickBtn.disabled = !s.tasks.length;
  els.taskQuickBtn.innerHTML = s.tasks.length
    ? `一键清理 <span class="rec-size">${fmtBytes(s.bytes)}</span>`
    : '一键清理';

  const skips = [];
  if (s.skippedRecent) skips.push(`${s.skippedRecent} 个近期还在用的`);
  if (tq.skipPinned && s.skippedPinned) skips.push(`${s.skippedPinned} 个置顶的`);
  els.taskQuickCap.innerHTML =
    `勾选 ${s.tasks.length} 个任务并摊开确认清单，<b>不会立刻删除</b>。` +
    (skips.length ? `<span class="rec-off">已跳过 ${skips.join('、')}。</span>` : '');
}

/* ── 任务清理抽屉 ───────────────────────────────────────── */

function openTaskDrawer() {
  const { count, bytes, children, picked } = taskSelTotals();
  if (!count) return;
  const d = taskState.data;

  tEls.stats.innerHTML = `
    <div class="dstat"><span>任务</span><b>${count.toLocaleString()}</b></div>
    <div class="dstat"><span>正文合计</span><b>${fmtBytes(bytes)}</b></div>
    <div class="dstat"><span>含子会话</span><b>${children.toLocaleString()}</b></div>`;

  tEls.note.innerHTML = d.app.running
    ? `<b>ZCode 仍在运行</b>，现在不能删除。请完全退出 ZCode 后重新打开本页。`
    : `删除会把这些任务的会话、消息、附件数据从 <code>cli/db/db.sqlite</code> 里彻底移除，` +
      `随后 <code>VACUUM</code> 重建数据库把空间真正交还给磁盘。` +
      `动手前会把两个库完整备份到 <code>${esc(shortPath(d.backupDir))}</code>。` +
      `<b>正文合计只是下限</b> —— 实际回收通常更多，因为索引也会一起收缩。`;

  const sorted = picked.slice().sort((a, b) => b.bytes - a.bytes);
  tEls.listD.innerHTML = sorted.slice(0, 200).map((t) =>
    `<li title="${esc(t.title)}"><span>${esc(t.title)}</span><span>${fmtBytes(t.bytes)}</span></li>`).join('')
    + (sorted.length > 200 ? `<li><span>…还有 ${(sorted.length - 200).toLocaleString()} 个</span><span></span></li>` : '');
  tEls.countD.textContent = `${count.toLocaleString()} 个`;

  tEls.dryWrap.hidden = true;
  tEls.word.value = '';
  tEls.confirmBox.hidden = false;
  tEls.msg.textContent = '';
  tEls.msg.className = 'drawer-msg';
  tEls.go.disabled = !!d.app.running;
  tEls.dryBtn.disabled = false;

  tEls.scrim.hidden = false;
  tEls.drawer.hidden = false;
}

const closeTaskDrawer = () => { tEls.scrim.hidden = true; tEls.drawer.hidden = true; };

const ROW_LABEL = {
  session: '会话', message: '消息', part: '附件块', model_usage: '模型调用',
  turn_usage: '回合', tool_usage: '工具调用', todo: '待办', session_entry: '会话条目',
  session_input: '输入队列', session_target: '会话目标', session_task_link: '任务链',
  input_history: '输入历史',
};

async function callPurge(dryRun) {
  const ids = [...taskState.sel];
  tEls.go.disabled = true;
  tEls.dryBtn.disabled = true;
  tEls.msg.className = 'drawer-msg';
  tEls.msg.textContent = dryRun ? '正在空跑核对…' : '正在备份、删除并重建数据库…可能要几十秒';
  if (!dryRun) tEls.go.textContent = '处理中…';

  try {
    const res = await fetch('/api/tasks/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dryRun ? { ids, dryRun: true } : { ids, confirm: tEls.word.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    if (dryRun) {
      // 空跑：把实际会删掉的行摊开，这是"明明白白"的最后一道
      const rows = Object.entries(data.counts).filter(([, n]) => n > 0);
      tEls.dryList.innerHTML = rows.map(([k, n]) =>
        `<li><span>${ROW_LABEL[k] || k}</span><span>${n.toLocaleString()}</span></li>`).join('')
        + `<li><span>孤儿行（应为 0）</span><span>${data.orphans.message + data.orphans.part}</span></li>`;
      tEls.dryWrap.hidden = false;
      tEls.msg.className = data.orphans.message + data.orphans.part === 0 ? 'drawer-msg is-ok' : 'drawer-msg is-err';
      tEls.msg.textContent = '空跑完成，数据库没有任何改动。确认无误后输入「清理」再删除。';
    } else {
      const freed = fmtBytes(data.freed);
      tEls.msg.className = 'drawer-msg is-ok';
      tEls.msg.textContent =
        `完成。数据库 ${fmtBytes(data.before.total)} → ${fmtBytes(data.after.total)}，回收 ${freed}。` +
        `完整性 ${data.integrity}，外键违规 ${data.fkViolations}。备份在 ${data.backup}`;
      await loadTasks(true);
      await load(true);          // db.sqlite 变小了，文件清单也要重算
      renderTasks();
      setTimeout(closeTaskDrawer, 2500);
    }
  } catch (err) {
    tEls.msg.className = 'drawer-msg is-err';
    tEls.msg.textContent = err.message;
  } finally {
    tEls.go.disabled = !!taskState.data?.app?.running;
    tEls.dryBtn.disabled = false;
    tEls.go.textContent = '删除';
  }
}

/* 任务面板事件 */
document.addEventListener('click', (e) => {
  const t = e.target;

  const chip = t.closest('[data-tstate]');
  if (chip) {
    const s = chip.dataset.tstate;
    taskState.states.has(s) ? taskState.states.delete(s) : taskState.states.add(s);
    renderTaskChips(); renderTaskList(); return;
  }

  // 分组头：折叠 / 展开（放在行处理之前，免得被 .trow 的勾选逻辑吞掉）
  const wsHead = t.closest('[data-ws-toggle]');
  if (wsHead) {
    const ws = wsHead.dataset.wsToggle;
    taskState.foldedWs.has(ws) ? taskState.foldedWs.delete(ws) : taskState.foldedWs.add(ws);
    renderTaskList();
    return;
  }

  if (t.closest('#taskGroupBtn')) {
    taskState.group = !taskState.group;
    const btn = document.getElementById('taskGroupBtn');
    btn.setAttribute('aria-pressed', String(taskState.group));
    btn.classList.toggle('is-on', taskState.group);
    renderTaskList();
    return;
  }

  const box = t.closest('[data-task-box]');

  if (box) {
    const id = box.dataset.taskBox;
    box.checked ? taskState.sel.add(id) : taskState.sel.delete(id);
    renderTaskList(); renderTaskFoot(); return;
  }

  const row = t.closest('.trow[data-task]');
  if (row) {
    const id = row.dataset.task;
    const task = taskState.data?.tasks.find((x) => x.id === id);
    if (!task || !isPurgeable(task)) return;   // 活跃任务不可选
    taskState.sel.has(id) ? taskState.sel.delete(id) : taskState.sel.add(id);
    renderTaskList(); renderTaskFoot(); return;
  }

  // 全选：范围就是当前筛选后可见的全部。状态标签、搜索都在它之前生效，
  // 所以"只选已删除"就是先点"已删除任务"标签，再点全选。
  if (t.closest('#taskPickAll')) {
    for (const x of visibleTasks()) if (isPurgeable(x)) taskState.sel.add(x.id);
    renderTaskList(); renderTaskFoot(); return;
  }
  if (t.closest('#taskClearSel')) {
    taskState.sel.clear(); renderTaskList(); renderTaskFoot(); return;
  }
  if (t.closest('#taskSkipPinned')) {
    tq.skipPinned = !tq.skipPinned; saveTqScope(); renderTaskQuick(); return;
  }
  if (t.closest('#taskQuickBtn')) {
    const s = taskQuickSet();
    taskState.sel.clear();
    for (const x of s.tasks) taskState.sel.add(x.id);
    renderTaskList(); renderTaskFoot();
    openTaskDrawer();
    return;
  }
  if (t.closest('#taskPurgeBtn')) { openTaskDrawer(); return; }
  if (t.closest('#tdryBtn')) { callPurge(true); return; }
  if (t.closest('#tdrawerGo')) { callPurge(false); return; }
  if (t.closest('#tdrawerClose') || t.closest('#tdrawerCancel') || t === tEls.scrim) { closeTaskDrawer(); return; }
});

tEls.age = $('taskAge');
tEls.age.addEventListener('change', () => {
  tq.ageDays = Number(tEls.age.value) || 0;
  saveTqScope();
  renderTaskQuick();
});

tEls.search.addEventListener('input', () => { taskState.q = tEls.search.value.trim().toLowerCase(); renderTaskList(); });
tEls.sort.addEventListener('change', () => { taskState.sort = tEls.sort.value; renderTaskList(); });
tEls.word.addEventListener('input', () => {
  if (tEls.word.value === '清理' && tEls.msg.classList.contains('is-err')) {
    tEls.msg.textContent = ''; tEls.msg.className = 'drawer-msg';
  }
});

/* ── 顶栏导航：高亮当前所在的一段 ───────────────────────── */

(function initNav() {
  const links = [...document.querySelectorAll('.nav-a')];
  const targets = links
    .map((a) => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);
  if (!targets.length) return;

  let raf = 0;
  const sync = () => {
    raf = 0;
    let current = targets[0];
    for (const t of targets) if (t.getBoundingClientRect().top <= 150) current = t;
    for (const a of links) a.classList.toggle('is-on', a.getAttribute('href') === `#${current.id}`);
  };
  addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(sync); }, { passive: true });
  sync();
})();

loadTqScope();

// 主题：?theme=dark|light 优先，其次记住上次的选择
(() => {
  const q = new URLSearchParams(location.search).get('theme');
  if (q === 'dark' || q === 'light') {
    document.documentElement.setAttribute('data-theme', q);
    try { localStorage.setItem('zci-theme', q); } catch {}
    return;
  }
  try {
    const saved = localStorage.getItem('zci-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch {}
})();

load().then(() => loadTasks()).catch((err) => {
  els.heroSub.innerHTML = `<b>扫描失败：</b>${esc(err.message)}`;
  els.scanNote.textContent = '出错';
});
