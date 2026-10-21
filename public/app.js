/* Agent Inspector —— 前端
 *
 * 一次只审一个 app：ZCode / Codex / Claude Code / Cursor 把东西存在完全不同的地方，
 * 分类表也各自一套。把四张表叠成一个总数只会骗人，所以顶栏那排标签决定下面每一块读谁的数据。
 */

const $ = (id) => document.getElementById(id);

const els = {
  rootPath: $('rootPath'), scanNote: $('scanNote'), rescanBtn: $('rescanBtn'), themeBtn: $('themeBtn'),
  appTabs: $('appTabs'),
  single: $('single'),
  skeleton: $('skeleton'),
  heroBytes: $('heroBytes'), heroSub: $('heroSub'),
  diagnosis: $('diagnosis'), diagLede: $('diagLede'), diagTitleText: $('diagTitleText'),
  rec: $('rec'), recName: $('recName'), recBtn: $('recBtn'), recCap: $('recCap'), recScope: $('recScope'),
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
  tooltip: $('tooltip'), toast: $('toast'),
};

const state = {
  scan: null,            // /api/scan 的原始返回：{ apps: [每个 app 一份视图], grand, ... }
  apps: [],              // 本次扫描到的 app 视图，按注册表顺序
  appId: null,           // 当前在看哪个 app
  index: null,           // 当前 app 的那一份视图 —— 渲染只读它
  selection: new Set(),  // 勾选的是 "app/目标:路径"，同一路径在两个目标里不会互相顶掉
  open: new Set(),
  explain: new Set(),    // 展开了"这是什么 / 为什么在这里"的分类
  q: '',
  statuses: new Set(),   // 空 = 全部
  sort: 'size',
  group: null,           // 三块里被勾上的那一组：orphan / live / other；null = 不筛
  recOff: new Set(),     // 被排除在"推荐清理"之外的分类（按 app 各记一份）
  recReady: false,
  busy: false,
};

/* 一个 app 可能有多个扫描目标（Cursor 的 ~/.cursor 与 App Support）。
   勾选、删除都要带上目标与 app，否则两个目标里的同名路径会互相冒名顶替。
   行上的 k 在 indexRows() 里预置好了；keyOf 只为尚未标过的临时对象兜底。 */
const keyOf = (f, appId) => f.k || `${appId !== undefined ? appId : (f.app ?? state.appId)}/${f.t}:${f.p}`;

/* ── 工具 ───────────────────────────────────────────────── */

/* fmtBytes 与 isSelectable 在 logic.js —— 纯函数，node --test 能直接 import 测。 */
import { fmtBytes, isSelectable } from './logic.js';

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

/**
 * 一行能不能被选中 —— 判据本体在 logic.js 的 isSelectable（有测试）。
 * 这里只做一件事：分类元信息从当前视图里查出来再交给它。
 */
const canPick = (f, cat) => isSelectable(f, cat || catOfRow(f));

/** 一批文件里真正能被选中的那些。 */
const selectableOnly = (files, cat) => files.filter((f) => canPick(f, cat));

const sumCats = (cats) => ({
  cats,
  bytes: cats.reduce((s, c) => s + c.bytes, 0),
  count: cats.reduce((s, c) => s + c.count, 0),
});

const REC_KEY = 'zci-rec-off';   // 每个 app 各记一份：分类表本来就不共用

function recStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(REC_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function loadRecOff() {
  // 只认得当前这个 app 存在的分类；旧版留下的、或换 app 带过来的 id 直接丢掉
  const ids = recStore()[state.appId];
  if (Array.isArray(ids)) {
    const known = new Set(recommendAll().map((c) => c.id));
    const kept = ids.filter((id) => known.has(id));
    if (ids.length || kept.length) return new Set(kept);
  }
  return new Set(recommendAll().filter((c) => c.recommendDefaultOff).map((c) => c.id));
}

function saveRecOff() {
  try {
    const all = recStore();
    all[state.appId] = [...state.recOff];
    localStorage.setItem(REC_KEY, JSON.stringify(all));
  } catch {}
}


/* ── 数据 ───────────────────────────────────────────────── */

/* ── 忙碌态 ─────────────────────────────────────────────────
   两处反馈各管一件事：顶栏那条细线表示"后台在忙"（页面仍然可读可滚），
   按钮上的转圈表示"这一下是你按的，正在等它"。两者互不替代 ——
   只有按钮转圈时，人不知道别处是否也卡住了；只有顶栏细线时，
   人又不知道自己那一按到底算不算数。 */

function setBusy(on) {
  document.body.classList.toggle('is-busy', Boolean(on));
  els.single?.setAttribute('aria-busy', on ? 'true' : 'false');
}

function setBtnBusy(btn, on) {
  if (!btn) return;
  btn.classList.toggle('is-busy', Boolean(on));
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
  // 关掉忙碌态时只解除自己加上的禁用；本来就被业务逻辑禁用的按钮不能被顺手打开。
  // 用 data 属性记一笔"这个禁用是我加的"，收尾时才知道该不该还原。
  if (on) {
    btn.dataset.wasDisabled = btn.disabled ? '1' : '';
    btn.disabled = true;
  } else if (!btn.dataset.wasDisabled) {
    btn.disabled = false;
  }
  if (!on) delete btn.dataset.wasDisabled;
}

/** 首次扫描结束后把骨架拿掉：先淡出，再从 DOM 里移除。 */
function dropSkeleton() {
  const sk = els.skeleton;
  if (!sk) return;
  sk.classList.add('is-done');
  isReducedMotion()
    ? sk.remove()
    : setTimeout(() => sk.remove(), 200);
}

function isReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

async function load(refresh = false) {
  setBusy(true);
  els.scanNote.textContent = refresh ? '重新扫描中…' : '扫描中…';
  try {
    const res = await fetch('/api/scan' + (refresh ? '?refresh=1' : ''));
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    state.scan = await res.json();
    state.apps = state.scan.apps;
    // 每行在数据入手的这一刻就带上归属与稳定 key。之前靠 files.includes()
    // 反查 —— 抽屉里 3352 行 × 1.8 万文件是千万级比较，而这里一次写入零成本。
    indexRows();
    if (!state.apps.some((a) => a.app === state.appId)) state.appId = pickApp();
    applyApp();
  } finally {
    dropSkeleton();
    setBusy(false);
  }
}

/** 给每个文件行打上所属 app 与 key，后续任何地方都不必反查。 */
function indexRows() {
  state.fileByKey = new Map();
  state.catById = new Map();   // `appId\u0000catId` → 分类元信息
  state.appById = new Map();
  for (const a of state.apps) {
    state.appById.set(a.app, a);
    for (const c of a.catalog || []) state.catById.set(`${a.app}\u0000${c.id}`, c);
    for (const f of a.files) {
      f.app = a.app;
      f.k = `${a.app}/${f.t}:${f.p}`;
      state.fileByKey.set(f.k, f);
    }
  }
}

/** 顶部标签的展示顺序：按 Agent 名称的字母顺序，与注册表顺序解耦。 */
const sortedApps = () =>
  [...state.apps].sort((a, b) => a.label.localeCompare(b.label, 'en'));

/** 默认看谁：上次看的那个 → 字母序第一个装了的 → 字母序第一个。 */
function pickApp() {
  const sorted = sortedApps();
  try {
    const last = localStorage.getItem(APP_KEY);
    if (last) {
      const hit = sorted.find((a) => a.app === last && a.totals.files > 0);
      if (hit) return hit.app;
    }
  } catch {}
  return (sorted.find((a) => a.totals.files > 0) || sorted[0])?.app || null;
}

/** 把渲染层切到当前 app 的那一份视图。 */
function applyApp() {
  state.index = state.apps.find((a) => a.app === state.appId) || null;
  state.selection.clear();
  // 换 app，筛选也从头开始。搜索词与状态筛选同样是"这一屏的读法"，
  // 留着上一个工具的词会让新工具一进来就是空白（Cursor 里搜不到
  // ZCode 那些 sess_ 路径），看起来像工具坏了。
  state.group = null;
  state.q = '';
  state.statuses.clear();
  els.search.value = '';
  state.recReady = false;

  if (state.index) {
    // 按分类预分组，避免每次渲染都全量过滤
    state.byCat = new Map();
    for (const f of state.index.files) {
      let arr = state.byCat.get(f.c);
      if (!arr) state.byCat.set(f.c, (arr = []));
      arr.push(f);
    }
  }

  try { localStorage.setItem(APP_KEY, state.appId); } catch {}
  if (state.index) {
    els.rootPath.textContent = state.index.targets.filter((t) => t.exists).map((t) => t.short).join(' + ')
      || `${state.index.label}：这台机器上没有`;
  } else {
    els.rootPath.textContent = 'Agent Inspector';
  }
  els.scanNote.textContent = `扫描用时 ${(state.scan.durationMs / 1000).toFixed(1)}s`;

  renderAppTabs();
  renderAll();
  flashSwitch();
}

/** 切工具时让内容轻推一下：数据是瞬间换的，没有这个提示会像"点了没反应"。 */
function flashSwitch() {
  if (isReducedMotion()) return;
  for (const el of document.querySelectorAll('#single > section, #single > .note')) {
    el.classList.remove('is-switching');
    // 强制重排，让同一个类能连续触发两次
    void el.offsetWidth;
    el.classList.add('is-switching');
    // 按固定时长摘类，不依赖 animationend：首屏那记 enter 动画也会冒泡
    // animationend 上来，靠事件判断容易漏掉或多摘。
    setTimeout(() => el.classList.remove('is-switching'), 220);
  }
}

const APP_KEY = 'zci-app';

function renderAppTabs() {
  els.appTabs.innerHTML = sortedApps().map((a) => {
    const on = a.app === state.appId;
    const empty = a.totals.files === 0;
    // 标签上只写名字：体积字数不一样，塞进来会让相邻的名字跟着左右挪。
    // 数值放进 title，鼠标停上去仍然看得到。
    /* tablist 的标准键盘模型是 roving tabindex：整排只占一个 Tab 位，
       进了组之后用左右箭头换标签。四个都是 tabindex=0 的话，键盘用户
       每过一个工具就得按一次 Tab，而这四个本来是一件事的四个选项。 */
    return `<button type="button" class="app-tab ${on ? 'is-on' : ''}${empty ? ' is-empty' : ''}"
      role="tab" id="apptab-${esc(a.app)}" aria-selected="${on}" tabindex="${on ? '0' : '-1'}"
      aria-controls="single" data-app="${esc(a.app)}"
      title="${esc(a.targets.map((t) => `${t.short}${t.exists ? '' : '（没有）'}`).join('、'))} · ${
        empty ? '未安装' : `${fmtBytes(a.totals.bytes)} · ${a.totals.files.toLocaleString()} 个文件`}">
      <span class="app-tab-name">${esc(a.label)}</span>
    </button>`;
  }).join('');
  // 内容区（tabpanel）的名字跟着选中项走。写死在 HTML 里会在切换后说错话。
  if (state.appId) els.single.setAttribute('aria-labelledby', `apptab-${state.appId}`);
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
  const shape = `${esc(state.index.label)} 共 <b>${t.files.toLocaleString()}</b> 个文件、<b>${t.dirs.toLocaleString()}</b> 个目录。`;
  const others = state.apps.filter((a) => a.app !== state.appId && a.totals.bytes > 0);
  const grand = others.length
    ? `${state.apps.length} 个工具加起来 <b>${fmtBytes(state.scan.grand.bytes)}</b>，另有 ${
        others.map((a) => `${esc(a.label)} ${fmtBytes(a.totals.bytes)}`).join('、')}。`
    : '';
  els.heroSub.innerHTML = runawayBytes > 0
    ? shape + `其中 <b>${fmtBytes(runawayBytes)}</b> 来自 <b>${runawayCount}</b> 个失控放大的日志，` +
      `占 <b>${((runawayBytes / t.bytes) * 100).toFixed(0)}%</b>。` + grand
    : shape + grand;

  /* 诊断段。数字全部从这次扫描里现算 —— 写死"4 个文件 / 34 GB"只对写出它的那台机器成立，
     换一台就是撒谎。这里唯一固定的东西是机器无关的成因。 */
  els.diagnosis.hidden = runawayBytes <= 0;
  if (runawayBytes > 0) {
    const files = (state.index.files || []).filter((f) => f.c === 'runaway');
    const biggest = files.reduce((a, f) => Math.max(a, f.s), 0);
    const rootShort = state.index.targets[0].short;
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
    const cat = catOfRow(f);
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
   留着只会让人以为里面还有东西。
 *
 * 顺带把筛完的结果带出去：renderGroups 马上就要用同一批行，
 * 之前这里 some() 扫一遍、那边 filter() 再扫一遍 —— 每次按键两遍全量。 */
function visibleCategories() {
  const out = [];
  for (const c of state.index.categories) {
    const files = filesOf(c.id);
    const hit = files.filter(matches);
    if (hit.length) out.push({ cat: c, files: hit });
  }
  return out;
}

function renderGroups() {
  const cats = visibleCategories();

  els.emptyHint.hidden = cats.length > 0;

  els.groups.innerHTML = cats.map(({ cat, files }) => {
    // 一切以"当前看得见的这些行"为准：卡片头上的勾选框、计数、已选数都算这一批。
    // 没有筛选时它就是这个分类的全部。
    const all = sortFiles(files);
    const isOpen = state.open.has(cat.id);
    const totalHere = filesOf(cat.id).length;
    /* 卡片头那个框的状态只能按"真正能勾的行"来算。
       用 all 算的话：软链接、受保护项永远勾不上，于是这个框永远停在
       "勾了一半"（indeterminate）—— 点一次全选它还是半选，点第二次才取消，
       人看到的是"这个框坏了"。 */
    const pickable = selectableOnly(all, cat);
    const selCount = pickable.filter((f) => state.selection.has(keyOf(f))).length;
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
          <span class="group-size" title="${visBytes.toLocaleString()} 字节${
            filtered ? `（整个分类 ${cat.bytes.toLocaleString()} 字节）` : ''}">${
            visLabel}${showAll ? `<em> / ${allLabel}</em>` : ''}</span>
          <input type="checkbox" data-group-box="${cat.id}"
            ${cat.verdict === 'never' ? 'disabled aria-label="受保护内容，不可清理"' : ''}
            ${selCount && selCount === pickable.length ? 'checked' : ''}
            ${selCount && selCount < pickable.length ? 'data-indeterminate="1"' : ''}
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
  const on = state.selection.has(keyOf(f));
  // 软链接：扫描时按链接本身记录（不跟随），服务端也一律拒绝删除。
  // 所以这里既不能勾，也要在行上说明白 —— 画成可勾的条目等于骗人点一下再报错。
  const isLink = Boolean(f.link);
  const protectedRow = cat.verdict === 'never' || isLink;
  const when = new Date(f.m).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const cut = f.p.lastIndexOf('/');
  const dir = cut < 0 ? '' : f.p.slice(0, cut + 1);
  const name = cut < 0 ? f.p : f.p.slice(cut + 1);
  // 一个 app 有多个根（Cursor 的 ~/.cursor 与 App Support）时，相对路径看不出它落在哪一边
  const tTag = multiTarget()
    ? `<span class="row-tag" title="位于 ${esc(targetShort(f.t))}">${esc(targetLabel(f.t))}</span>` : '';
  // 只给可清理的那一种打标。会话 id 是 8 位十六进制，摆在行里没人读得懂，
  // 也没人能拿它做什么 —— 挪进 tooltip，行里只留"孤儿"这两个字。
  const sidTag = f.sid && f.orphan
    ? `<span class="row-tag is-orphan" title="会话 ${esc(f.sid)} 已不在 ${esc(state.index.label)} 的会话库里，文件是残骸">孤儿</span>`
    : '';
  const linkTag = isLink
    ? `<span class="row-tag" title="符号链接：不跟随、不删除，删它等于去改别的目录">软链接</span>` : '';
  return `<div class="row ${on ? 'is-on' : ''}${isLink ? ' is-link' : ''}">
    <input type="checkbox" data-key="${esc(keyOf(f))}" ${on ? 'checked' : ''}
      ${protectedRow ? `disabled aria-label="${isLink ? '符号链接，不可清理' : '受保护内容'}"` : ''}>
    <span class="row-path" title="${esc(targetShort(f.t)) + '/' + esc(f.p)}">
      <span class="row-dir">${esc(dir)}</span><b class="row-name">${esc(name)}</b>${tTag}${linkTag}${sidTag}
    </span>
    <span class="row-size">${fmtBytes(f.s)}</span>
    <span class="row-time">${when}</span>
    ${canReveal() ? `<button class="row-reveal" data-reveal="${esc(keyOf(f))}" title="在 Finder 中显示" aria-label="在 Finder 中显示">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>
    </button>` : ''}
  </div>`;
}

/** 当前 app 有没有第二个扫描目标；有的话行上要标出来。 */
const multiTarget = () => (state.index?.targets || []).length > 1;
const targetView = (key) => state.index.targets.find((t) => t.key === key) || {};
const targetShort = (key) => targetView(key).short || key;
const targetLabel = (key) => targetView(key).label || key;

/* ── 勾选 ───────────────────────────────────────────────── */

/** 全域模式下勾选跨 app；state.index 为空时从各 app 视图里查。 */
function allFiles() {
  return state.index ? state.index.files : state.apps.flatMap((a) => a.files);
}

/** 一次遍历同时算出选中体积与按 (app,target) 分批 —— 两个调用点各扫一遍全量是浪费。 */
function selectionStats() {
  let bytes = 0, count = 0;
  const batches = new Map();
  for (const f of state.fileByKey.values()) {
    if (!state.selection.has(f.k)) continue;
    /* 最后一道：真正发出去的那些路径也只留能删的。
       上面每个入口都过了 isSelectable，但这条线上任何一条脏数据都会让
       整个批次被服务端拒绝（服务端先校验全批再动手），所以宁可在这里再挡一次。 */
    if (!canPick(f)) continue;
    bytes += f.s;
    count += 1;
    const key = `${f.app}\u0000${f.t}`;
    let b = batches.get(key);
    if (!b) batches.set(key, b = [f.app, f.t, []]);
    b[2].push(f.p);
  }
  return { bytes, count, batches: [...batches.values()] };
}

const selectedBytes = () => selectionStats().bytes;

/* 勾选 → [[app, target, paths], …]：一次操作里跨了 app 跨了目标就分几次发，
   每个目标各自做越界与保护校验，不会因为拼在一起而放宽任何一条。 */
const selectedByTarget = () => selectionStats().batches;

/* "在 Finder 中显示"是 macOS 的 open -R。别处没有这个动作，
   服务端会报 canReveal:false，那就干脆不摆这个按钮 —— 摆了也只是让人白按。 */
const canReveal = () => state.scan?.canReveal !== false;

function renderActionbar() {
  const n = state.selection.size;
  els.actionbar.hidden = n === 0;
  els.abCount.textContent = n.toLocaleString();
  els.abBytes.textContent = fmtBytes(selectedBytes());
  els.abReveal.hidden = !canReveal();
}

/* ── 抽屉 ───────────────────────────────────────────────── */

/** 一行文件属于哪个 app —— 行在 indexRows() 里就带着归属，不反查。 */
const appIdOfRow = (f) => f.app || state.appId;
const rowTitle = (f) => {
  const view = state.apps.find((a) => a.app === appIdOfRow(f));
  const t = view?.targets.find((x) => x.key === f.t);
  return `${t ? t.short : ''}/${f.p}`;
};

/** 按 (app, 行) 取分类元信息：预建的 Map 查一次，不再逐行搜 catalog。 */
function catOfRow(f) {
  return state.catById?.get(`${appIdOfRow(f)}\u0000${f.c}`)
    || { id: f.c, label: f.c, status: 'warning', verdict: 'review' };
}

function openDrawer() {
  /* 兜底：选区里理论上不该有软链接或受保护项（所有入口都过了 isSelectable），
     但凡是"整批删不掉"的代价，都值得在这里再拦一次 —— 一条脏数据混进来，
     抽屉照样会打开、按钮照样会亮，然后整批被服务端拒绝。
     真发生了就把它从选区里剔掉，并在下面说明剔了几个。 */
  const raw = allFiles().filter((f) => state.selection.has(keyOf(f)));
  const rows = raw.filter((f) => canPick(f));
  const dropped = raw.length - rows.length;
  if (dropped) {
    for (const f of raw) if (!canPick(f)) state.selection.delete(keyOf(f));
  }
  if (!rows.length) return;
  const bytes = rows.reduce((s, f) => s + f.s, 0);
  const biggest = rows.reduce((a, b) => (a.s >= b.s ? a : b), rows[0]);

  els.drawerStats.innerHTML = `
    <div class="dstat"><span>条目</span><b>${rows.length.toLocaleString()}</b></div>
    <div class="dstat"><span>合计</span><b>${fmtBytes(bytes)}</b></div>
    <div class="dstat"><span>最大一项</span><b title="${esc(rowTitle(biggest))}">${fmtBytes(biggest.s)}</b></div>`;

  // 这批里都是些什么 —— 按分类摊开，别只给一个总数
  // 跨 app 时同名分类（各工具都有一类"缓存"）是不同的元信息对象，
  // 按对象 identity 求 key 会把同一类拆成好几项。按分类 id 合并。
  const mix = new Map();
  for (const f of rows) {
    const c = catOfRow(f);
    const hit = mix.get(c.id);
    if (hit) hit.bytes += f.s;
    else mix.set(c.id, { cat: c, bytes: f.s });
  }
  const mixSorted = [...mix.values()].sort((a, b) => b.bytes - a.bytes);
  const head = mixSorted.slice(0, 5);
  els.drawerMix.innerHTML = '包含 ' + head.map(({ cat: c, bytes }) =>
    `<span class="mix-item ${STATUS_CLASS[c.status]}">
       <span class="swatch"></span>${esc(c.label)} <em>${fmtBytes(bytes)}</em>
     </span>`).join('')
    + (mixSorted.length > head.length
        ? `<span>…共 ${mixSorted.length} 类</span>` : '');

  const shown = rows.slice().sort((a, b) => b.s - a.s).slice(0, 300);
  els.drawerList.innerHTML = shown.map((f) => {
    const cut = f.p.lastIndexOf('/');
    const dir = cut < 0 ? '' : f.p.slice(0, cut + 1);
    const name = cut < 0 ? f.p : f.p.slice(cut + 1);
    return `<li title="${esc(rowTitle(f))}">
      <span class="dl-path"><span class="row-dir">${esc(dir)}</span><b>${esc(name)}</b></span>
      <span>${fmtBytes(f.s)}</span></li>`;
  }).join('')
    + (rows.length > 300
        // 截断的只是这张预览表，不是删除范围 —— 不写清楚，人会以为剩下的不删。
        ? `<li class="drawer-more"><span>下面还有 ${(rows.length - 300).toLocaleString()} 项没列出来` +
          `（这张表只列最大的 300 项），<b>它们同样在这次的删除范围里</b>。</span><span></span></li>`
        : '');
  els.drawerListCount.textContent = `${rows.length.toLocaleString()} 项`;

  els.drawerMsg.textContent = dropped
    ? `已自动剔除 ${dropped} 项不能删除的条目（软链接、受保护内容）—— 它们留在原处，这一批照样能清。`
    : '';
  els.drawerMsg.className = dropped ? 'drawer-msg is-warn' : 'drawer-msg';
  els.purgeWord.value = '';
  els.drawerGo.disabled = false;

  // 两条路各有各的堵法：受保护内容不能彻底删除；非 macOS 没有废纸篓可用。
  const anyProtected = rows.some((f) => catOfRow(f).verdict === 'never');
  const noTrash = state.scan.canTrash === false;
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
  openModal(els.drawer);
}

function closeDrawer() {
  els.scrim.hidden = true;
  els.drawer.hidden = true;
  closeModal();
}

/* ── 模态抽屉的焦点 ───────────────────────────────────────
   两个抽屉都声明了 aria-modal="true"，但之前只有"看得见"这件事做对了：
   焦点还留在后面那个按钮上，Tab 会一路跑到抽屉背后的页面里去。
   读屏用户听到"对话框"，按 Tab 却走出了对话框 —— 比不声明更糟。

   这里只管三件事：进来时把焦点放到第一个可操作元素、Tab / Shift+Tab
   在抽屉内部循环、关掉之后把焦点还给打开它的那个按钮。 */

let lastFocused = null;

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusablesIn(root) {
  // 不能用 offsetParent 判可见：抽屉本身就是 fixed + 滚动容器。
  // 用 getClientRects 判"有没有盒子"，再排除 hidden 属性带来的 display:none。
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

function openModal(root) {
  lastFocused = document.activeElement;
  document.body.classList.add('is-modal');
  /* 这里不能用 requestAnimationFrame 等"布局完成" —— 抽屉的 hidden 刚被
     摘掉，rAF 有可能在样式重算之前就跑了，那时 focusablesIn() 拿到的是
     空数组，焦点留在背后那个按钮上（实测就是这样）。同步读一次
     getClientRects() 会把布局强制做完，紧接着就能安全地取第一个元素。 */
  void root.getClientRects();
  const first = focusablesIn(root)[0];
  (first || root).focus?.();
}

function closeModal() {
  document.body.classList.remove('is-modal');
  if (lastFocused && document.contains(lastFocused)) {
    lastFocused.focus?.();
  }
  lastFocused = null;
}

/** 抽屉里按 Tab：走到头就回到开头，Shift+Tab 反之。 */
function trapTab(e, root) {
  const items = focusablesIn(root);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault(); first.focus();
  }
}

const mode = () => document.querySelector('input[name="mode"]:checked').value;

function syncDrawerMode() {
  const purge = mode() === 'purge';
  els.purgeConfirm.hidden = !purge;
  els.drawerGo.textContent = purge ? '彻底删除' : '移入废纸篓';
  els.drawerGo.className = 'btn ' + (purge ? 'btn-danger' : 'btn-primary');
}

async function runClean() {
  const batches = selectedByTarget();   // [[target, paths], …] —— 跨目标时分几次发
  const purge = mode() === 'purge';
  if (!batches.length) return;
  if (purge && els.purgeWord.value !== '彻底删除') {
    els.drawerMsg.textContent = '确认串不正确，请输入「彻底删除」四个字。';
    els.drawerMsg.className = 'drawer-msg is-err';
    return;
  }

  setBtnBusy(els.drawerGo, true);
  els.drawerMsg.textContent = purge ? '正在彻底删除…' : '正在移入废纸篓…';
  els.drawerMsg.className = 'drawer-msg';

  try {
    const done = [];
    const failed = [];
    for (const [appId, target, paths] of batches) {
      const res = await fetch(purge ? '/api/purge' : '/api/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(purge
          ? { app: appId, target, paths, confirm: els.purgeWord.value }
          : { app: appId, target, paths }),
      });
      const data = await res.json();
      // 任一批被拒绝就停下：后面的目标还没动，人能看到的是完整结果，不是删了一半的现场
      if (!res.ok) throw new Error(data.error || res.statusText);
      done.push(...(data.moved || data.deleted || []));
      failed.push(...(data.failed || []));
    }

    if (failed.length) {
      els.drawerMsg.className = 'drawer-msg is-err';
      els.drawerMsg.textContent = `完成 ${done.length} 项，${failed.length} 项失败：${failed.map((f) => f.path).join('、')}`;
      // 有失败就留着抽屉 —— 这份清单本身就是要看的东西
      return;
    }

    /* 全部成功：先关抽屉，再把结果搬到屏幕上。
       之前是反过来 —— await load(true) 重扫一遍（约 1 秒）之后才开始
       1.2 秒的延时，于是"转圈停了，侧栏还杵着"，人以为没反应。
       动作在这一刻已经完成了，抽屉就没有继续开着的理由。 */
    // 回收量也带上精确字节：抽屉关掉之后，这里是唯一还能看到总数的地方
    const freed = done.reduce((s, x) => s + (x.bytes > 0 ? x.bytes : 0), 0);
    const sizeTxt = freed > 0 ? `，共 ${bytesWithExact(freed)}` : '';
    const msg = purge
      ? `已彻底删除 <b>${done.length.toLocaleString()}</b> 项${sizeTxt}。`
      : `已把 <b>${done.length.toLocaleString()}</b> 项移入废纸篓${sizeTxt}，可在 Finder 的「废纸篓」中恢复。`;
    closeDrawer();
    showToast(msg);

    // 重扫只是让屏幕上的数字跟上，不需要人等它
    load(true).catch((err) => showToast(`重新扫描失败：${esc(err.message)}`, { error: true }));
  } catch (err) {
    els.drawerMsg.className = 'drawer-msg is-err';
    els.drawerMsg.textContent = err.message;
  } finally {
    setBtnBusy(els.drawerGo, false);
  }
}

/** 在 Finder 中显示：key 就是 "app/目标:路径"，直接查表，不再线性扫全部文件。 */
async function revealPath(key) {
  const f = state.fileByKey?.get(key);
  if (!f) return;
  await fetch('/api/reveal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: appIdOfRow(f), target: f.t, path: f.p }),
  });
}

/* ── 操作结果提示 ───────────────────────────────────────── */

/**
 * 在屏幕底部说一句"刚才做了什么"。
 *
 * 抽屉里那行结果消息会随抽屉一起消失 —— 所以要么让抽屉多留两秒等人读完，
 * 要么把结果搬到抽屉外面。前者正是之前的做法，代价是"转圈停了，侧栏还杵着"：
 * 动作早就完成了，用户却在等一个纯装饰的延时。
 *
 * 注意它 pointer-events:none（不该挡住底下的东西），所以面积类数字只能靠
 * title 属性给精确字节数 —— 悬停气泡用不上。凡是要写体积的地方，
 * 都按 README 那条规矩带上 title="<精确字节> 字节"。
 *
 * @param {string} html  允许 <b> 与 <code>，调用方自己 esc 过动态内容
 * @param {{error?: boolean, ms?: number}} [opts]
 */
let toastTimer = 0;
function showToast(html, opts = {}) {
  const el = els.toast;
  if (!el) return;
  el.innerHTML = html;
  el.classList.toggle('is-err', Boolean(opts.error));
  el.hidden = false;
  clearTimeout(toastTimer);
  // 读得完的最短时间：一行字约 3 秒；出错时留久一点，人可能要看两眼
  toastTimer = setTimeout(() => { el.hidden = true; }, opts.ms ?? (opts.error ? 6000 : 4000));
}

/** 带精确字节数的体积片段 —— toast 里所有面积数字都走它。 */
const bytesWithExact = (n) => `<b title="${n.toLocaleString()} 字节">${fmtBytes(n)}</b>`;

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
  els.single.hidden = false;
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
     计数用真正"能勾"的条数 —— 受保护的内容（凭据、会话库、配置）与软链接
     都不进勾选，所以「非会话文件」那块的已选数会比它自己的文件数少，这是对的，照实写。 */
  const selectable = (xs) => xs.filter((f) => canPick(f));

  const anyPicked = state.selection.size > 0;
  const block = (cls, title, desc, xs, extra, split) => {
    const can = selectable(xs);
    const picked = can.filter((f) => state.selection.has(keyOf(f)));
    const allOn = can.length > 0 && picked.length === can.length;
    const part = picked.length > 0 && !allOn;     // 只勾了这一组的一部分
    const toggle = can.length < xs.length ? '（受保护的几项不会被勾上）' : '';
    // 空分组没有可勾的东西：不给 tabindex、不写"点这里选"，也不假装是复选框。
    // 留一个空的 role=checkbox 让人点下去没反应，比不放这块更糟。
    const empty = can.length === 0;
    // 三种状态说三种话。勾一半时点下去是"补全"，不是"取消" —— 文案写反了就是骗人。
    // 没勾的那两块还要说明：点它不是"加进去"，是"换成它"。
    const flag = empty
      ? '这一组没有可勾选的条目'
      : allOn
        ? `已选 <b>${picked.length.toLocaleString()}</b> 项 · <b>${fmtBytes(sum(picked))}</b>　再点一下取消${toggle}`
        : part
          ? `已选 <b>${picked.length.toLocaleString()}</b> / <b>${can.length.toLocaleString()}</b> 项 · ` +
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
    return `
    <section class="${cls2}"${attrs}>
      <header class="split-head">
        <h3><span class="box" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span>${esc(title)}</h3>
        <span class="split-size" title="${sum(xs).toLocaleString()} 字节">${fmtBytes(sum(xs))}</span>
      </header>
      <p class="split-desc">${esc(desc)}</p>
      <p class="split-meta">${xs.length.toLocaleString()} 个文件${extra}</p>
      <p class="split-flag">${flag}</p>
    </section>`;
  };

  els.split.innerHTML = [
    block('is-orphan', '会话已不存在', '会话库里找不到它，只剩文件残留。可以直接清理。', orphan,
      sids(orphan) ? ` · ${sids(orphan).toLocaleString()} 个会话` : '', 'orphan'),
    block('is-live', '会话仍在', `这些会话还在 ${esc(state.index.label)} 里，文件有用，请谨慎。`, live,
      sids(live) ? ` · ${sids(live).toLocaleString()} 个会话` : '', 'live'),
    block('is-other', '非会话文件', '日志、缓存、配置等，不属于任何会话。', other, '', 'other'),
  ].join('');
}

/* 按钮上直接写出这批有多大，点之前就知道会发生什么。
   下面的条目可以逐项开关，按钮数字跟着变。 */
function renderRecommend() {
  // 一个字节都没有的推荐项不立空壳 —— 跟分类卡片同一条规矩
  const all = recommendAll().filter((c) => c.bytes > 0);
  if (!all.length) {
    els.rec.hidden = true;
    /* 整条 lane 收起来了，里面的数字也得擦掉。留着上一轮的 "28 KB" 在这
       —— 它确实看不见，但下一次谁把它显示出来（比如某个分类又长回来），
       第一帧就会先闪一下旧数字。 */
    els.recName.textContent = '推荐清理';
    els.recFigure.textContent = '—';
    els.recSub.innerHTML = '';
    els.recScope.innerHTML = '';
    els.recBtn.disabled = true;
    els.recBtn.textContent = '推荐清理';
    els.recCap.innerHTML = '';
    return;
  }
  els.rec.hidden = false;

  const on = all.filter((c) => !state.recOff.has(c.id));
  const { cats, bytes, count } = sumCats(on);
  const off = all.filter((c) => state.recOff.has(c.id));

  els.recFigure.textContent = fmtBytes(bytes);

  /* 这一句得跟着实际范围变。写死"日志、缓存与系统垃圾"只在
     ZCode/Codex/Claude 下成立；Cursor 的推荐项是「已安装扩展」，
     那句"删掉不影响会话、配置和凭据"对它就是假话。 */
  els.recName.textContent = all.length <= 2 ? all.map((c) => c.label).join(' · ') : '文件与日志';
  els.recSub.innerHTML = !on.length
    ? `推荐项已全部排除 —— 点上面的条目可以放回来。`
    : `${esc(cats.map((c) => c.label).join('、'))}，共 <b>${count.toLocaleString()}</b> 项。` +
      (cats.every((c) => c.verdict === 'safe' || c.verdict === 'junk')
        ? `删掉不影响会话、配置和凭据。`
        : `删了有代价 —— 每一类下面都写了具体会怎样。`);

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
    const isOn = !state.recOff.has(c.id);
    return `<button type="button" class="rec-chip ${STATUS_CLASS[c.status]} ${isOn ? 'is-on' : ''}"
      data-rec="${c.id}" aria-pressed="${isOn}" title="${esc(c.what)}">
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

  // 换 app：分类表、清单、历史会话整条线跟着换
  const tab = t.closest('[data-app]');
  if (tab) {
    if (tab.dataset.app === state.appId) return;
    state.appId = tab.dataset.app;
    applyApp();
    loadTasks();
    // 只有已经滚下去了才回页首 —— 磁盘占用现在就在首屏，
    // 站在顶部还硬滚一次等于白抖一下。也不做平滑滚动，
    // 内容正淡入时再滑一屏会晕。
    if (window.scrollY > 40) window.scrollTo({ top: 0 });
    return;
  }

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
    const cat = state.index.categories.find((c) => c.id === id);
    // 只动当前看得见的那些行，跟卡片头上那个框自身的勾选状态对得上；
    // 软链接与受保护项不进选区 —— 服务端会拒绝，选了等于白选。
    for (const f of selectableOnly(filesOf(id).filter(matches), cat)) {
      checked ? state.selection.add(keyOf(f)) : state.selection.delete(keyOf(f));
    }
    state.open.add(id);
    renderGroups(); renderActionbar(); renderSplit();
    return;
  }

  // 单文件
  const fbox = t.closest('input[data-key]');
  if (fbox) {
    fbox.checked ? state.selection.add(fbox.dataset.key) : state.selection.delete(fbox.dataset.key);
    // 三块上的"已选 N"要跟着走 —— 手动取消一项，那块就该显示勾了一半
    renderGroups(); renderActionbar(); renderSplit();
    return;
  }

  // 在 Finder 中显示
  const reveal = t.closest('[data-reveal]');
  if (reveal) { await revealPath(reveal.dataset.reveal); return; }

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
    // 受保护内容与软链接都不进勾选 —— 判据只有 isSelectable 一处
    const mine = state.index.files.filter((f) => groupOf(f) === g && canPick(f));
    const allOn = mine.length > 0 && mine.every((f) => state.selection.has(keyOf(f)));
    // 三块互斥：它们是把全部文件劈成三份，一组就是一组。
    // 所以换一组是"换成它"，不是"再加上它" —— 先清干净再勾。
    state.selection.clear();
    if (allOn) {
      state.group = null;                             // 再点一下 = 整组取消
    } else {
      for (const f of mine) state.selection.add(keyOf(f));
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
    if (first) await revealPath(first);
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
      // 推荐分类里也可能混着软链接（插件缓存里的 .bin、app-server 的旧版本
      // 可执行文件都是）。带上它们 → 服务端拒绝整批 → 一个都删不掉。
      for (const f of selectableOnly(filesOf(c.id), c)) state.selection.add(keyOf(f));
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
    // visibleCategories() 已经把筛完的行带出来了，不必再 filter 一遍
    for (const { cat, files } of visibleCategories()) {
      for (const f of selectableOnly(files, cat)) state.selection.add(keyOf(f));
    }
    renderSplit(); renderGroups(); renderActionbar(); return;
  }
  if (t.closest('#rescanBtn')) {
    setBtnBusy(els.rescanBtn, true);
    try {
      await load(true);
      await loadTasks(true);
    } finally {
      setBtnBusy(els.rescanBtn, false);
    }
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
  // 抽屉开着时，Tab 只在抽屉里循环 —— 否则焦点会溜到背后的页面上，
  // 而屏幕上那层 scrim 让人看不见自己focus到哪了。
  if (e.key === 'Tab') {
    if (!els.drawer.hidden) { trapTab(e, els.drawer); return; }
    if (!tEls.drawer.hidden) { trapTab(e, tEls.drawer); return; }
  }

  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault(); els.search.focus(); els.search.select();
  }
  if (e.key === 'Escape') {
    if (!els.drawer.hidden) closeDrawer();
    else if (!tEls.drawer.hidden) closeTaskDrawer();
    else if (document.activeElement === els.search) {
      els.search.value = ''; state.q = ''; els.search.blur(); renderGroups();
    }
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

  /* tablist 的键盘模型：左右箭头在标签之间走，Home/End 到两头。
     走的同时就切换（这是"自动激活"模式，四个工具切换没有副作用，
     不需要用户再按一次回车确认）。roving tabindex 让 Tab 只停在
     当前选中的那一个上。 */
  if (e.target.matches?.('#appTabs [role="tab"]')) {
    const tabs = [...els.appTabs.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(e.target);
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (next) {
      e.preventDefault();
      const id = next.id;
      next.click();
      // 切换会重画整排标签，刚才那个元素已经不在文档里了 ——
      // 按 id 重新拿一次，否则焦点会掉到 body 上，键盘走到这里就断了。
      document.getElementById(id)?.focus();
    }
  }
});

window.addEventListener('resize', () => { hideTip(); renderSplit(); });

/* ════════════════════════════════════════════════════════════
   历史任务
   ════════════════════════════════════════════════════════════ */

const tEls = {
  warn: $('taskWarn'), lede: $('taskLede'), dbBar: $('dbBar'), comp: $('taskComp'),
  chips: $('taskChips'), search: $('taskSearch'), sort: $('taskSort'),
  pickAll: $('taskPickAll'), clearSel: $('taskClearSel'),
  list: $('taskList'), empty: $('taskEmpty'), foot: $('taskFoot'),
  tfCount: $('tfCount'), tfBytes: $('tfBytes'), purgeBtn: $('taskPurgeBtn'),
  scrim: $('tscrim'), drawer: $('tdrawer'), close: $('tdrawerClose'), cancel: $('tdrawerCancel'),
  stats: $('tdrawerStats'), note: $('tdrawerNote'), listD: $('tdrawerList'), countD: $('tdrawerCount'),
  dryWrap: $('tdryWrap'), dryList: $('tdryList'), dryBtn: $('tdryBtn'),
  confirmBox: $('tConfirmBox'), word: $('tWord'), msg: $('tdrawerMsg'), go: $('tdrawerGo'),
};

const taskState = {
  data: null, sel: new Set(), q: '', states: new Set(), sort: 'size', group: true,
  foldedWs: new Set(), open: new Set(),
  /* Cursor 专用：每会话的独占 blob 体积（删它能连带回收多少）。
     null = 还没算；{} = 算完了但没有数据。这个值要十几秒才出得来，
     所以是异步补上、并且只在 Cursor 下才有。 */
  exclusive: null,
};

/* Cursor 孤儿会话回灌。与上面的"清理"是两条完全不同的线：
   这里只新增行，不删任何东西；选中集合也单独放，避免和清理勾选串台。 */
const rEls = {
  panel: $('recoverPanel'), lede: $('recoverLede'), warn: $('recoverWarn'),
  list: $('recoverList'), foot: $('recoverFoot'), count: $('recoverCount'),
  bubbles: $('recoverBubbles'), pickAll: $('recoverPickAll'), clear: $('recoverClear'),
  btn: $('recoverBtn'), confirm: $('recoverConfirm'), note: $('recoverConfNote'),
  word: $('recoverWord'), wordHint: $('recoverWordHint'), go: $('recoverGo'),
  dry: $('recoverDry'), cancel: $('recoverCancel'), msg: $('recoverMsg'),
};
const recoverState = { data: null, sel: new Set(), open: false };

/* 可清理 = 后端给出了 reason。判定只在服务端做一次，前端照着用。
   各 app 给出的 reason 不完全一样（ZCode 有"界面已删除"，Codex 没有；Cursor 一个都不给）。 */
const isPurgeable = (t) => t.reason != null;

const REASON_LABEL = {
  deleted:     '已在界面删除',
  archived:    '已归档',
  wsMissing:   '工作区已丢失',
  untracked:   '界面不可见',
  bodyMissing: '正文已丢失',
  empty:       '空文件',
  /* Cursor 专属：会话本身正常，可清理是因为它按可达性分析删 —— 删一条活跃
     会话是自洽的，不留下任何悬空引用。别的工具没有这个档。 */
  manual:      '可手动清理',
};
const REASON_TONE = {
  deleted: 'st-serious', archived: 'st-warning', wsMissing: 'st-serious',
  untracked: 'st-serious', bodyMissing: 'st-serious', empty: 'st-serious',
  manual: 'st-warning',
};

const stateLabel = (t) => t.reason ? REASON_LABEL[t.reason] : STATE_META_CN[t.state];
const stateTone = (t) => t.reason ? REASON_TONE[t.reason] : STATE_TONE[t.state];

const STATE_TONE = { deleted: 'st-serious', archived: 'st-warning', active: 'st-good', untracked: 'st-warning', empty: 'st-serious' };

const shortPath = (p) => (p || '').replace(/^\/Users\/[^/]+/, '~');
const fmtDate = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 详情里给到分钟 —— 同一天里的两条会话，"最后使用"只写日期就分不开了。 */
const fmtDateTime = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${fmtDate(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 把会话面板擦回到"还没有任何数据"的样子。
 *
 * 切工具时数据是异步来的（Cursor 要读 364 MB 的库，约 3.5 秒），这中间
 * 标签已经高亮成新工具了，面板里却还可能挂着上一个工具的数字。这台工具
 * 的全部卖点就是"屏幕上的数字是真的"，所以这里必须一次擦干净 ——
 * 包括那几个平时只在新数据到达时才重画的元素（快捷项、构成条、筛选钮）。
 */
function resetTaskPanel() {
  tEls.warn.hidden = true;
  tEls.warn.innerHTML = '';
  tEls.comp.hidden = true;
  tEls.comp.innerHTML = '';
  tEls.foot.hidden = true;
  tEls.list.innerHTML = '';
  tEls.empty.hidden = true;
  tEls.dbBar.innerHTML = '';
  tEls.chips.innerHTML = '';
  tEls.lede.classList.remove('is-loading');
  tEls.dryWrap.hidden = true;

  // 首屏那条「历史会话」快捷线：没有数据就不该立着，更不该留着别人的句子
  els.taskQuick.hidden = true;
  els.tqFigure.textContent = '—';
  els.tqSub.innerHTML = '';
  els.taskQuickBtn.disabled = true;
  els.taskQuickBtn.textContent = '一键清理';
  els.taskQuickCap.innerHTML = '';
}

async function loadTasks(refresh = false) {
  const appId = state.appId;
  const view = state.index;
  taskState.data = null;
  taskState.sel.clear();
  taskState.states.clear();
  taskState.open.clear();
  resetTaskPanel();
  if (!view || !view.canRecover) hideRecoverable();

  // 全域模式没有"某一个工具"的会话面板：任务区直接说去看哪个工具
  if (!view) {
    hideRecoverable();
    tEls.lede.textContent = '总览模式下不读会话库 —— 切到具体工具后这里显示它的历史会话。';
    renderTaskFoot();
    renderTaskQuick();
    return;
  }

  if (!view.targets.some((t) => t.exists)) {
    hideRecoverable();
    tEls.lede.classList.remove('is-loading');
    tEls.lede.textContent = `${view.label} 在这台机器上没有数据目录。`;
    return;
  }
  tEls.lede.classList.add('is-loading');
  tEls.lede.textContent = `正在读取 ${view.label} 的会话记录…`;
  // 面板级别的忙碌态：内容区先不动（切工具时旧内容闪没会觉得点坏了），
  // 只在右上角转一个圈，数据到了整块换掉。
  setPanelBusy(true);
  try {
    const res = await fetch(`/api/tasks?app=${encodeURIComponent(appId)}` + (refresh ? '&refresh=1' : ''));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    // 换 app 换得快了，晚到的旧响应要丢掉
    if (state.appId !== appId || data.appId !== appId) return;
    taskState.data = data;
    renderTasks();
    // 有回灌写路径的工具另外有一条"界面看不到的会话"线，独立懒加载
    if (data.canRecover) loadRecoverable();
    // Cursor 的独占量要十几秒（整库内容寻址池解一遍），不挡首屏：
    // 先把列表画出来，算完再补上"删它能带走多少"。
    if (data.history === 'cursor-db') loadExclusive(appId);
  } catch (err) {
    if (state.appId !== appId) return;
    tEls.lede.classList.remove('is-loading');
    tEls.lede.innerHTML = `<b>读取失败：</b>${esc(err.message)}`;
  } finally {
    setPanelBusy(false);
  }
}

/** 面板角落的小转圈：不遮挡内容，只说明"这一块正在换数据"。
 *
 *  延迟 150ms 才亮 —— 切工具时多数请求是缓存命中、几毫秒就回来了，
 *  立刻转一下再立刻消失，看起来像闪了个错误，比不显示更糟。
 *  只有真的等了一会儿才值得提示。 */
let panelBusyTimer = 0;
function setPanelBusy(on) {
  const panel = document.getElementById('tasks');
  if (!panel) return;
  clearTimeout(panelBusyTimer);
  if (on) {
    panelBusyTimer = setTimeout(() => {
      panel.classList.add('is-busy');
      panel.setAttribute('aria-busy', 'true');
    }, 150);
  } else {
    panel.classList.remove('is-busy');
    panel.setAttribute('aria-busy', 'false');
  }
}

/* ── Cursor：每条会话能连带回收多少 ─────────────────────── */

/**
 * 取 Cursor 的"独占 blob"分析。
 *
 * 为什么是单独一次请求而不是塞进 /api/tasks：它要把整库的内容寻址池解一遍
 * （这台机器上约 15 秒）。塞进主请求会把整个面板拖住；单独拉的话，
 * 列表先出来，"删它能带走多少"稍后补上。
 *
 * 失败不影响主面板 —— 那只是让数字少一列，不是让页面坏掉。
 */
async function loadExclusive(appIdAtCall) {
  taskState.exclusive = null;
  try {
    const res = await fetch('/api/tasks/cursor/analyze');
    if (!res.ok) return;
    const data = await res.json();
    if (state.appId !== appIdAtCall) return;   // 切走了就丢掉
    const map = new Map();
    for (const s of data.sessions || []) map.set(s.id, s);
    taskState.exclusive = map;
    taskState.exclusiveMeta = { blobs: data.blobs, blobBytes: data.blobBytes, orphanBlobs: data.orphanBlobs };
    renderTaskList();
    renderTaskFoot();
  } catch {
    taskState.exclusive = null;
  }
}

/* ── Cursor：界面看不到的会话 ───────────────────────────── */

function hideRecoverable() {
  if (!rEls.panel) return;
  rEls.panel.hidden = true;
  rEls.list.innerHTML = '';
  rEls.warn.hidden = true;
  rEls.foot.hidden = true;
  rEls.confirm.hidden = true;
  recoverState.data = null;
  recoverState.sel.clear();
  recoverState.open = false;
}

async function loadRecoverable() {  // 晚到的旧响应要丢掉：切走之后能力位可能仍为真，只能比身份
  const appIdAtCall = state.appId;
  if (!state.index?.canRecover || !rEls.panel) { hideRecoverable(); return; }
  rEls.panel.hidden = false;
  rEls.lede.textContent = '正在找界面里看不到的会话…';
  rEls.list.innerHTML = '';
  rEls.warn.hidden = true;
  rEls.foot.hidden = true;
  rEls.confirm.hidden = true;
  rEls.msg.textContent = '';
  recoverState.open = false;

  try {
    const res = await fetch('/api/tasks/cursor/orphans');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (state.appId !== appIdAtCall) return;
    recoverState.data = data;
    // 上次勾了、这次已经回灌掉的会话不能继续留在选择集里
    const ids = new Set((data.sessions || []).map((s) => s.id));
    for (const id of [...recoverState.sel]) if (!ids.has(id)) recoverState.sel.delete(id);
    renderRecoverable();
  } catch (err) {
    if (state.appId !== appIdAtCall) return;
    recoverState.data = null;
    rEls.panel.hidden = false;
    rEls.lede.innerHTML = `<b>读取失败：</b>${esc(err.message)}`;
  }
}

function renderRecoverable() {
  const d = recoverState.data;
  if (!d) return;
  const sessions = d.sessions || [];
  const total = d.total || 0;

  rEls.lede.innerHTML = total
    ? `在 transcript 文件里找到 <b>${total}</b> 个会话，Cursor 的 <code>composerHeaders</code> 里没有对应记录 —— ` +
      `界面看不到它们，但 <b>${fmtBytes(d.orphanBytes)}</b> 的正文还在磁盘上。回灌会把正文补回客户端；` +
      `只新增、不覆盖，已存在的会话一律跳过。`
    : `没有发现孤儿会话：所有 transcript 都能在 Cursor 的会话头里找到。`;

  // 运行状态 / 读取问题
  const warns = [];
  if (d.app?.running) {
    warns.push(`<b>Cursor 正在运行</b>（${(d.app.hits || []).map((h) => `${esc(h.name)} ×${h.pids}`).join('、')}）。` +
      `回灌会写 <code>state.vscdb</code>，必须先<b>完全退出 Cursor</b>；现在可以浏览和空跑，写入会被拒绝。`);
  } else {
    warns.push(`Cursor 没在运行，可以安全回灌。动手前会把 <code>state.vscdb</code> 完整备份到 ` +
      `<code>${esc(shortPath(d.backupDir || 'backups'))}</code>。`);
  }
  for (const p of d.problems || []) warns.push(esc(p));
  if (warns.length) {
    rEls.warn.hidden = false;
    rEls.warn.className = d.app?.running ? 'app-warn' : 'app-warn is-ok';
    rEls.warn.innerHTML = `${icon(d.app?.running ? 'alert' : 'box')}<div>${warns.join('<br>')}</div>`;
  } else {
    rEls.warn.hidden = true;
  }

  rEls.list.innerHTML = sessions.map((s) => {
    const sel = recoverState.sel.has(s.id);
    const meta = [
      s.workspace,
      fmtDate(s.date),
      `${s.messages} 条消息`,
      s.tools ? `${s.tools} 次工具调用` : '',
      s.workspaceResolved ? '' : '路径未还原',
    ].filter(Boolean).join(' · ');
    return `<label class="recover-row ${sel ? 'is-on' : ''}" data-recover-row="${esc(s.id)}">
      <input type="checkbox" data-recover-id="${esc(s.id)}" ${sel ? 'checked' : ''}
        aria-label="选择会话 ${esc(s.title)}">
      <span class="recover-main">
        <span class="recover-title" title="${esc(s.title)}">${esc(s.title)}</span>
        <span class="recover-meta" title="${esc(meta)}">${esc(meta)}</span>
      </span>
      <span class="recover-size">${fmtBytes(s.bytes)}</span>
    </label>`;
  }).join('');

  const picked = sessions.filter((s) => recoverState.sel.has(s.id));
  rEls.foot.hidden = picked.length === 0;
  rEls.count.textContent = picked.length.toLocaleString();
  rEls.bubbles.textContent = picked.reduce((n, s) => n + s.bubbles, 0).toLocaleString();

  const running = Boolean(d.app?.running);
  rEls.confirm.hidden = !recoverState.open;
  if (recoverState.open) {
    rEls.wordHint.textContent = d.confirmWord || '回灌';
    rEls.go.disabled = running || picked.length === 0;
    rEls.note.innerHTML = running
      ? `Cursor 仍在运行，现在不能写入。请完全退出后刷新本页再试。`
      : `将新增 <b>${picked.length}</b> 条会话头、<b>${picked.reduce((n, s) => n + s.bubbles, 0)}</b> 条气泡，` +
        `不动任何已有会话。写入前会备份到 <code>${esc(shortPath(d.backupDir || 'backups'))}</code>。`;
  }
}

async function callRecover(dryRun) {
  const d = recoverState.data;
  const ids = [...recoverState.sel];
  if (!d || !ids.length) return;
  rEls.go.disabled = true;
  rEls.dry.disabled = true;
  rEls.msg.className = 'drawer-msg';
  rEls.msg.textContent = dryRun ? '正在空跑核对…' : '正在备份并写入 state.vscdb…';
  try {
    const res = await fetch('/api/tasks/cursor/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, dryRun, confirm: rEls.word.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    if (dryRun) {
      rEls.msg.className = 'drawer-msg is-ok';
      rEls.msg.innerHTML = `空跑：将回灌 <b>${data.imported}</b> 个会话、<b>${data.bubbles}</b> 条气泡。` +
        `没有写任何东西。`;
    } else {
      // 已回灌的会话从本地列表里移除，不用整页重扫
      const done = new Set((data.sessions || []).map((s) => s.id));
      if (d.sessions) d.sessions = d.sessions.filter((s) => !done.has(s.id));
      d.total = d.sessions?.length || 0;
      recoverState.sel.clear();
      rEls.word.value = '';
      rEls.msg.className = 'drawer-msg is-ok';
      rEls.msg.innerHTML = `已回灌 <b>${data.imported}</b> 个会话、<b>${data.bubbles}</b> 条气泡。` +
        (data.backup ? `备份在 <code>${esc(shortPath(data.backup))}</code>。` : '') +
        `重启 Cursor 后，它们会出现在会话列表里。`;
      renderRecoverable();
    }
  } catch (err) {
    rEls.msg.className = 'drawer-msg is-err';
    rEls.msg.textContent = err.message;
  } finally {
    rEls.go.disabled = false;
    rEls.dry.disabled = false;
  }
}

rEls.pickAll?.addEventListener('click', () => {
  for (const s of recoverState.data?.sessions || []) recoverState.sel.add(s.id);
  renderRecoverable();
});
rEls.clear?.addEventListener('click', () => {
  recoverState.sel.clear();
  renderRecoverable();
});
rEls.list?.addEventListener('change', (e) => {
  const box = e.target.closest('[data-recover-id]');
  if (!box) return;
  if (box.checked) recoverState.sel.add(box.dataset.recoverId);
  else recoverState.sel.delete(box.dataset.recoverId);
  renderRecoverable();
});
rEls.btn?.addEventListener('click', () => {
  recoverState.open = true;
  rEls.msg.textContent = '';
  renderRecoverable();
});
rEls.cancel?.addEventListener('click', () => {
  recoverState.open = false;
  rEls.msg.textContent = '';
  renderRecoverable();
});
rEls.dry?.addEventListener('click', () => callRecover(true));
rEls.go?.addEventListener('click', () => callRecover(false));

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

const fileBasedNote = (who) =>
  `${icon('doc')}<div>${esc(who)} 的会话正文就是 <code>projects/</code> 下的 <code>.jsonl</code> 文件本身，` +
  `没有数据库行可删。这里勾选后走<b>文件清理</b>那条线：默认进废纸篓，可随时恢复。</div>`;

function renderTasks() {
  const d = taskState.data;
  // 数据到了，加载中的呼吸点就该停 —— 不管下面走哪个分支。
  tEls.lede.classList.remove('is-loading');
  // 选中之后又变成活跃的（比如在应用里恢复了），不能留在清理范围里
  if (d) for (const id of [...taskState.sel]) {
    const t = d.tasks.find((x) => x.id === id);
    if (!t || !isPurgeable(t)) taskState.sel.delete(id);
  }
  if (!d || !d.tasks.length) {
    tEls.lede.textContent = d ? `没有读到任何 ${d.appLabel} 的历史会话。` : tEls.lede.textContent;
    tEls.list.innerHTML = '';
    tEls.comp.hidden = true;
    // 上一个 app 的警示条和体积柱得擦干净 —— 切到一个没有历史的工具，
    // 屏幕上不能还留着别人的数字。
    tEls.warn.hidden = true;
    tEls.warn.innerHTML = '';
    tEls.dbBar.innerHTML = '';
    tEls.chips.innerHTML = '';
    renderTaskFoot();
    renderTaskQuick();
    // Claude Code 这类"正文就是文件"的工具，就算一条会话没读到，也要说清楚
    // 为什么这里没有可勾的东西 —— 否则人会以为文件清单里那堆 .jsonl 失踪了。
    // 后端报的读取问题也要上屏："库打不开"与"库是空的"必须能分清。
    const notes = [];
    if (d?.fileBased) notes.push(fileBasedNote(d.appLabel));
    if (d?.problems?.length) {
      notes.push(`${icon('alert')}<div>${d.problems.map((p) => esc(p)).join('<br>')}</div>`);
    }
    if (notes.length) {
      tEls.warn.hidden = false;
      tEls.warn.className = d.problems?.length ? 'app-warn' : 'app-warn is-ok';
      tEls.warn.innerHTML = notes.join('<br>');
    }
    return;
  }
  const who = d.appLabel;

  const del = d.totals.byState.find((g) => g.state === 'deleted');
  const text = d.totals.bytes;

  // 正文不在会话库里的两处：Claude 的正文就是 .jsonl 文件本身；Codex 是索引库 + 磁盘上的
  // rollout。分开说，免得把 Codex 的"两段式"说法安到 Claude 头上。
  // 只读的只剩 Cursor，它的会话正文就在库里，按键族摊开。
  //
  // 标题来自库里每条会话的 name 字段（Cursor 自己起的名字）。有些会话它没起名，
  // 也没有改动摘要 —— 那几条只能显示 ID。这里主动交代一句，
  // 免得人以为是工具没读到标题、或者以为界面出了 bug。
  const untitledNote = d.untitled
    ? `其中 <b>${d.untitled}</b> 条 Cursor 没有生成标题（库里没有 name 也没有改动摘要），按 ID 显示。`
    : '';
  tEls.lede.innerHTML = d.readOnly
    ? `${esc(who)} 的会话库 <b>${fmtBytes(d.db.total)}</b>，读到 <b>${d.totals.count}</b> 个会话、` +
      `<b>${fmtBytes(text)}</b> 的正文。下面按键族摊开这 ${fmtBytes(d.db.total)} 到底是怎么分的。` +
      (untitledNote ? ` ${untitledNote}` : '')
    : d.fileBased
      ? `${esc(who)} 的会话正文就是 <b>${d.db.bodies?.count || 0}</b> 个 .jsonl 文件，` +
        `共 <b>${fmtBytes(d.db.bodies?.bytes || 0)}</b>；本机没有会话数据库 —— 清理走文件那条线。` +
        `读到 <b>${d.totals.count}</b> 个会话。`
      : d.db.bodies
        ? `${esc(who)} 的会话分两处存：索引库 <b>${fmtBytes(d.db.total)}</b>，` +
          `正文文件 <b>${fmtBytes(d.db.bodies.bytes)}</b>（<b>${d.db.bodies.count}</b> 个 rollout 文件）。` +
          `读到 <b>${d.totals.count}</b> 个会话。`
        : `会话库 <b>${fmtBytes(d.db.total)}</b>，装着 <b>${d.totals.count}</b> 个会话、` +
          `<b>${fmtBytes(text)}</b> 的正文。` +
          (del
            ? `其中 <b>${del.count}</b> 个已在界面上删除，仍占 <b>${fmtBytes(del.bytes)}</b>。`
            : '');

  // 动手之前的前提，三个 app 三种说法 —— 都从后端的能力标记来，不在前端猜
  tEls.warn.hidden = false;
  if (d.readOnly) {
    // 只读的理由由适配器给，前端不按 app 名硬编码。
    tEls.warn.className = 'app-warn';
    tEls.warn.innerHTML = `${icon('key')}<div><b>${esc(who)} 的会话只读</b>：${esc(d.readOnlyNote || '这个工具的会话数据不提供写路径。')}</div>`;
  } else if (d.fileBased) {
    tEls.warn.className = 'app-warn is-ok';
    tEls.warn.innerHTML = fileBasedNote(who);
  } else if (d.app.running) {
    tEls.warn.className = 'app-warn';
    tEls.warn.innerHTML =
      `${icon('alert')}<div><b>${esc(who)} 正在运行</b>（${d.app.hits.map((h) => `${esc(h.name)} ×${h.pids}`).join('、')}）。` +
      `清理需要往会话库里写数据，必须先<b>完全退出 ${esc(who)}</b>，否则可能损坏数据库。` +
      `下面可以正常浏览和勾选，只是删除按钮会被拒。</div>`;
  } else {
    tEls.warn.className = 'app-warn is-ok';
    tEls.warn.innerHTML = `${icon('box')}<div>${esc(who)} 没在运行，可以安全清理。动手前会自动把库完整备份到 <code>${esc(shortPath(d.backupDir))}</code>。</div>`;
  }

  // 读取问题（某个库打不开、文件缺失）后端一直在报，以前只有回灌面板显示 ——
  // 静默会让人以为"这里本来就是空的"。
  if (d.problems?.length) {
    tEls.warn.classList.remove('is-ok');
    tEls.warn.innerHTML += `<br>${d.problems.map((p) => esc(p)).join('<br>')}`;
  }

  renderDbBar();
  renderTaskChips();
  renderTaskList();
  renderTaskFoot();
  renderTaskQuick();
  renderComposition();
}

/** 这些体积花在哪：按任务状态等比切开，剩下的是索引与开销。 */
function renderDbBar() {
  const d = taskState.data;
  // ZCode / Cursor 的正文就在库里，分母就是库文件大小；Codex 的正文是磁盘上的 rollout
  // 文件，分母必须把库和文件加起来 —— 否则"活跃任务"那一根会画到 374% 宽。
  const bodies = d.db.bodies?.bytes || 0;
  // 分母是"库 + 库外正文"。没有库时（Claude 的正文全是 .jsonl）total 为 0，
  // 不能拿 1 去垫 —— 那会凭空多出一个 1 字节的"开销"段。
  const total = (d.db.total || 0) + bodies;
  const byState = d.totals.byState.map((g) => ({
    // 兜底：将来后端多一个状态桶而前端没跟上时，退化成可读的词，而不是 undefined
    label: STATE_META_CN[g.state] || g.state, bytes: g.bytes, tone: STATE_TONE[g.state] || '', key: g.state,
  }));
  // 余量按"每一段真正占了分母多少"来算，不能用 totals.bytes —— Codex 的分段里还叠了
  // 库中的条目体积，减错就会让整排色块加起来超过 100%。
  const used = byState.reduce((s, g) => s + g.bytes, 0);
  const segs = [
    ...byState,
    {
      label: bodies ? '索引库与其余开销' : '索引与其他开销',
      bytes: Math.max(0, total - used), tone: 'is-neutral', key: 'overhead',
      // 这一块是技术性的：库文件不只有正文。名字写在块上，解释挂在 tooltip 里，
      // 不占版面。
      tip: bodies
        ? '索引库文件里不属于任何会话正文的部分 —— thread_items 的索引、WAL、已释放的空页与页对齐。删掉会话后它才会跟着缩。'
        : '数据库文件里不属于任何任务正文的部分 —— 索引、已释放的空页、页对齐等。删掉任务后它才会跟着缩。',
    },
  ].filter((s) => s.bytes > 0);

  const W = 100;

  const pct = segs.map((s) => (total ? (s.bytes / total) * W : 0));
  const floors = pct.map(Math.floor);
  let rest = Math.round(W - floors.reduce((a, b) => a + b, 0));
  const order = pct.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) floors[order[k][1]] += 1;

  // 名称直接写进色块里，不再另起一行图例 —— 那一行把体积、状态又念了一遍，
  // 而下面那排筛选按钮本来就说的是同一件事。窄到写不下的块靠 tooltip 兜底。
  tEls.dbBar.innerHTML =
    `<div class="dbbar-track">` +
    segs.map((s, i) => {
      const cls = s.tone === 'is-neutral' ? 'is-neutral' : (STATUS_CLASS_TONE[s.tone] || '');
      /* 两种写法都渲进去，再按**量出来的**像素决定显示哪一版。
         之前按百分比当阈值（floors[i] > 14），同一个 21% 在宽屏是 200px、
         在窄栏只有 89px，于是「索引与其他开销 135.5 MB」被裁掉半截；
         换成估算像素也不够 —— 实测 100px 的文字放 106px 的段里仍溢出 2px。
         所以先全部渲染，量 scrollWidth 之后再把放不下的收起来。 */
      const full = `${s.label} ${fmtBytes(s.bytes)}`;
      return `<div class="dbbar-seg ${cls}" style="width:${floors[i]}%"
        data-tip="${esc(s.tip || `${s.label} · ${fmtBytes(s.bytes)}`)}">
        <span data-variant="full">${esc(full)}</span>
        <span data-variant="size" hidden>${fmtBytes(s.bytes)}</span>
      </div>`;
    }).join('') +
    `</div>`;

  /* 量完再收：全文放得下就留全文，否则退成只印体积，体积也放不下就留空
     （tooltip 里始终有完整信息）。屏上不会出现半截字。

     判断用**段自身的 scrollWidth**：span 是 block，它的 scrollWidth 只量到
     内容本身，而溢出还会来自内联盒的内边距/字距。实测「活跃会话 111.4 MB」
     的 span.scrollWidth 是 100、段宽 106，看着放得下，段自己的 scrollWidth
     却是 108 —— 差的那 2px 才是屏幕上被切掉的部分。 */
  for (const seg of tEls.dbBar.querySelectorAll('.dbbar-seg')) {
    const fullEl = seg.querySelector('[data-variant="full"]');
    const sizeEl = seg.querySelector('[data-variant="size"]');
    if (!fullEl || !sizeEl) continue;
    fullEl.hidden = false;
    sizeEl.hidden = true;
    if (seg.scrollWidth > seg.clientWidth) {
      fullEl.hidden = true;
      sizeEl.hidden = false;
      if (seg.scrollWidth > seg.clientWidth) sizeEl.hidden = true;
    }
  }
}

/** 库里到底装着什么 —— Cursor 只读，所以按键族摊开给你数清楚，而不是给个"不可清理"了事。 */
function renderComposition() {
  const d = taskState.data;
  if (!d || !d.composition) { tEls.comp.hidden = true; return; }
  const total = d.composition[0]?.bytes || 1;
  tEls.comp.hidden = false;
  tEls.comp.innerHTML =
    `<p class="tcomp-title">${esc(d.appLabel)} 库里装着什么</p>` +
    d.composition.map((c) => {
      const pct = total ? Math.round((c.bytes / total) * 100) : 0;
      return `<div class="tcomp-row${c.family === '' && c.table === 'kvTotal' ? ' is-total' : ''}">
        <span class="tcomp-label" title="${esc(c.table)}:${esc(c.family)}">${esc(c.label)}</span>
        <span class="tcomp-bar"><i style="width:${Math.max(1, pct)}%"></i></span>
        <span class="tcomp-n">${c.count == null ? '' : `${c.count.toLocaleString()} 行 · `}${fmtBytes(c.bytes)}</span>
      </div>`;
    }).join('');
}

const STATE_META_CN = {
  deleted: '已删除会话', archived: '已归档会话', active: '活跃会话',
  untracked: '界面不可见', empty: '空文件',
};
const STATUS_CLASS_TONE = { 'st-serious': 'st-serious', 'st-warning': 'st-warning', 'st-good': 'st-good', 'st-critical': 'st-critical' };

function renderTaskChips() {
  const d = taskState.data;
  // 体积写在上面那根条上，这里改说"几个任务" —— 换个数字，不把同一件事念两遍。
  // 标签与配色都带兜底：后端多一个状态桶时退化成可读的词，不画 undefined。
  tEls.chips.innerHTML = d.totals.byState.map((g) => {
    const label = STATE_META_CN[g.state] || g.state;
    return `<button type="button" class="chip ${STATE_TONE[g.state] || ''} ${taskState.states.has(g.state) ? 'is-on' : ''}"
      data-tstate="${g.state}" aria-pressed="${taskState.states.has(g.state)}"
      title="${esc(label)} ${g.count} 个 · ${fmtBytes(g.bytes)}">
      <i></i>${esc(label)} <em style="font-style:normal;opacity:.7">${g.count}</em>
    </button>`;
  }).join('');
}

function renderTaskList() {
  const list = visibleTasks();
  tEls.empty.hidden = list.length > 0;

  const rowHtml = (t) => {
    const sel = taskState.sel.has(t.id);
    const open = taskState.open.has(t.id);
    const meta = [
      taskState.group ? '' : shortPath(t.workspace),
      `${fmtDate(t.updatedAt)} 最后使用`,
      t.model ? t.model : '',
      t.children ? `${t.children} 子会话` : '',
      t.typeLabel,
    ].filter(Boolean).join(' · ');
    const body = t.bodyRel
      ? `<button class="btn btn-ghost btn-sm" type="button" data-locate="${esc(t.bodyRel)}">在文件清单中定位</button>`
      : '';
    /* Cursor 的行上多一个"连带"标记：这条会话除了自己的正文，还会带走
       多少只被它引用的工具结果 blob。没有这个数，人就不知道删这一条
       到底回收多少 —— 而这正是"光列出不能清理"的另一半。 */
    const ex = taskState.exclusive?.get(t.id);
    const exTag = ex && ex.exclusiveBytes > 0
      ? `<span class="row-tag" title="删除它会连带删掉 ${ex.exclusiveBlobs.toLocaleString()} 个只被它引用的工具结果 blob，共 ${ex.exclusiveBytes.toLocaleString()} 字节">连带 ${fmtBytes(ex.exclusiveBytes)}</span>`
      : '';
    return `<div class="tsession ${open ? 'is-open' : ''}">
      <div class="trow ${sel ? 'is-on' : ''}" data-task="${esc(t.id)}">
        <button class="trow-caret" type="button" data-task-toggle="${esc(t.id)}"
          aria-expanded="${open}" title="${open ? '收起' : '会话详情'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </button>
        <input type="checkbox" data-task-box="${esc(t.id)}" ${sel ? 'checked' : ''}
          ${isPurgeable(t) ? '' : 'disabled'} aria-label="选择会话 ${esc(t.title)}">
        <div class="trow-main">
          <span class="trow-title" title="${esc(t.title)}">${esc(t.title)}</span>
          <span class="trow-meta" title="${esc(t.workspace)}"><b class="trow-state-m">${esc(stateLabel(t))}</b>${esc(meta)}${exTag}</span>
        </div>
        <span class="trow-pill ${stateTone(t)}">${esc(stateLabel(t))}</span>
        <span class="trow-size">${fmtBytes(t.bytes)}</span>
      </div>
      ${open ? `<div class="tdetail" data-detail="${esc(t.id)}">
        <dl class="tdetail-grid">
          <div><dt>最后使用</dt><dd>${fmtDateTime(t.updatedAt)}</dd></div>
          <div><dt>创建</dt><dd>${fmtDateTime(t.createdAt)}</dd></div>
          <div><dt>文件夹</dt><dd title="${esc(t.workspace)}"><code>${esc(shortPath(t.workspace) || '—')}</code></dd></div>
          <div><dt>模型</dt><dd>${esc(t.model || '—')}</dd></div>
          <div class="tspan"><dt>会话 ID</dt><dd><code>${esc(t.id)}</code></dd></div>
          <div class="tspan"><dt>正文</dt><dd title="${esc(t.bodyRel || '')}"><code>${esc(t.bodyRel || '库内存储')}</code></dd></div>
        </dl>
        <div class="tdetail-acts">
          <button class="btn btn-ghost btn-sm" type="button" data-copy-id="${esc(t.id)}">复制会话 ID</button>
          ${body}
        </div>
      </div>` : ''}
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
    const named = g.ws === '(未知工作区)';
    const base = named ? g.ws : (g.ws.split('/').filter(Boolean).pop() || g.ws);
    return `<section class="tgroup ${folded ? 'is-folded' : ''}" data-ws="${esc(g.ws)}">
      <header class="tgroup-head" data-ws-toggle="${esc(g.ws)}" role="button" tabindex="0"
        aria-expanded="${!folded}" title="${esc(g.ws)}">
        <svg class="tgroup-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        <span class="tgroup-name">
          <b>${esc(base)}</b>
          <code>${esc(shortPath(g.ws))}</code>
        </span>
        <span class="tgroup-n">${g.tasks.length} 个会话${selN ? ` · 已选 ${selN}` : ''}</span>
        <span class="tgroup-size">${fmtBytes(g.bytes)}</span>
      </header>
      ${folded ? '' : `<div class="tgroup-body">${g.tasks.map(rowHtml).join('')}</div>`}
    </section>`;
  }).join('');
}

/** 从会话详情跳到文件清单：定位正文文件并让搜索框带着它。 */
function locateBody(rel) {
  const hit = state.index.files.find((f) => f.p === rel || f.p.endsWith('/' + rel));
  const q = hit ? hit.p : rel;
  state.q = q.toLowerCase();
  els.search.value = q;
  renderGroups();
  document.getElementById('files').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function taskSelTotals() {
  const d = taskState.data;
  if (!d) return { count: 0, bytes: 0, children: 0, rows: 0 };
  const picked = d.tasks.filter((t) => taskState.sel.has(t.id));
  return {
    count: picked.length,
    bytes: picked.reduce((s, t) => s + t.bytes, 0),
    children: picked.reduce((s, t) => s + t.children, 0),
    // Codex 没有子会话这一层，能说的是库里有多少条投影条目
    rows: picked.reduce((s, t) => s + (t.rows || 0), 0),
    picked,
  };
}

function renderTaskFoot() {
  const d = taskState.data;
  const { count, bytes } = taskSelTotals();
  // 只读的 app 连"清理"这个入口都不摆 —— 摆了也是必然被拒的按钮
  tEls.foot.hidden = !d || d.readOnly || count === 0;
  tEls.tfCount.textContent = count.toLocaleString();
  tEls.tfBytes.textContent = fmtBytes(bytes);
  tEls.purgeBtn.textContent = d?.fileBased ? '按文件清理…' : '清理…';

  // 这个按钮永远可点 —— 它只是打开抽屉。空跑核对是只读的，应用开着也安全，
  // 拦住用户看清单没有任何好处。真正被拦的是抽屉里那个「删除」。
  const running = d?.app?.running;
  tEls.purgeBtn.title = d?.fileBased
    ? `把这 ${count} 个会话的正文文件交给文件清理：默认移入废纸篓`
    : running
      ? `${d?.appLabel || '应用'} 正在运行：可以先空跑核对，但要完全退出它才能删除`
      : `清理这 ${count} 个会话；动手前会自动备份`;
}

/* ── 首屏的会话快捷项 ───────────────────────────────────── */

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
    `${esc(d.appLabel)} 界面上你删过的 <b>${del.count}</b> 个会话。它的"删除"只是打个标记 —— ` +
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
    `勾选 ${s.tasks.length} 个会话并摊开确认清单，<b>不会立刻删除</b>。` +
    (skips.length ? `<span class="rec-off">已跳过 ${skips.join('、')}。</span>` : '');
}

/* ── 会话清理抽屉 ───────────────────────────────────────── */

/**
 * 打开清理确认。正文本身就是文件的会话（Claude Code 的全部、Codex 的残骸）没有"行"可删，
 * 把勾选换成文件、交给文件那条清理线；其余的走按行删除的抽屉。
 */
function openTaskAction() {
  const d = taskState.data;
  if (!d || d.readOnly) return;
  const picked = d.tasks.filter((t) => taskState.sel.has(t.id));
  if (!picked.length) return;
  const residual = picked.filter((t) => t.residual);
  if (d.fileBased || residual.length === picked.length) return openTaskAsFiles();
  if (residual.length) {
    tEls.warn.className = 'app-warn';
    tEls.warn.innerHTML = `${icon('alert')}<div>这一批里混了 <b>${residual.length}</b> 个只剩文件的残骸` +
      `（${fmtBytes(residual.reduce((s, t) => s + t.bytes, 0))}）。它们索引里已经没有行，` +
      `按行删除碰不到 —— 请单独勾选它们走文件清理，或先把它们从这批里取消。</div>`;
    return;
  }
  openTaskDrawer();
}

function openTaskAsFiles() {
  const rootKey = state.index.targets[0].key;
  const byRel = new Map(state.index.files.filter((f) => f.t === rootKey).map((f) => [f.p, f]));
  state.selection.clear();
  for (const x of taskState.data.tasks.filter((t) => taskState.sel.has(t.id))) {
    const f = byRel.get(x.bodyRel);
    // 会话正文正常都是普通文件；万一它被换成了软链接，同样不能选 ——
    // 否则这一批又会被服务端整批拒绝。
    if (f && canPick(f)) state.selection.add(keyOf(f));
  }
  if (!state.selection.size) {
    tEls.warn.className = 'app-warn';
    tEls.warn.innerHTML = `${icon('alert')}<div>勾上的会话在文件清单里找不到对应正文 —— 目录大概在这期间变了。请点「重新扫描」再来一次。</div>`;
    return;
  }
  renderGroups(); renderActionbar(); renderSplit();
  openDrawer();
}

function openTaskDrawer() {
  const { count, bytes, children, rows, picked } = taskSelTotals();
  if (!count) return;
  const d = taskState.data;
  const who = d.appLabel;

  tEls.stats.innerHTML = d.db?.bodies
    ? `<div class="dstat"><span>会话</span><b>${count.toLocaleString()}</b></div>
       <div class="dstat"><span>库里的条目</span><b>${rows.toLocaleString()}</b></div>
       <div class="dstat"><span>正文文件合计</span><b>${fmtBytes(bytes)}</b></div>`
    : `<div class="dstat"><span>会话</span><b>${count.toLocaleString()}</b></div>
       <div class="dstat"><span>正文合计</span><b>${fmtBytes(bytes)}</b></div>`;

  // 会写到哪几个库，由后端报的路径决定 —— 各工具不一样，前端不硬编码文件名
  const dbFiles = d.db.dbs.map((x) => shortPath(x.path));
  const dbsTxt = dbFiles.map((p) => `<code>${esc(p)}</code>`).join(' 和 ');
  const backupTxt = `动手前会把库完整备份到 <code>${esc(shortPath(d.backupDir))}</code>。`;

  /* Cursor 的说明与别家不同，两点：
     ① 它只写 state.vscdb —— conversation-search.db 是搜索索引，这里不碰。
        把两个库都写成"会从里面移除"，是在暗示一件不会发生的事。
     ② 回收量有一大半来自"连带删掉的工具结果 blob"，那不是这条会话名下的行，
        不说清楚数字会显得虚高。 */
  const cursorDbs = d.db.dbs.filter((x) => x.role !== 'index');
  const cursorDbsTxt = cursorDbs.map((x) => `<code>${esc(shortPath(x.path))}</code>`).join(' 和 ');
  const cursorTxt = (() => {
    let exB = 0, exN = 0;
    if (taskState.exclusive) {
      for (const t of picked) {
        const e = taskState.exclusive.get(t.id);
        if (e) { exB += e.exclusiveBytes; exN += e.exclusiveBlobs; }
      }
    }
    return exB > 0
      ? `另外，这些会话还独占着 <b>${exN.toLocaleString()}</b> 个工具结果 blob（共 <b>${fmtBytes(exB)}</b>）—— ` +
        `只被它们引用的会一起删掉；仍被其它会话引用的会保留。`
      : `另：只被这些会话引用的工具结果 blob 会一起删掉，共享的保留。`;
  })();

  tEls.note.innerHTML = d.app.running
    ? `<b>${esc(who)} 仍在运行</b>，现在不能删除。请完全退出 ${esc(who)} 后重新打开本页。`
    : d.history === 'cursor-db'
      ? `删除会把这些会话的行从 ${cursorDbsTxt} 里彻底移除，` +
        `随后 <code>VACUUM</code> 重建数据库把空间真正交还给磁盘。${backupTxt}${cursorTxt}`
      : `删除会把这些会话的行从 ${dbsTxt} 里彻底移除，` +
        `随后 <code>VACUUM</code> 重建数据库把空间真正交还给磁盘。${backupTxt}` +
        // Codex 的正文是磁盘上的 rollout 文件，行级删除碰不到它 —— 不说清楚，
        // 用户会以为回收的数字偏小是工具没干活。
        (d.db.bodies
          ? `但 <b>Codex 的正文不在这些库里</b>：它存在 <code>sessions/</code> 的 rollout 文件里，` +
            `这里只抹索引行。文件要等索引里再也没有它们，才会变成孤儿、归「文件清单」那条线清理。`
          : `<b>正文合计只是下限</b> —— 实际回收通常更多，因为索引也会一起收缩。`);

  const sorted = picked.slice().sort((a, b) => b.bytes - a.bytes);
  tEls.listD.innerHTML = sorted.slice(0, 200).map((t) =>
    `<li title="${esc(t.title)}"><span>${esc(t.appLabel)} · ${esc(t.title)}</span><span>${fmtBytes(t.bytes)}</span></li>`).join('')
    + (sorted.length > 200 ? `<li><span>…还有 ${(sorted.length - 200).toLocaleString()} 个</span><span></span></li>` : '');
  tEls.countD.textContent = `${count.toLocaleString()} 个`;

  tEls.dryWrap.hidden = true;
  tEls.word.value = '';
  tEls.confirmBox.hidden = false;
  tEls.msg.textContent = '';
  tEls.msg.className = 'drawer-msg';
  tEls.go.disabled = false;
  tEls.go.textContent = '删除';
  tEls.dryBtn.disabled = false;

  tEls.scrim.hidden = false;
  tEls.drawer.hidden = false;
  openModal(tEls.drawer);
}

const closeTaskDrawer = () => {
  tEls.scrim.hidden = true;
  tEls.drawer.hidden = true;
  closeModal();
};

/** 删除后的一致性检查：ZCode 一个库给一个结论，Codex 逐库给一组 —— 都说成人能读的一行。 */
function checkLine(data) {
  /* Cursor 报的是悬空引用，不是外键违规 —— 它没有外键，那套概念在这里不成立。
     写"外键违规 undefined"是在用别人的术语描述这个库。 */
  if (data.dangling !== undefined) {
    return `完整性 ${data.integrity}，悬空引用 ${data.dangling} 处。`;
  }
  if (!Array.isArray(data.integrity)) {
    return `完整性 ${data.integrity}，外键违规 ${data.fkViolations}。`;
  }
  const bad = data.integrity.filter((r) => r.integrity !== 'ok' || r.fkViolations);
  if (!bad.length) return `${data.integrity.length} 个库完整性全部 ok，外键违规 0。`;
  return data.integrity.map((r) => `${r.name} ${r.integrity}/违规 ${r.fkViolations}`).join('，') + '。';
}

/**
 * 执行删除（或空跑）。一条请求过完服务端的四道闸：
 * 进程探测 → 备份 → 事务+外键 → VACUUM+自检。被拒时服务端说清卡在哪一步。
 */
async function callPurge(dryRun) {
  const d = taskState.data;
  const ids = [...taskState.sel];
  if (!d || !ids.length) return;

  tEls.go.disabled = true;
  tEls.dryBtn.disabled = true;
  tEls.msg.className = 'drawer-msg';
  tEls.msg.textContent = dryRun ? '正在空跑核对…' : '正在备份、删除并重建数据库…可能要几十秒';
  if (!dryRun) tEls.go.textContent = '处理中…';

  try {
    const res = await fetch('/api/tasks/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dryRun
        ? { app: state.appId, ids, dryRun: true }
        : { app: state.appId, ids, confirm: tEls.word.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (dryRun) renderDryRun(data);
    else await finishPurge(data);
  } catch (err) {
    tEls.msg.className = 'drawer-msg is-err';
    tEls.msg.textContent = err.message;
  } finally {
    tEls.go.disabled = false;
    tEls.dryBtn.disabled = false;
    tEls.go.textContent = '删除';
  }
}

/** 空跑：逐库逐表摊开会删掉的行，数据库没有任何改动。 */
function renderDryRun(data) {
  /* 两种形状：ZCode/Codex 报的是"逐库逐表会删多少行"（perDb）；
     Cursor 没有外键表，它报的是"会话行 + 连带 blob"。分开渲染，
     不要硬把 Cursor 塞成 perDb —— 那会造出一个不存在的表名。 */
  const rows = Array.isArray(data.perDb)
    ? data.perDb.map((x) => [`${x.table}（${x.name}）`, x.count ?? 0])
    : [
        ['会话条目（cursorDiskKV）', data.sessionRows ?? 0],
        ['会话头（composerHeaders）', data.sessions ?? 0],
        ['连带删除的工具结果 blob', data.blobs ?? 0],
      ];
  const totalRows = Array.isArray(data.perDb) ? rows.reduce((s, [, c]) => s + c, 0) : (data.sessionRows ?? 0);
  const bodies = data.bodyBytes
    ? `<br>另有 <b>${fmtBytes(data.bodyBytes)}</b> 正文在 rollout 文件里 —— 这里只删索引行，正文要等它们变成孤儿后走文件清理。`
    : data.blobBytes
      ? `<br>可回收 <b>${fmtBytes((data.sessionBytes || 0) + (data.blobBytes || 0))}</b>：` +
        `会话正文 <b>${fmtBytes(data.sessionBytes || 0)}</b> + 只被它们引用的 blob <b>${fmtBytes(data.blobBytes)}</b>。`
      : '';
  tEls.dryList.innerHTML = rows
    .map(([k, c]) => `<li><span>${esc(k)}</span><span>${c.toLocaleString()}</span></li>`).join('');
  tEls.dryWrap.hidden = false;
  tEls.msg.className = 'drawer-msg is-ok';
  tEls.msg.innerHTML =
    `空跑完成：共 <b>${totalRows.toLocaleString()}</b> 行，数据库没有任何改动。${bodies}` +
    `确认无误后输入「清理」再删除。`;
}

/** 删除完成：报回收量与自检结论，然后刷新会话与文件两边的视图。 */
async function finishPurge(data) {
  /* 跟文件删除那条线同一条规矩：动作完成就关抽屉，结果交给 toast。
     这里原本要等 3 秒 —— 而 VACUUM 那一步人已经等过几十秒了，
     再干等三秒纯粹是让人对着一个已经没事可做的面板。 */
  closeTaskDrawer();
  showToast(
    `完成，回收 ${bytesWithExact(data.freed)}：` +
    `${bytesWithExact(data.before.total)} → ${bytesWithExact(data.after.total)}。` +
    `${esc(checkLine(data))}备份已经写好。`);
  // 两边的重扫都放到后台：库变小了，文件清单也要跟上
  try {
    await loadTasks(true);
    await load(true);
    renderTasks();
  } catch (err) {
    showToast(`刷新视图失败：${esc(err.message)}（删除本身已经完成）`, { error: true });
  }
}

/* 会话面板事件 */
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

  // 会话详情：展开 / 收起。放在行处理之前 —— 点开三角不该顺手把会话勾上。
  const tgl = t.closest('[data-task-toggle]');
  if (tgl) {
    const id = tgl.dataset.taskToggle;
    taskState.open.has(id) ? taskState.open.delete(id) : taskState.open.add(id);
    renderTaskList();
    return;
  }

  const copy = t.closest('[data-copy-id]');
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copyId).then(() => {
      copy.textContent = '已复制';
      setTimeout(() => { copy.textContent = '复制会话 ID'; }, 1200);
    }).catch(() => {});
    return;
  }

  const locate = t.closest('[data-locate]');
  if (locate) { locateBody(locate.dataset.locate); return; }

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
    openTaskAction();
    return;
  }
  if (t.closest('#taskPurgeBtn')) { openTaskAction(); return; }
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
  // 失败时也要把忙碌态收掉 —— 否则顶栏那条线会一直跑，看起来像永远没扫完
  dropSkeleton();
  setBusy(false);
  setPanelBusy(false);
  setBtnBusy(els.rescanBtn, false);
});
