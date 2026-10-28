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
  rec: $('rec'),
  recName: $('recName'), recBtn: $('recBtn'), recScope: $('recScope'),
  recFigure: $('recFigure'), recSub: $('recSub'),
  taskQuick: $('taskQuick'), tqFigure: $('tqFigure'), tqSub: $('tqSub'),
  taskQuickBtn: $('taskQuickBtn'),
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
  allView: $('allView'), allLede: $('allLede'), allTools: $('allTools'),
  allChips: $('allChips'), allList: $('allList'), allEmpty: $('allEmpty'), allSearch: $('allSearch'),
  auditView: $('auditView'), auditLede: $('auditLede'), auditTools: $('auditTools'),
  auditList: $('auditList'), auditEmpty: $('auditEmpty'),
};

let viewEpoch = 0;
let scanRequest = 0;
let taskRequest = 0;
let allRequest = 0;
let operationBusy = false;

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
/* 视图层：转义、图标、徽标、状态字典、行/卡片模板。
   这一层不碰 DOM、不读全局 state，测试能直接喂夹具断言产出的 HTML。 */
import {
  esc, icon, navIcon, STATUS_CLASS, STATUS_LABEL,
  shortPath, bytesTip, bytesB, bytesWithExact, confirmWordHint,
} from './views/shared.js';
import {
  rowHtml as fileRowHtml, groupCard, emptyHintHtml,
  splitBlockHtml, drawerStatsHtml, drawerMixHtml, drawerListHtml, recChipsHtml,
} from './views/files.js';
import {
  groupSessions, sessionGroup, allLedeHtml, toolFilterChip, DEFAULT_OPEN_GROUPS,
} from './views/all.js';
/* 点击动作的状态变更逻辑（纯函数，有单测）。渲染与副作用仍在这里。 */
import {
  toggleSplitGroup, selectAllVisible, clearSelection, selectRecommended,
  toggleGroupBox, toggleRow, toggleStatus, toggleExplain,
  toggleCategory, toggleRecommendItem, toggleAllGroup, toggleToolFilter, nextTheme,
} from './actions.js';
/* 会话面板的模板与派生：状态文案、行/分组模板、清理数字（纯函数，有契约测试）。
   渲染与副作用留在这里 —— 编排层只决定"往哪个元素画什么"。 */
import {
  isPurgeable, STATE_TONE, STATE_META_CN, STATUS_CLASS_TONE,
  taskSelTotals, taskQuickSet, visibleTasks, groupTasksByWorkspace,
  dbBarSegments, taskRowHtml, taskGroupHtml, recoverRowHtml, dryRunHtml, checkLine,
  taskLedeHtml, taskWarnHtml, taskEmptyWarnHtml, taskQuickTexts,
  taskDrawerStatsHtml, taskDrawerNoteHtml, taskDrawerListHtml,
} from './views/tasks.js';
/* 安全审计视图的模板与汇总（纯函数，有契约测试）。 */
import {
  auditSummary, auditLedeHtml, auditToolHtml, auditHitGroups, auditGroupHtml,
} from './views/audit.js';

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

/**
 * 一批推荐分类的"可清"合计。
 *
 * 不能直接用分类的 bytes/count —— 那是分类里**所有**文件的体积，而软链接
 * 与受保护项一个也删不掉。实测 Codex 的推荐范围（缓存 71 B + 临时目录 46 B）
 * 三个文件全是软链接：按钮写着"推荐清理 117 B"，按下去却什么都不发生，
 * 因为选区是空的。按钮上的数字必须等于按下去会发生的事。
 */
const sumCats = (cats) => {
  let bytes = 0, count = 0, blocked = 0, blockedBytes = 0;
  for (const c of cats) {
    const all = filesOf(c.id);
    const pick = selectableOnly(all, c);
    bytes += pick.reduce((s, f) => s + f.s, 0);
    count += pick.length;
    const rest = all.length - pick.length;
    if (rest > 0) {
      blocked += rest;
      blockedBytes += all.reduce((s, f) => s + f.s, 0) - pick.reduce((s, f) => s + f.s, 0);
    }
  }
  return { cats, bytes, count, blocked, blockedBytes };
};

const REC_KEY = 'zci-rec-off';   // 每个 app 各记一份：分类表本来就不共用

function recStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(REC_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function loadRecOff() {
  // 只认得当前这个 app 存在的分类；存着的 id 里不属于它的直接丢掉
  const ids = recStore()[state.appId];
  if (Array.isArray(ids)) {
    const known = new Set(recommendAll().map((c) => c.id));
    const kept = ids.filter((id) => known.has(id));
    return new Set(kept);
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
  const request = ++scanRequest;
  setBusy(true);
  els.scanNote.textContent = refresh ? '重新扫描中…' : '扫描中…';
  try {
    const res = await fetch('/api/scan' + (refresh ? '?refresh=1' : ''));
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const data = await res.json();
    if (request !== scanRequest) return;
    state.scan = data;
    if (refresh) { allState.data = null; auditState.data = null; }
    state.apps = state.scan.apps;
    // 每行在数据入手的这一刻就带上归属与稳定 key。之前靠 files.includes()
    // 反查 —— 抽屉里 3352 行 × 1.8 万文件是千万级比较，而这里一次写入零成本。
    indexRows();
    if (!isAll() && !isAudit() && !state.apps.some((a) => a.app === state.appId)) state.appId = pickApp();
    applyApp();
  } finally {
    if (request === scanRequest) { dropSkeleton(); setBusy(false); }
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
    if (last === ALL_ID || last === AUDIT_ID) return last;
    if (last) {
      const hit = sorted.find((a) => a.app === last && a.totals.files > 0);
      if (hit) return hit.app;
    }
  } catch {}
  return (sorted.find((a) => a.totals.files > 0) || sorted[0])?.app || null;
}

/** 把渲染层切到当前 app 的那一份视图。 */
function applyApp() {
  viewEpoch++;
  allState.loading = false;
  auditState.loading = false;
  setPanelBusy(false);
  // 「全部」与「安全审计」是长只读列表，走文档流滚动；单工具视图走
  // 100vh 框架（面板不出屏、列表在面板里滚）。CSS 看 body.mode-flow 分档。
  document.body.classList.toggle('mode-flow', isAll() || isAudit());
  state.index = isAll() ? null : (state.apps.find((a) => a.app === state.appId) || null);
  state.selection.clear();
  // 换 app，筛选也从头开始。搜索词与状态筛选同样是"这一屏的读法"，
  // 留着上一个工具的词会让新工具一进来就是空白（Cursor 里搜不到
  // ZCode 那些 sess_ 路径），看起来像工具坏了。
  state.group = null;
  state.q = '';
  state.statuses.clear();
  els.search.value = '';
  state.recReady = false;
  if (isAll()) {
    /* 「全部」不扫文件树，也不做清理 —— 它只回答"我刚才在哪个工具里干活"。
       所以文件清单、推荐清理、诊断这些块整块收起，只留会话一览。
       收起而不是"显示空的"：一块说自己 0 B 的卡片，比不出现更让人困惑。 */
    state.byCat = new Map();
    try { localStorage.setItem(APP_KEY, ALL_ID); } catch {}
    els.rootPath.textContent = '各工具的会话';
    els.scanNote.textContent = `扫描用时 ${(state.scan.durationMs / 1000).toFixed(1)}s`;
    /* 上面那句 selection.clear() 只清了数据，操作条是上一次渲染留下的 DOM ——
       不清它，从某个工具带着勾选切过来，「全部」这一屏底部会挂着
       "1 项，99 KB / 清理…"。而这一屏根本没有文件清单，那个按钮点下去
       什么也删不掉。这一屏是只读的，操作条就不该存在。 */
    renderActionbar();
    renderTaskFoot();
    renderAppTabs();
    renderAllAll();
    flashSwitch();
    return;
  }

  if (isAudit()) {
    /* 安全审计与「全部」同性质：跨工具、只读、没有清理动作。
       除了收起常规几块，还要把「全部」也收走 —— 两个特殊视图互斥。 */
    state.byCat = new Map();
    try { localStorage.setItem(APP_KEY, AUDIT_ID); } catch {}
    els.rootPath.textContent = '会话正文的安全审计';
    els.scanNote.textContent = `扫描用时 ${(state.scan.durationMs / 1000).toFixed(1)}s`;
    renderActionbar();
    renderTaskFoot();
    renderAppTabs();
    renderAuditAll();
    flashSwitch();
    return;
  }

  // 从「全部」切回来：把常规那几块放出来，并把会话一览收走
  hideAllView();

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

/** 切主题时"全局停过渡"那个类，靠这个定时器摘掉（见 themeBtn 的处理）。 */
let themeSwitchTimer = 0;

/** 「全部」不是一个 app，是一个跨工具的只读视图。 */
const ALL_ID = 'all';
const isAll = () => state.appId === ALL_ID;

/** 「安全审计」同上：跨工具、只读，但它连清理入口都没有 —— 它回答的是
 *  "凭据有没有漏出去过"，不是"哪些能删"。排在标签行末尾，跟在五个工具后面，
 *  与「全部」一左一右把工具夹在中间。 */
const AUDIT_ID = 'audit';
const isAudit = () => state.appId === AUDIT_ID;

function renderAppTabs() {  /* 导航从顶栏搬到左侧栏（理由见 style.css 里那段：七个标签横排要 780px，
     1280 视口下「安全审计」被推出可视区）。竖排之后每个工具是一整行，
     加工具只是多一行，不会再挤。

     结构：三个跨工具视图里，「全部」在最上，「安全审计」单独用一条细线
     隔在最下 —— 它们回答的是"跨工具"的问题，与中间那几个"某个工具的
     落盘"不是一类。顺序上「全部」在前是因为它最常用。 */

  /* roving tabindex：整列只占一个 Tab 位，进了组之后用上下箭头换。
     七个都 tabindex=0 的话，键盘用户每过一个工具就得按一次 Tab。 */
  const tab = ({ id, label, on, dot, cls, title }) => `<button type="button"
      class="app-tab ${cls} ${on ? 'is-on' : ''}"
      role="tab" id="apptab-${id}" aria-selected="${on}" tabindex="${on ? '0' : '-1'}"
      aria-controls="single" data-app="${esc(id)}" data-app-tone="${esc(id)}"
      title="${esc(title)}">
      ${dot ? navIcon(id) : ''}
      <span class="app-tab-name">${esc(label)}</span>
    </button>`;

  const allTab = tab({
    id: ALL_ID, label: '全部', on: isAll(), cls: 'app-tab--meta',
    dot: true, title: '各工具的会话合成一张表，按最近使用排序（只读：要删请点进对应工具）',
  });

  const appTabs = sortedApps().map((a) => {
    const on = a.app === state.appId;
    const empty = a.totals.files === 0;
    return tab({
      id: a.app, label: a.label, on, dot: true,
      cls: empty ? 'is-empty' : '',
      // 体积与文件数进 title：写在行里会让各行的名字对不齐
      title: `${a.targets.map((t) => `${t.short}${t.exists ? '' : '（没有）'}`).join('、')}，`
        + (empty ? '未安装' : `${fmtBytes(a.totals.bytes)}，${a.totals.files.toLocaleString()} 个文件`),
    });
  }).join('');

  const auditTab = tab({
    id: AUDIT_ID, label: '安全审计', on: isAudit(), cls: 'app-tab--meta',
    dot: true, title: '扫描各工具会话正文里的凭据外泄模式（只读，证据脱敏）',
  });

  els.appTabs.innerHTML = allTab
    + '<div class="app-tab-sep" role="presentation"></div>'
    + appTabs
    + '<div class="app-tab-sep" role="presentation"></div>'
    + auditTab;

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
  els.heroBytes.title = bytesTip(t.bytes);

  const runaway = state.index.categories.filter((c) => c.id === 'runaway');
  const runawayBytes = runaway.reduce((s, c) => s + c.bytes, 0);
  const runawayCount = runaway.reduce((s, c) => s + c.count, 0);

  // 总量下面只说一件事：这里面有多少是失控日志。其余的分档数字交给下面的筛选条，
  // 不在这里重复一遍。
  const shape = `${esc(state.index.label)} 共 <b>${t.files.toLocaleString()}</b> 个文件、<b>${t.dirs.toLocaleString()}</b> 个目录。`;
  /* 只说总量，不再逐家列一遍 —— 顶部那排标签上每家已经写着自己的体积，
     在这里重复会让这句折成三行，把总览卡撑高一截（实测 1280 宽下多出 45px）。
     想看"哪家占得多"抬头看标签，比在这里读一串逗号分隔的名字快。 */
  const others = state.apps.filter((a) => a.app !== state.appId && a.totals.bytes > 0);
  const grand = others.length
    ? `这台机器上 ${state.apps.length} 个工具合计 ${bytesB(state.scan.grand.bytes)}。`
    : '';
  els.heroSub.innerHTML = runawayBytes > 0
    ? shape + `其中 ${bytesB(runawayBytes)} 来自 <b>${runawayCount}</b> 个失控放大的日志，` +
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

  /* 空态要说清是**哪个条件**筛空的 —— 文案本体在 views/files.js（可单测），
     这里只把这一屏的状态递过去。 */
  els.emptyHint.hidden = cats.length > 0;
  if (!cats.length) {
    els.emptyHint.innerHTML = emptyHintHtml({
      q: state.q, statuses: state.statuses, group: state.group,
    }).html;
  }

  els.groups.innerHTML = cats.map(({ cat, files }) => groupCard({
    cat,
    files: sortFiles(files),
    totalHere: filesOf(cat.id).length,
    isOpen: state.open.has(cat.id),
    explain: state.explain.has(cat.id),
    selCount: selectableOnly(sortFiles(files), cat).filter((f) => state.selection.has(keyOf(f))).length,
    pickable: selectableOnly(sortFiles(files), cat).length,
    rowCtx: { selection: state.selection, multiTarget: multiTarget(), canReveal: canReveal(), targets: state.index.targets || [], appLabel: state.index.label },
  })).join('');

  els.groups.querySelectorAll('[data-indeterminate]').forEach((el) => { el.indeterminate = true; });
}

/** 单行的模板在 views/files.js（纯函数）；这里补上这一屏的上下文。 */
function rowHtml(f, cat) {
  return fileRowHtml(f, cat, {
    selection: state.selection,
    multiTarget: multiTarget(),
    canReveal: canReveal(),
    targets: state.index?.targets || [],
    appLabel: state.index?.label || '',
  });
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
  // 操作条是 fixed 的：框架式布局里面板底边贴着视口底，不留这条 class
  // 出来的余量，操作条会盖住列表最后一行。
  document.body.classList.toggle('has-bar', n > 0);
  els.abCount.textContent = n.toLocaleString();
  els.abBytes.textContent = fmtBytes(selectedBytes());
  els.abBytes.title = bytesTip(selectedBytes());
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
    || { id: f.c, label: f.c, status: 'warning', verdict: 'never' };
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
  /* 一个都删不掉时不能默默 return —— 用户刚按了一个按钮，屏幕上什么也没发生，
     看起来像工具坏了。说一句他在哪一步被挡住。 */
  if (!rows.length) {
    showToast(dropped
      ? `选中的 ${dropped} 项都删不掉：它们是软链接或受保护内容。`
      : '没有选中任何可以删除的条目。', { error: true });
    return;
  }
  // 抽屉的三块预览（读数 / 分类构成 / 清单）在 views/files.js，有契约测试
  els.drawerStats.innerHTML = drawerStatsHtml(rows, { titleOf: rowTitle });
  els.drawerMix.innerHTML = drawerMixHtml(rows, catOfRow);
  els.drawerList.innerHTML = drawerListHtml(rows, { titleOf: rowTitle });
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

  showDrawer(els.drawer, els.scrim);
}

/* 三个确认抽屉（文件清理 / 会话清理 / 回灌）共用的开合。开之前调用方
   先把内容备好 —— 这里只管"显示 + 焦点进抽屉"与"隐藏 + 焦点归还"。
   busy 时不许关：动作正在跑，抽屉里那份失败清单本身就是要看的东西。 */
function showDrawer(drawer, scrim) {
  scrim.hidden = false;
  drawer.hidden = false;
  openModal(drawer);
}
function hideDrawer(drawer, scrim) {
  if (operationBusy) return;
  scrim.hidden = true;
  drawer.hidden = true;
  closeModal();
}

function closeDrawer() {
  hideDrawer(els.drawer, els.scrim);
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
  if (operationBusy) return;
  const purge = mode() === 'purge';
  els.purgeConfirm.hidden = !purge;
  els.drawerGo.textContent = purge ? '彻底删除' : '移入废纸篓';
  els.drawerGo.className = 'btn ' + (purge ? 'btn-danger' : 'btn-primary');
  /* 切到"彻底删除"时按钮先按不动 —— 确认串还空着。
     切回"移入废纸篓"则一律恢复可点（除非整批被堵死，那个由 openDrawer 管）。 */
  if (purge) syncPurgeWord();
  else els.drawerGo.disabled = false;
}

async function runClean() {
  if (operationBusy) return;
  const batches = selectedByTarget();   // [[target, paths], …] —— 跨目标时分几次发
  const purge = mode() === 'purge';
  if (!batches.length) return;
  if (purge && els.purgeWord.value !== PURGE_WORD()) {
    els.drawerMsg.textContent = '确认串不正确，请输入「彻底删除」四个字。';
    els.drawerMsg.className = 'drawer-msg is-err';
    return;
  }

  operationBusy = true;
  const done = [];
  setBtnBusy(els.drawerGo, true);
  els.drawerMsg.textContent = purge ? '正在彻底删除…' : '正在移入废纸篓…';
  els.drawerMsg.className = 'drawer-msg';

  try {
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
      const completed = data.moved || data.deleted || [];
      done.push(...completed);
      for (const item of completed) state.selection.delete(`${appId}/${target}:${item.path}`);
      failed.push(...(data.failed || []));
    }

    if (failed.length) {
      els.drawerMsg.className = 'drawer-msg is-err';
      els.drawerMsg.textContent = `完成 ${done.length} 项，${failed.length} 项失败：${failed.map((f) => `${f.path}：${f.error}`).join('；')}`;
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
    operationBusy = false;
    closeDrawer();
    showToast(msg);

    // 重扫只是让屏幕上的数字跟上，不需要人等它
    load(true).then(() => loadTasks(true)).catch((err) => showToast(`重新扫描失败：${esc(err.message)}`, { error: true }));
  } catch (err) {
    els.drawerMsg.className = 'drawer-msg is-err';
    els.drawerMsg.textContent = `已完成 ${done.length} 项。${err.message}`;
  } finally {
    operationBusy = false;
    setBtnBusy(els.drawerGo, false);
    renderActionbar();
  }
}

/** 在 Finder 中显示：key 就是 "app/目标:路径"，直接查表，不再线性扫全部文件。 */
async function revealPath(key) {
  const f = state.fileByKey?.get(key);
  if (!f) return;
  try {
    const res = await fetch('/api/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: appIdOfRow(f), target: f.t, path: f.p }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  } catch (err) {
    showToast(`无法显示文件：${esc(err.message)}`, { error: true });
  }
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

/* ── 「全部」：跨工具的会话一览 ──────────────────────────── */

const allState = {
  data: null, q: '', tools: new Set(), loading: false,
  /* 折叠状态：open = 用户手动展开的文件夹，collapsed = 手动收起的。
     两个集合都跨重绘保留 —— 否则每敲一个字筛选，刚展开的那组又收回去。
     默认展开前 DEFAULT_OPEN_GROUPS 组（见 views/all.js）。 */
  open: new Set(),
  collapsed: new Set(),
};

function renderAllAll() {
  // 常规那几块全部收起：这一屏只回答"我刚才在哪个工具里干活"
  for (const id of ['overview', 'files', 'tasks', 'diagnosis']) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  els.allView.hidden = false;
  els.auditView.hidden = true;
  if (!allState.data && !allState.loading) loadAllSessions();
  renderAllSessions();
}

function hideAllView() {
  els.allView.hidden = true;
  els.auditView.hidden = true;
  for (const id of ['overview', 'files', 'tasks']) {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  }
  // 诊断块由 renderHero 决定显隐，这里不强行打开
}

async function loadAllSessions(refresh = false) {
  const request = ++allRequest;
  const epoch = viewEpoch;
  allState.loading = true;
  els.allLede.textContent = '正在汇总各工具的会话…';
  try {
    const res = await fetch('/api/tasks/all' + (refresh ? '?refresh=1' : ''));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (!isAll() || request !== allRequest || epoch !== viewEpoch) return;   // 切走了就丢掉
    allState.data = data;
  } catch (err) {
    if (!isAll() || request !== allRequest || epoch !== viewEpoch) return;
    allState.data = null;
    els.allLede.innerHTML = `<b>汇总失败：</b>${esc(err.message)}`;
  } finally {
    if (request === allRequest && epoch === viewEpoch) {
      allState.loading = false;
      if (isAll()) renderAllSessions();
    }
  }
}

function renderAllSessions() {
  const d = allState.data;
  if (!d) {
    els.allTools.innerHTML = '';
    els.allList.innerHTML = '';
    els.allEmpty.hidden = true;
    return;
  }

  // 每个工具一个筛选钮。三种状态（有会话 / 零会话 / 真读不到）由 views/all.js 区分 ——
  // 后端的 problems 里既有真错误也有说明性提示，混成一句会把正常的工具显示成故障。
  els.allTools.innerHTML = d.tools
    .map((t) => toolFilterChip(t, !allState.tools.size || allState.tools.has(t.app)))
    .join('');

  const q = allState.q;
  const { groups, matched } = groupSessions(d.tasks, { tools: allState.tools, q });

  // 搜索时把命中数写进那句话 —— 否则"筛出 3 个"要靠自己数
  els.allLede.innerHTML = allLedeHtml(d, matched);

  els.allEmpty.hidden = groups.length > 0;
  if (!groups.length) {
    els.allEmpty.innerHTML = q
      ? `没有匹配的会话 —— 搜索「${esc(q)}」筛下来是空的。`
      : '没有匹配的会话。';
    els.allList.innerHTML = '';
    return;
  }

  /* 按文件夹折叠：默认只展开最近的 DEFAULT_OPEN_GROUPS 组。
     实测一个文件夹能装 90 个会话（3340px），全铺开整页六屏（5514px），
     而用户要找的那段几乎总在最上面。折叠后 12 个文件夹一屏能扫完。
     手动展开的记在 allState.open、手动收起的记在 collapsed，
     两者都跨重绘保留 —— 否则每敲一个字筛选，用户就得重新展开一次。 */
  els.allList.innerHTML = groups.map((g, i) => {
    const isOpen = allState.open.has(g.ws)
      || (i < DEFAULT_OPEN_GROUPS && !allState.collapsed.has(g.ws));
    return sessionGroup(g, isOpen);
  }).join('');
}

/* ── 安全审计：凭据外泄扫描 ──────────────────────────────── */

const auditState = { data: null, loading: false };
let auditRequest = 0;

function renderAuditAll() {
  for (const id of ['overview', 'files', 'tasks', 'diagnosis']) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  els.allView.hidden = true;
  els.auditView.hidden = false;
  if (!auditState.data && !auditState.loading) loadAudit();
  renderAudit();
}

async function loadAudit(refresh = false) {
  const request = ++auditRequest;
  const epoch = viewEpoch;
  auditState.loading = true;
  els.auditLede.textContent = '正在扫描各工具的会话正文…（只读）';
  try {
    const res = await fetch('/api/audit' + (refresh ? '?refresh=1' : ''));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (!isAudit() || request !== auditRequest || epoch !== viewEpoch) return;
    auditState.data = data;
  } catch (err) {
    if (!isAudit() || request !== auditRequest || epoch !== viewEpoch) return;
    auditState.data = null;
    els.auditLede.innerHTML = `<b>扫描失败：</b>${esc(err.message)}`;
  } finally {
    if (request === auditRequest && epoch === viewEpoch) {
      auditState.loading = false;
      if (isAudit()) renderAudit();
    }
  }
}

function renderAudit() {
  const d = auditState.data;
  if (!d) {
    els.auditTools.innerHTML = '';
    els.auditList.innerHTML = '';
    els.auditEmpty.hidden = true;
    return;
  }

  const s = auditSummary(d);
  els.auditLede.innerHTML = auditLedeHtml(d, s);
  els.auditTools.innerHTML = d.apps.map(auditToolHtml).join('');

  const groups = auditHitGroups(d);
  els.auditEmpty.hidden = groups.length > 0;
  if (!groups.length) {
    els.auditEmpty.innerHTML = s.scanned
      ? '没有扫到外发命中。敏感文件的读取只算提示，不在这里展开。'
      : '没有可扫描的会话。';
    els.auditList.innerHTML = '';
    return;
  }

  els.auditList.innerHTML = groups.map(({ app, h }) => auditGroupHtml(app, h)).join('');
}

/* ── 会话与非会话 ──────────────────────────────────────────
   会话相关：文件路径里带 sess_<id>，按会话是否仍在会话库里分成两组。
   非会话：日志、缓存、配置等，不属于任何会话。
   孤儿会话（会话库已无）是最干净可删的，单独高亮。 */
function renderSplit() {
  if (!state.index) return;
  const files = state.index?.files || [];
  const groups = { orphan: [], live: [], other: [] };
  for (const f of files) groups[groupOf(f)].push(f);
  const { orphan, live, other } = groups;

  const sids = (xs) => new Set(xs.map((f) => f.sid)).size;
  /* 两块"会话"分组都空的时候这里只剩一块，说"分成三组"就是假话 ——
     而这句说明的主要作用恰恰是解释"为什么没有那两组"。
     这种情况下下面那块 split-note 已经把原因说清了，这里不再重复一遍，
     只留操作提示。 */
  const twoEmpty = orphan.length === 0 && live.length === 0;

  // 数字全部长在下面几块上，这里只交代"为什么这么分"，不再把同一批数字念一遍
  els.splitLede.innerHTML = twoEmpty
    ? `点整块可勾选这一组。`
    : `按<b>会话是否还在</b>分成三组，点一块选中那一组。`;

  /* 每块自己就是一个勾选框：点一下把这一组整个勾上，行也跟着筛到这一组，
     在下面的清单里能看见勾。再点一下取消。
     计数用真正"能勾"的条数 —— 受保护的内容（凭据、会话库、配置）与软链接
     都不进勾选，所以「非会话文件」那块的已选数会比它自己的文件数少，这是对的，照实写。
     块的模板在 views/files.js（splitBlockHtml，有契约测试），这里只递上下文。 */
  const splitCtx = {
    selection: state.selection, keyOf, canPick,
    anyPicked: state.selection.size > 0,
  };

  /* 两块"会话"分组都没内容时（Claude Code 与 Cursor 是常态：前者没有索引库
     可比对，后者的文件路径里不带 sess_ id），各立一张 126px 的空卡片只是
     白白吃掉半屏。折成一行摘要：仍然交代"这里本来会有什么、为什么没有"，
     但不再假装它是一个可点的分组。 */
  const bothEmpty = orphan.length === 0 && live.length === 0;
  const sessNote = bothEmpty
    ? `<p class="split-note">${icon('box')}<span>
         ${esc(state.index.label)} 的文件里没有能对上会话库的条目 —— ` +
       `所以「会话已不存在 / 会话仍在」这两组都是空的。下面全是与会话无关的文件。
       </span></p>`
    : '';

  /* 三块的数字也要跟着筛选走。搜索或状态筛选生效时，下面分类卡只剩几组，
     而这三块还写着全量 —— 屏幕上就同时存在两个"这里有多少"的答案。
     matches() 是清单那侧同一套判据，所以两边一定一致。 */
  const vis = (xs) => xs.filter(matches);

  els.split.innerHTML = sessNote + (bothEmpty ? '' : [
    splitBlockHtml({ cls: 'is-orphan', title: '会话已不存在', desc: '会话库里找不到它，只剩文件残留。可以直接清理。',
      xs: orphan, extra: sids(orphan) ? `，${sids(orphan).toLocaleString()} 个会话` : '', split: 'orphan', hit: vis(orphan), ...splitCtx }),
    splitBlockHtml({ cls: 'is-live', title: '会话仍在', desc: `这些会话还在 ${esc(state.index.label)} 里，文件有用，请谨慎。`,
      xs: live, extra: sids(live) ? `，${sids(live).toLocaleString()} 个会话` : '', split: 'live', hit: vis(live), ...splitCtx }),
  ].join('')) + splitBlockHtml({ cls: 'is-other', title: '非会话文件', desc: '日志、缓存、配置等，不属于任何会话。',
    xs: other, extra: '', split: 'other', hit: vis(other), ...splitCtx });
}

/* 按钮上直接写出这批有多大，点之前就知道会发生什么。
   下面的条目可以逐项开关，按钮数字跟着变。

   一行结构：lane-line 里放 名称 + 大数字 + 计数与后果 + 按钮，
   lane-scope 放分类 chip。挤成一行是为了让按钮数字与说明对得上同一个范围。 */
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
    recLineParts(false);
    return;
  }
  els.rec.hidden = false;

  const on = all.filter((c) => !state.recOff.has(c.id));
  const { cats, bytes, count, blocked } = sumCats(on);

  /* 范围里全是软链接 / 受保护项时，一个也删不掉。
     Codex 现在就是这样：缓存与临时目录里那三个文件全是软链接，界面原本
     还写着"推荐清理 117 B"，按下去毫无反应 —— 按钮在承诺一件做不到的事。
     这种时候不摆按钮，直接说清为什么。 */
  const nothingPickable = on.length > 0 && count === 0;

  /* 全被排除时不该还立着"标题 + 0 B + 禁用的按钮"这个空壳。
     Cursor 只有一类推荐项（已安装扩展），用户把它关掉之后整块就变成
     一个看得见但按不动的胖子，占着 hero 右栏。 */
  const nothingOn = !on.length;

  /* 特殊态：藏掉"名称 + 数字 + 按钮"，只留说明文字在同一行 —— 整行藏掉
     再另起一行说会把行高撑回去。chip 留着，那是把排除掉的分类放回来的
     唯一入口。 */
  if (nothingOn || nothingPickable) {
    recLineParts(true);
    els.recSub.innerHTML = nothingOn
      ? `推荐里的 <b>${all.length}</b> 类都被排除了（${all.map((c) => esc(c.label)).join('、')}）—— 点下面的条目可以放回来。`
      : `推荐范围里的 <b>${blocked}</b> 个文件都删不掉：都是软链接或受保护内容，点条目可看原因。`;
    els.recScope.innerHTML = recChips(all);
    return;
  }
  recLineParts(false);

  els.recFigure.textContent = fmtBytes(bytes);
  els.recFigure.title = bytesTip(bytes);

  /* 这一句得跟着实际范围变。写死"日志、缓存与系统垃圾"只在
     ZCode/Codex/Claude 下成立；Cursor 的推荐项是「已安装扩展」，
     那句"删掉不影响会话、配置和凭据"对它就是假话。 */
  els.recName.textContent = all.length <= 2 ? all.map((c) => c.label).join('、') : '文件与日志';

  /* 一行之内把"共几项 / 删不掉的例外 / 后果"依次说清。
     "勾选后摊开确认清单、不会立刻删除"不写在这 —— 抽屉里的确认串已经把
     这层保险说得更清楚，重复三遍只是噪音。 */
  els.recSub.innerHTML =
    `共 <b>${count.toLocaleString()}</b> 项`
    + (blocked > 0 ? `（另有 ${blocked.toLocaleString()} 项不可清）` : '')
    + ' · '
    + (cats.every((c) => c.verdict === 'safe' || c.verdict === 'junk')
      ? '不影响会话、配置与凭据'
      : '<b>有代价</b> —— 每一类下面写了具体会怎样');

  els.recBtn.disabled = !count;
  /* 按钮不重复体积（大数字就是它），也不重复"共几项"—— 计数在左边那句里。
     完整的构成（哪几类、多少项）放进 tooltip，读细节的人才悬停。 */
  els.recBtn.innerHTML = count ? `${icon('trash')}推荐清理` : '推荐清理';
  els.recBtn.title = count
    ? `${count.toLocaleString()} 项，共 ${fmtBytes(bytes)}（${cats.map((c) => c.label).join('、')}）`
    : '已经一项都不剩了，把上面的条目勾回来';

  els.recScope.innerHTML = recChips(all);
}

/**
 * 推荐行里"名称 / 数字 / 按钮"三样的显隐。
 *
 * 单独抽出来是因为两个方向都要用到：特殊态藏起来、上一轮藏过这一轮正常又得
 * 全部放回。漏放任何一样，就会出现"数字回来了但按钮还藏着"这种半拉子状态。
 * （说明文字 recSub 不在这三样里 —— 它特殊态要显示、正常态也要显示。）
 */
function recLineParts(hidden) {
  els.recName.hidden = hidden;
  els.recFigure.hidden = hidden;
  els.recBtn.hidden = hidden;
}

/** 推荐范围里的分类开关（recChipsHtml 在 views/files.js，排除状态由这里递进去）。 */
const recChips = (list) => recChipsHtml(list, state.recOff);

function renderChips() {
  const order = ['good', 'warning', 'serious', 'critical'];
  els.statusChips.innerHTML = order.map((s) => {
    const cats = state.index.categories.filter((c) => c.status === s);
    if (!cats.length) return '';
    const bytes = cats.reduce((a, c) => a + c.bytes, 0);
    return `<button type="button" class="chip ${STATUS_CLASS[s]} ${state.statuses.has(s) ? 'is-on' : ''}"
      data-status="${s}" aria-pressed="${state.statuses.has(s)}">
      <i></i>${STATUS_LABEL[s]} <em style="font-style:normal;opacity:.7" title="${bytesTip(bytes)}">${fmtBytes(bytes)}</em>
    </button>`;
  }).join('');
}

/* ── 事件 ───────────────────────────────────────────────── */

document.addEventListener('click', async (e) => {
  const t = e.target;

  // 换 app：分类表、清单、历史会话整条线跟着换
  const tab = t.closest('[data-app]');
  if (tab) {
    if (operationBusy) return;
    if (tab.dataset.app === state.appId) return;
    state.appId = tab.dataset.app;
    applyApp();
    /* 「全部」与「安全审计」都没有单 app 的会话面板要读 —— 前者自己走
       /api/tasks/all，后者走 /api/audit。还去调 loadTasks() 会拿一个不存在
       的 app 去扫，白等一次。 */
    if (!isAll() && !isAudit()) loadTasks();
    // 只有已经滚下去了才回页首 —— 磁盘占用现在就在首屏，
    // 站在顶部还硬滚一次等于白抖一下。也不做平滑滚动，
    // 内容正淡入时再滑一屏会晕。
    if (window.scrollY > 40) window.scrollTo({ top: 0 });
    return;
  }

  /* 「全部」里展开/收起一个文件夹。
     与会话管理那屏的 data-ws-toggle 是两套状态（那边按任务列表分组，
     这边按跨工具汇总分组），所以属性名与状态都分开。 */
  const allWs = t.closest('[data-all-ws]');
  if (allWs) {
    const ws = allWs.dataset.allWs;
    const groups = [...document.querySelectorAll('#allList .all-group')];
    const idx = groups.findIndex((g) => g.querySelector('[data-all-ws]')?.dataset.allWs === ws);
    toggleAllGroup(allState, ws, idx, DEFAULT_OPEN_GROUPS);
    renderAllSessions();
    return;
  }

  /* 「全部」视图里的工具筛选与搜索 */
  const allTool = t.closest('[data-all-tool]');
  if (allTool) {
    toggleToolFilter(allState, allTool.dataset.allTool);
    renderAllSessions();
    return;
  }

  // "这是什么 / 为什么在这里"的展开开关（跟展开文件列表是两回事）
  const more = t.closest('[data-more]');
  if (more) {
    toggleExplain(state, more.dataset.more);
    renderGroups();
    return;
  }

  /* 展开按钮优先于整行点击：放在 group-head 那条之前，
     否则点三角会被当成点组头，走同一条逻辑（结果一样，但会绕一圈重画）。 */
  const gToggle = t.closest('[data-group-toggle]');
  if (gToggle) {
    const id = gToggle.dataset.groupToggle;
    toggleCategory(state, id);
    renderGroups();
    // 重画后原按钮已经不在文档里，焦点得按 id 找回来，否则键盘走到这里就断了
    els.groups.querySelector(`[data-group-toggle="${id}"]`)?.focus();
    return;
  }

  // 分组展开 / 收起（点组头的空白处也仍然有效）
  const head = t.closest('.group-head');
  if (head && !t.matches('input[type="checkbox"]')) {
    toggleCategory(state, head.closest('.group').dataset.cat);
    renderGroups();
    return;
  }

  // 分组全选
  const gbox = t.closest('[data-group-box]');
  if (gbox) {
    /* 只动当前看得见的行，跟卡片头上那个框自身的勾选状态对得上；
       软链接与受保护项不进选区 —— 服务端会拒绝，选了等于白选。 */
    toggleGroupBox(state, gbox.dataset.groupBox, gbox.checked, {
      filesOf, matches, selectableOnly, keyOf,
      catOf: (id) => state.index.categories.find((c) => c.id === id),
    });
    renderGroups(); renderActionbar(); renderSplit();
    return;
  }

  // 单文件
  const fbox = t.closest('input[data-key]');
  if (fbox) {
    toggleRow(state, fbox.dataset.key, fbox.checked);
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
    toggleStatus(state, chip.dataset.status);
    /* renderSplit 也要重画：三块分组上的体积与条数按"当前筛出多少"算，
       不跟着重画就会和下面只剩两组的清单对不上。 */
    renderChips(); renderSplit(); renderGroups();
    return;
  }

  // 三块中的任意一块 → 整组勾上 / 取消，并把清单筛到这一组，好让人看见勾在哪。
  // 受保护的内容（凭据、会话库、配置）不进勾选 —— 跟「全选」同一条规矩。
  const sp = t.closest('[data-split]');
  if (sp) {
    /* 三条规矩（只勾看得见的 / 跳过受保护与软链 / 三块互斥）都在
       actions.js 的 toggleSplitGroup 里，那边有单测。 */
    toggleSplitGroup(state, sp.dataset.split, {
      files: state.index.files, groupOf, canPick, matches, keyOf,
    });
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
    toggleRecommendItem(state, rc.dataset.rec);
    saveRecOff();
    renderRecommend();
    return;
  }

  // 推荐清理：清掉筛选（免得勾中的东西被滤掉看不见），勾满当前推荐范围，
  // 然后直接把确认清单摊开 —— 到此为止，不执行任何删除。
  if (t.closest('#recBtn')) {
    selectRecommended(state, recommendOn(), { filesOf, selectableOnly, keyOf });
    els.search.value = '';
    renderChips(); renderSplit(); renderGroups(); renderActionbar();
    openDrawer();
    return;
  }
  if (t.closest('#clearSelBtn')) {
    // 取消勾选就一起把分组筛选撤了 —— 否则清单还筛着，三块却全是没勾的样子
    clearSelection(state);
    renderSplit(); renderGroups(); renderActionbar(); return;
  }
  if (t.closest('#fileSelAll')) {
    // visibleCategories() 已经把筛完的行带出来了，不必再 filter 一遍
    selectAllVisible(state, visibleCategories(), { selectableOnly, keyOf });
    renderSplit(); renderGroups(); renderActionbar(); return;
  }
  if (t.closest('#rescanBtn')) {
    if (operationBusy) return;
    setBtnBusy(els.rescanBtn, true);
    try {
      await load(true);
      if (isAll()) await loadAllSessions(true);
      else if (isAudit()) await loadAudit(true);
      else await loadTasks(true);
    } catch (err) {
      showToast(`重新扫描失败：${esc(err.message)}`, { error: true });
    } finally {
      setBtnBusy(els.rescanBtn, false);
    }
    return;
  }
  if (t.closest('#themeBtn')) {
    const next = nextTheme(document.documentElement.getAttribute('data-theme'));

    /* 切主题时把正在跑的过渡全部取消掉。
       实测：`.app-tab` 这类带 `transition: color .14s` 的元素，在主题变量
       换掉的同一帧里会用**旧值**起一个过渡，之后一直停在那个旧颜色上
       （新建的同款元素颜色是对的，只有已存在的那个错）。切到深色后
       工具标签的文字停在浅色主题的深灰上，在深底里几乎看不见。

       做法分两步，缺一不可：
         ① 加 .is-theme-switching 把 transition 全部关掉（CSS 那边 !important）
         ② 主动 cancel 已经启动的那些 —— 光靠 CSS 改 transition 不会
            中断已经在跑的动画，它们会继续往旧目标值走完。 */
    document.documentElement.classList.add('is-theme-switching');
    next ? document.documentElement.setAttribute('data-theme', next)
         : document.documentElement.removeAttribute('data-theme');

    for (const anim of document.getAnimations()) {
      if (anim instanceof CSSTransition) anim.cancel();
    }

    /* 用 setTimeout 而不是 rAF 摘这个类：rAF 在后台标签页里根本不触发，
       类会永远留在 html 上，全站动画就全死了。 */
    clearTimeout(themeSwitchTimer);
    themeSwitchTimer = setTimeout(() => {
      document.documentElement.classList.remove('is-theme-switching');
    }, 120);
    try { localStorage.setItem('zci-theme', next); } catch {}
    return;
  }
});

els.search.addEventListener('input', () => {
  state.q = els.search.value.trim().toLowerCase();
  // 三块的数字跟着搜索走，见上面 renderSplit 里的 vis()
  renderSplit(); renderGroups();
});

els.allSearch.addEventListener('input', () => {
  allState.q = els.allSearch.value.trim().toLowerCase();
  renderAllSessions();
});

els.sortSel.addEventListener('change', () => {
  state.sort = els.sortSel.value;
  renderGroups();
});

document.addEventListener('change', (e) => {
  if (e.target.name === 'mode') syncDrawerMode();
});

/* 确认串由服务端随 /api/scan 下发（lib/confirm-words.mjs 是唯一来源）。
   前端不自己写这几个字 —— 两边各写一份，改一处忘另一处，
   界面就会放行一个服务端必然拒绝的请求。
   三个词分别对应三条路径，词本身说出那一步在做什么。 */
const confirmWords = () => state.scan?.confirm || {};
const PURGE_WORD = () => confirmWords().FILES || '彻底删除';
const TASK_PURGE_WORD = () => confirmWords().SESSION || '清理';
const RECOVER_WORD = () => confirmWords().RECOVER || '回灌';

/* 彻底删除的确认串：输对之前按钮按不动 —— 按钮状态直接反映"这句话你
   确认了没有"，顺带把还差几个字告诉人。可点然后报错等于让人白撞一次墙。 */
function syncPurgeWord() {
  if (operationBusy) return;
  if (mode() !== 'purge') return;
  const ok = els.purgeWord.value === PURGE_WORD();
  els.drawerGo.disabled = !ok;
  els.drawerMsg.className = 'drawer-msg';
  // "还差几个字"的提示是三条路径共用的一份（confirmWordHint），输入为空或已输对时是空串
  els.drawerMsg.textContent = confirmWordHint(els.purgeWord.value, PURGE_WORD(), '彻底删除');
}
els.purgeWord.addEventListener('input', syncPurgeWord);

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
    if (!rEls.drawer.hidden) { trapTab(e, rEls.drawer); return; }
  }

  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    const search = isAll() ? els.allSearch : isAudit() ? null : els.search;
    if (search && !document.body.classList.contains('is-modal')) {
      e.preventDefault(); search.focus(); search.select();
    }
  }
  if (e.key === 'Escape') {
    /* 由近及远一层层退：先关浮层，再撤搜索，最后撤筛选。
       不按"焦点在不在搜索框"决定 —— 人通常是点完筛选钮、或者滚到清单里
       才发现筛空了，那时焦点早就不在输入框上。 */
    if (!els.drawer.hidden) closeDrawer();
    else if (!tEls.drawer.hidden) closeTaskDrawer();
    else if (!rEls.drawer.hidden) closeRecoverDrawer();
    else if (state.q || state.statuses.size || state.group) {
      const wasSearch = Boolean(state.q);
      state.q = '';
      els.search.value = '';
      state.statuses.clear();
      state.group = null;
      renderChips(); renderSplit(); renderGroups(); renderActionbar();
      if (wasSearch) els.search.blur();
    } else if (document.activeElement === els.search) {
      els.search.blur();
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

  /* tablist 的键盘模型：上下箭头在标签之间走，Home/End 到两头。
     走的同时就切换（这是"自动激活"模式，工具切换没有副作用，
     不需要再按一次回车确认）。roving tabindex 让 Tab 只停在当前那一项上。

     方向键跟着**导航的排布**走：标签从顶栏搬到左侧栏后变成竖排，
     所以主用的是上下。左右仍然接受 —— ARIA 规范里竖排 tablist 的
     左右键是"可选支持"，而已经习惯左右的人不该突然按了没反应。 */
  if (e.target.matches?.('#appTabs [role="tab"]')) {
    const tabs = [...els.appTabs.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(e.target);
    let next = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
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
  toolbar: $('taskToolbar'), empty: $('taskEmpty'),
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
  exclusiveFailed: false,
};

/* Cursor 孤儿会话回灌。与上面的"清理"是两条完全不同的线：
   这里只新增行，不删任何东西；选中集合也单独放，避免和清理勾选串台。 */
const rEls = {
  // 页面上的列表（浏览与勾选）
  panel: $('recoverPanel'), lede: $('recoverLede'), warn: $('recoverWarn'),
  list: $('recoverList'), foot: $('recoverFoot'), count: $('recoverCount'),
  bubbles: $('recoverBubbles'), pickAll: $('recoverPickAll'), clear: $('recoverClear'),
  btn: $('recoverBtn'),
  // 确认抽屉（与另外两条清理线同一套）
  scrim: $('rscrim'), drawer: $('rdrawer'), stats: $('rdrawerStats'),
  note: $('rdrawerNote'), listD: $('rdrawerList'), countD: $('rdrawerCount'),
  dryWrap: $('rdryWrap'), dryList: $('rdryList'),
  confirmBox: $('rConfirmBox'), word: $('rWord'), msg: $('rdrawerMsg'),
  dryBtn: $('rdryBtn'), go: $('rdrawerGo'),
};
const recoverState = { data: null, sel: new Set(), open: false };

/* 状态字典与"可清理"判定在 views/tasks.js（纯函数，有契约测试）——
   reason 的文案由后端判定、前端照用，不再各存一份。 */

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
  // 工具栏默认收起：没有数据时它全是摆设。有数据的那个分支会把它放回来。
  tEls.toolbar.hidden = true;
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
}

async function loadTasks(refresh = false) {
  const request = ++taskRequest;
  const epoch = viewEpoch;
  const appId = state.appId;
  const view = state.index;
  taskState.data = null;
  taskState.sel.clear();
  taskState.states.clear();
  taskState.open.clear();
  taskState.exclusive = null;
  taskState.exclusiveMeta = null;
  taskState.exclusiveFailed = false;
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
    if (request !== taskRequest || epoch !== viewEpoch || state.appId !== appId || data.appId !== appId) return;
    taskState.data = data;
    renderTasks();
    // 有回灌写路径的工具另外有一条"界面看不到的会话"线，独立懒加载
    if (data.canRecover) loadRecoverable();
    // Cursor 的独占量要十几秒（整库内容寻址池解一遍），不挡首屏：
    // 先把列表画出来，算完再补上"删它能带走多少"。
    if (data.history === 'cursor-db') loadExclusive(appId);
  } catch (err) {
    if (request !== taskRequest || epoch !== viewEpoch || state.appId !== appId) return;
    tEls.lede.classList.remove('is-loading');
    tEls.lede.innerHTML = `<b>读取失败：</b>${esc(err.message)}`;
  } finally {
    if (request === taskRequest && epoch === viewEpoch) setPanelBusy(false);
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
  const epoch = viewEpoch;
  const request = taskRequest;
  taskState.exclusive = null;
  taskState.exclusiveFailed = false;
  try {
    const res = await fetch('/api/tasks/cursor/analyze');
    if (!res.ok) throw new Error('引用分析失败');
    const data = await res.json();
    if (epoch !== viewEpoch || request !== taskRequest || state.appId !== appIdAtCall) return;   // 切走了就丢掉
    const map = new Map();
    for (const s of data.sessions || []) map.set(s.id, s);
    taskState.exclusive = map;
    taskState.exclusiveMeta = { blobs: data.blobs, blobBytes: data.blobBytes, orphanBlobs: data.orphanBlobs };
    renderTaskList();
    renderTaskFoot();
    if (!tEls.drawer.hidden) renderTaskDrawerSummary();
  } catch {
    if (epoch !== viewEpoch || request !== taskRequest) return;
    taskState.exclusive = null;
    taskState.exclusiveFailed = true;
    if (!tEls.drawer.hidden) renderTaskDrawerSummary();
  }
}

/* ── Cursor：界面看不到的会话 ───────────────────────────── */

function hideRecoverable() {
  if (!rEls.panel) return;
  rEls.panel.hidden = true;
  rEls.list.innerHTML = '';
  rEls.warn.hidden = true;
  rEls.foot.hidden = true;
  // 抽屉可能开着 —— 切走时一起收掉，不能让它挂在新工具的画面上
  if (recoverState.open) closeRecoverDrawer();
  recoverState.data = null;
  recoverState.sel.clear();
  recoverState.open = false;
}

async function loadRecoverable() {  // 晚到的旧响应要丢掉：切走之后能力位可能仍为真，只能比身份
  const appIdAtCall = state.appId;
  const epoch = viewEpoch;
  const request = taskRequest;
  if (!state.index?.canRecover || !rEls.panel) { hideRecoverable(); return; }
  rEls.panel.hidden = false;
  rEls.lede.textContent = '正在找界面里看不到的会话…';
  rEls.list.innerHTML = '';
  rEls.warn.hidden = true;
  rEls.foot.hidden = true;
  if (recoverState.open) closeRecoverDrawer();
  recoverState.open = false;

  try {
    const res = await fetch('/api/tasks/cursor/orphans');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (epoch !== viewEpoch || request !== taskRequest || state.appId !== appIdAtCall) return;
    recoverState.data = data;
    // 上次勾了、这次已经回灌掉的会话不能继续留在选择集里
    const ids = new Set((data.sessions || []).map((s) => s.id));
    for (const id of [...recoverState.sel]) if (!ids.has(id)) recoverState.sel.delete(id);
    renderRecoverable();
  } catch (err) {
    if (epoch !== viewEpoch || request !== taskRequest || state.appId !== appIdAtCall) return;
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
    : d.problems?.length ? '无法完整确认孤儿会话，请先处理下方读取问题。'
      : `没有发现可回灌的孤儿会话。`;

  // 运行状态 / 读取问题
  const warns = [];
  if (d.app?.unknown) {
    warns.push(`无法确认 Cursor 是否退出，暂不能回灌。${esc(d.app.error || '')}`);
  } else if (d.app?.running) {
    warns.push(`<b>Cursor 正在运行</b>（${(d.app.hits || []).map((h) => `${esc(h.name)} ×${h.pids}`).join('、')}）。` +
      `回灌会写 <code>state.vscdb</code>，必须先<b>完全退出 Cursor</b>；现在可以浏览和空跑，写入会被拒绝。`);
  } else {
    warns.push(`Cursor 没在运行，可以安全回灌。动手前会把 <code>state.vscdb</code> 完整备份到 ` +
      `<code>${esc(shortPath(d.backupDir || 'backups'))}</code>。`);
  }
  for (const p of d.problems || []) warns.push(esc(p));
  if (warns.length) {
    rEls.warn.hidden = false;
    rEls.warn.className = (d.app?.running || d.app?.unknown || d.problems?.length) ? 'app-warn' : 'app-warn is-ok';
    rEls.warn.innerHTML = `${icon((d.app?.running || d.app?.unknown || d.problems?.length) ? 'alert' : 'box')}<div>${warns.join('<br>')}</div>`;
  } else {
    rEls.warn.hidden = true;
  }

  rEls.list.innerHTML = sessions.map((s) => recoverRowHtml(s, recoverState.sel.has(s.id))).join('');

  const picked = sessions.filter((s) => recoverState.sel.has(s.id));
  rEls.foot.hidden = picked.length === 0;
  rEls.count.textContent = picked.length.toLocaleString();
  rEls.bubbles.textContent = picked.reduce((n, s) => n + s.bubbles, 0).toLocaleString();

  // 确认抽屉开着时，它的内容跟着选择集一起更新（取消勾选一条，抽屉里的清单要少一条）
  if (recoverState.open) renderRecoverDrawer();
}

/* 回灌的确认串。它和另外两条清理线共用"输对才亮"的规矩，
   但这条是**写入**（往库里加会话头与气泡），比删除更需要这道闸 ——
   删除错了至少还在废纸篓里，回灌错了是往一个活库里塞东西。
   所以按钮不能只看"有没有勾选"和"Cursor 在不在跑"，必须等确认串输对。 */
function syncRecoverWord() {
  if (operationBusy) return;
  const d = recoverState.data;
  const word = d?.confirmWord || RECOVER_WORD();
  const picked = (d?.sessions || []).filter((s) => recoverState.sel.has(s.id)).length;
  const running = Boolean(d?.app?.running || d?.app?.unknown);
  const ok = rEls.word.value === word;
  rEls.go.disabled = running || d?.failed || picked === 0 || !ok;
  /* 两个条件都要说：
     ① 没勾任何会话 / Cursor 在跑 —— 这是**比输入**更前面的拦阻，
        说了它就不必再说"还差几个字"，那会让两件事挤在一行里互相盖住；
     ② 输入不完整 —— 只在没有 ① 的时候才有意义。
     ① 若提前 return，Cursor 开着时输错确认串就看不到"还差…"，
     人不知道自己还漏了一步。 */
  if (!picked) {
    rEls.msg.textContent = '';
    rEls.msg.className = 'drawer-msg';
    return;
  }
  if (d?.failed) {
    rEls.msg.className = 'drawer-msg is-err';
    rEls.msg.textContent = '扫描未完成，请先处理读取问题并重新扫描。';
    return;
  }
  if (running) {
    rEls.msg.className = 'drawer-msg is-warn';
    /* 输对了才把"退出 Cursor 就能点"说出来 —— 输错时说这句，等于告诉人
       "你已经准备好了"，而其实还差一个词。 */
    rEls.msg.textContent = (d?.app?.unknown ? '无法确认 Cursor 是否退出，现在不能写入。' : 'Cursor 仍在运行，现在不能写入。') +
      (ok ? `退出 Cursor 后重新打开本页即可点「${word}」。` : '');
    return;
  }
  // 能输入了（没勾 / 在跑的两个拦阻都处理完）：进度提示是三条路径共用的一份
  rEls.msg.className = 'drawer-msg';
  rEls.msg.textContent = confirmWordHint(rEls.word.value, word, '写入');
}
rEls.word?.addEventListener('input', syncRecoverWord);

/**
 * 打开回灌确认抽屉。
 *
 * 结构与另外两条清理线一致：**列表在页面上浏览与勾选，确认进抽屉**。
 * 三条路径的确认姿势必须一致 —— 而回灌是唯一往库里**写**东西的那条，
 * 最该长得像"要动手了"。
 */
function openRecoverDrawer() {
  const d = recoverState.data;
  if (!d) return;
  const picked = (d.sessions || []).filter((s) => recoverState.sel.has(s.id));
  if (!picked.length) {
    showToast('先勾选要回灌的会话。', { error: true });
    return;
  }
  recoverState.open = true;
  rEls.msg.textContent = '';
  rEls.msg.className = 'drawer-msg';
  rEls.word.value = '';
  rEls.dryWrap.hidden = true;
  renderRecoverDrawer();
  showDrawer(rEls.drawer, rEls.scrim);
}

function renderRecoverDrawer() {
  const d = recoverState.data;
  if (!d) return;
  const picked = (d.sessions || []).filter((s) => recoverState.sel.has(s.id));
  const bubbles = picked.reduce((n, s) => n + (s.bubbles || 0), 0);
  const running = Boolean(d.app?.running);

  rEls.stats.innerHTML =
    `<div class="dstat"><span>会话</span><b>${picked.length.toLocaleString()}</b></div>
     <div class="dstat"><span>消息</span><b>${bubbles.toLocaleString()}</b></div>
     <div class="dstat"><span>正文合计</span><b>${fmtBytes(picked.reduce((n, s) => n + (s.bytes || 0), 0))}</b></div>`;

  /* 这条路径是**新增**，不是删除 —— 说明里要把这一点说在最前面，
     否则一个长得跟删除抽屉一样的界面会让人以为要丢东西。 */
  rEls.note.innerHTML = running
    ? `<b>Cursor 仍在运行</b>，现在不能写入。请完全退出 Cursor 后重新打开本页。`
    : `回灌只<b>新增</b>会话头与气泡，不动任何已有会话；重复的会被跳过。` +
      `动手前会把 <code>state.vscdb</code> 完整备份到 ` +
      `<code>${esc(shortPath(d.backupDir || 'backups'))}</code>。`;

  const sorted = picked.slice().sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  rEls.listD.innerHTML = sorted.slice(0, 200).map((s) =>
    `<li title="${esc(s.title)}"><span>${esc(s.title)}</span><span title="${bytesTip(s.bytes || 0)}">${fmtBytes(s.bytes || 0)}</span></li>`).join('')
    + (sorted.length > 200
      ? `<li class="drawer-more"><span>下面还有 ${(sorted.length - 200).toLocaleString()} 项没列出来，` +
        `<b>它们同样在这次的范围内</b>。</span><span></span></li>` : '');
  rEls.countD.textContent = `${picked.length.toLocaleString()} 个`;

  rEls.confirmBox.hidden = false;
  /* 空跑是只读的 —— 服务端那边 `if (!dryRun && confirm !== ...)` 与
     `if (running.running && !dryRun)` 都只在**写入**时拦，空跑随便跑。
     前端却按 running 把它禁了，title 上还写着"Cursor 开着也能跑"，
     等于摆一个按不动的按钮并告诉人"这个能用"。两处必须一致，以服务端为准。 */
  rEls.dryBtn.disabled = false;
  rEls.dryBtn.title = running
    ? '空跑是只读的，Cursor 开着也能跑 —— 这里只核对会插入多少行'
    : '不写任何东西，只核对会插入多少行';
  syncRecoverWord();
}

const closeRecoverDrawer = () => {
  if (operationBusy) return;
  recoverState.open = false;
  rEls.msg.textContent = '';
  hideDrawer(rEls.drawer, rEls.scrim);
};

async function callRecover(dryRun) {
  if (operationBusy) return;
  const d = recoverState.data;
  const ids = [...recoverState.sel];
  if (!d || !ids.length) return;
  operationBusy = true;
  rEls.go.disabled = true;
  rEls.dryBtn.disabled = true;
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
      /* 空跑结果摊在抽屉里，与"会话清理"那条线同一个位置、同一个形状 ——
         三条路径的确认界面共用一套结构，逐项清单也是同一块。 */
      rEls.dryWrap.hidden = false;
      rEls.dryList.innerHTML =
        `<li><span>会话头（composerHeaders）</span><span>${(data.imported ?? 0).toLocaleString()}</span></li>` +
        `<li><span>消息气泡（bubbleId）</span><span>${(data.bubbles ?? 0).toLocaleString()}</span></li>` +
        `<li><span>跳过的已有会话</span><span>${(data.skipped ?? 0).toLocaleString()}</span></li>`;
      rEls.msg.className = 'drawer-msg is-ok';
      rEls.msg.innerHTML = `空跑完成：会写入 <b>${data.imported ?? 0}</b> 个会话、` +
        `<b>${data.bubbles ?? 0}</b> 条气泡。没有写任何东西。`;
    } else {
      // 已回灌的会话从本地列表里移除，不用整页重扫
      const done = new Set((data.sessions || []).map((s) => s.id));
      if (d.sessions) d.sessions = d.sessions.filter((s) => !done.has(s.id));
      d.total = d.sessions?.length || 0;
      d.orphanBytes = (d.sessions || []).reduce((sum, s) => sum + (s.bytes || 0), 0);
      recoverState.sel.clear();
      /* 与另外两条清理线同一条收尾规矩：动作已经完成了，抽屉就没有继续
         开着的理由 —— 先关抽屉，再把结果搬到屏幕上。 */
      const backupTxt = data.backup ? `备份在 ${shortPath(data.backup)}。` : '';
      operationBusy = false;
      closeRecoverDrawer();
      showToast(`已回灌 <b>${data.imported ?? 0}</b> 个会话、<b>${data.bubbles ?? 0}</b> 条气泡。` +
        `${esc(backupTxt)}重启 Cursor 后，它们会出现在会话列表里。`);
      renderRecoverable();
      void loadTasks(true);
    }
  } catch (err) {
    rEls.msg.className = 'drawer-msg is-err';
    rEls.msg.textContent = err.message;
  } finally {
    // 收尾时按确认串的真实状态恢复 —— 无条件打开会绕过刚加的门控
    operationBusy = false;
    rEls.dryBtn.disabled = false;
    const message = rEls.msg.textContent;
    const messageClass = rEls.msg.className;
    syncRecoverWord();
    // 恢复按钮状态不能擦掉刚得到的空跑结果或失败原因。
    rEls.msg.textContent = message;
    rEls.msg.className = messageClass;
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
rEls.btn?.addEventListener('click', openRecoverDrawer);
rEls.dryBtn?.addEventListener('click', () => callRecover(true));
rEls.go?.addEventListener('click', () => callRecover(false));
rEls.scrim?.addEventListener('click', closeRecoverDrawer);
$('rdrawerClose')?.addEventListener('click', closeRecoverDrawer);
$('rdrawerCancel')?.addEventListener('click', closeRecoverDrawer);

/* visibleTasks / fileBasedNote 在 views/tasks.js —— 这里的调用点传当前筛选状态。 */

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
    /* 一条会话都没有时，搜索框 / 排序 / 分组 / 全选全是摆设 —— 它们操作不了
       任何东西，却让面板看起来"有内容"。一起收起来，只留那句说明。 */
    tEls.toolbar.hidden = true;
    tEls.empty.hidden = true;
    // 上一个 app 的警示条和体积柱得擦干净 —— 切到一个没有历史的工具，
    // 屏幕上不能还留着别人的数字。
    tEls.warn.hidden = true;
    tEls.warn.innerHTML = '';
    tEls.dbBar.innerHTML = '';
    tEls.chips.innerHTML = '';
    renderTaskFoot();
    renderTaskQuick();
    // Claude Code 这类"正文就是文件"的工具，就算一条会话没读到，也要说清楚
    // 为什么这里没有可勾的东西；后端报的读取问题也要上屏。模板在 views/tasks.js。
    const emptyWarn = taskEmptyWarnHtml(d);
    if (emptyWarn) {
      tEls.warn.hidden = false;
      tEls.warn.className = emptyWarn.className;
      tEls.warn.innerHTML = emptyWarn.html;
    }
    return;
  }
  tEls.toolbar.hidden = false;   // 有数据了，把搜索/排序/分组放回来

  // 顶部那句话与警示条都是"给一行数据说人话"的模板（views/tasks.js，有契约测试）
  tEls.lede.innerHTML = taskLedeHtml(d);
  const warn = taskWarnHtml(d);
  tEls.warn.hidden = false;
  tEls.warn.className = warn.className;
  tEls.warn.innerHTML = warn.html;

  renderDbBar();
  renderTaskChips();
  renderTaskList();
  renderTaskFoot();
  renderTaskQuick();
  renderComposition();
}

/** 体积条：分段、分母与宽度分配都在 views/tasks.js（dbBarSegments，有契约测试）。
 *  这里只画 DOM，并按量出来的像素决定放不放文字。 */
function renderDbBar() {
  const d = taskState.data;
  const { segs, floors } = dbBarSegments(d);

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
        data-tip="${esc(`${s.tip ? s.tip + ' ' : s.label + '，'}${fmtBytes(s.bytes)}（${bytesTip(s.bytes)}）`)}">
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
        <span class="tcomp-n" title="${bytesTip(c.bytes)}">${c.count == null ? '' : `${c.count.toLocaleString()} 行，`}${fmtBytes(c.bytes)}</span>
      </div>`;
    }).join('');
}

function renderTaskChips() {
  const d = taskState.data;
  // 体积写在上面那根条上，这里改说"几个任务" —— 换个数字，不把同一件事念两遍。
  // 标签与配色都带兜底：后端多一个状态桶时退化成可读的词，不画 undefined。
  tEls.chips.innerHTML = d.totals.byState.map((g) => {
    const label = STATE_META_CN[g.state] || g.state;
    return `<button type="button" class="chip ${STATE_TONE[g.state] || ''} ${taskState.states.has(g.state) ? 'is-on' : ''}"
      data-tstate="${g.state}" aria-pressed="${taskState.states.has(g.state)}"
      title="${esc(label)} ${g.count} 个，${fmtBytes(g.bytes)}（${bytesTip(g.bytes)}）">
      <i></i>${esc(label)} <em style="font-style:normal;opacity:.7">${g.count}</em>
    </button>`;
  }).join('');
}

function renderTaskList() {
  const list = visibleTasks(taskState.data, { q: taskState.q, states: taskState.states, sort: taskState.sort });
  tEls.empty.hidden = list.length > 0;

  /* 行模板在 views/tasks.js（taskRowHtml，有契约测试）；这里只补这一屏的
     上下文：勾选、展开、Cursor 的独占 blob、分组开关（关时行里带工作区）。 */
  const rowOf = (t) => taskRowHtml(t, {
    sel: taskState.sel.has(t.id),
    open: taskState.open.has(t.id),
    exclusive: taskState.exclusive?.get(t.id),
    showWorkspace: !taskState.group,
  });

  if (!taskState.group) {
    tEls.list.innerHTML = list.map(rowOf).join('');
    return;
  }

  // 按工作区聚合。组按正文合计降序；组内保持当前排序（list 已经排好了）。
  const groups = groupTasksByWorkspace(list);

  tEls.list.innerHTML = groups.map((g) => taskGroupHtml(g, {
    folded: taskState.foldedWs.has(g.ws),
    selCount: g.tasks.filter((t) => taskState.sel.has(t.id)).length,
    rowsHtml: taskState.foldedWs.has(g.ws) ? '' : g.tasks.map(rowOf).join(''),
  })).join('');
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

/* 勾选合计（taskSelTotals）在 views/tasks.js —— 调用点传数据与选择集。 */

function renderTaskFoot() {
  const d = taskState.data;
  const { count, bytes } = taskSelTotals(d, taskState.sel);
  // 只读的 app 连"清理"这个入口都不摆 —— 摆了也是必然被拒的按钮
  tEls.foot.hidden = !d || d.readOnly || count === 0;
  /* 这一栏的数字也要擦干净，不能只靠 hidden：从某个工具带着勾选切到「全部」，
     整块虽然 display:none 了，里面的 "已选 1 个会话，99 KB" 还留在 DOM 里。
     下一次它被放出来（切回同一个工具）之前，读屏与复制文本都能拿到这句旧话。 */
  if (!d) {
    tEls.tfCount.textContent = '0';
    tEls.tfBytes.textContent = fmtBytes(0);
    tEls.purgeBtn.textContent = '清理…';
    tEls.purgeBtn.title = '';
    return;
  }
  tEls.tfCount.textContent = count.toLocaleString();
  tEls.tfBytes.textContent = fmtBytes(bytes);
  tEls.tfBytes.title = bytesTip(bytes);
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

function taskQuickSetCall() {
  return taskQuickSet(taskState.data, tq);
}

function renderTaskQuick() {
  const d = taskState.data;
  const del = d?.totals.byState.find((g) => g.state === 'deleted');
  if (!del) { els.taskQuick.hidden = true; return; }
  els.taskQuick.hidden = false;

  const s = taskQuickSetCall();
  els.tqFigure.textContent = fmtBytes(s.bytes);
  // 三段文案（行内说明 / 大数字 tooltip / 按钮 tooltip）在 views/tasks.js
  const texts = taskQuickTexts(d, s, tq);
  els.tqSub.innerHTML = texts.subHtml;
  els.tqFigure.title = texts.figureTitle;

  els.taskAge.value = String(tq.ageDays);

  // 已删除的任务里根本没有置顶的，就别摆一个按了没反应的开关
  const anyPinned = d.tasks.some((t) => t.state === 'deleted' && t.pinned);
  els.taskSkipPinned.hidden = !anyPinned;
  els.taskSkipPinned.classList.toggle('is-on', tq.skipPinned);
  els.taskSkipPinned.setAttribute('aria-pressed', String(tq.skipPinned));

  // 按钮不重复体积（大数字就是它）；"勾选后先出确认清单、不会立刻删除"进 tooltip
  els.taskQuickBtn.disabled = !s.tasks.length;
  els.taskQuickBtn.textContent = '一键清理';
  els.taskQuickBtn.title = texts.btnTitle;
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

function renderTaskDrawerSummary() {
  const d = taskState.data;
  const { count, bytes, children, rows, picked } = taskSelTotals(d, taskState.sel);
  if (!count) return;
  const who = d.appLabel;

  /* Cursor 的抽屉要把"连带回收"算进总数：勾两条会话，正文只有 32.6 MB，
     但连带删掉的工具结果还有 62.7 MB —— 只显示正文的话，人会以为删这一批
     只省那么点。数字必须能对上下一次真的删完之后的 toast。

     分析要十几秒。没算完时不要装作"没有连带" —— 那会让人以为数字很小，
     显式说一句"还在算"，等它到了再补。这里只算这一遍：读数与说明文字
     都用它，各算各的迟早对不上。 */
  const exTotal = (() => {
    if (!taskState.exclusive) return null;
    let b = 0, n = 0;
    for (const t of picked) {
      const e = taskState.exclusive.get(t.id);
      if (e) { b += e.exclusiveBytes; n += e.exclusiveBlobs; }
    }
    return { bytes: b, blobs: n };
  })();
  const exPending = taskState.exclusive === null && !taskState.exclusiveFailed && d.history === 'cursor-db';

  // 抽屉的三块文案（读数 / 说明 / 待删清单）在 views/tasks.js，有契约测试
  tEls.stats.innerHTML = taskDrawerStatsHtml({
    count, rows, bytes, exTotal, exPending, exFailed: taskState.exclusiveFailed, hasBodies: Boolean(d.db?.bodies),
  });
  tEls.note.innerHTML = taskDrawerNoteHtml(d, { exB: exTotal?.bytes || 0, exN: exTotal?.blobs || 0 });
  tEls.listD.innerHTML = taskDrawerListHtml(picked, who);
  tEls.countD.textContent = `${count.toLocaleString()} 个`;
  return true;
}

function openTaskDrawer() {
  if (!renderTaskDrawerSummary()) return;
  tEls.dryWrap.hidden = true;
  tEls.word.value = '';
  tEls.confirmBox.hidden = false;
  tEls.msg.textContent = '';
  tEls.msg.className = 'drawer-msg';
  // 确认串还空着 → 删除按钮先按不动（和文件清理那条线一致）
  tEls.go.disabled = true;
  tEls.go.textContent = '删除';
  tEls.dryBtn.disabled = false;

  showDrawer(tEls.drawer, tEls.scrim);
}

const closeTaskDrawer = () => hideDrawer(tEls.drawer, tEls.scrim);

/** 删除后的一致性检查（checkLine）在 views/tasks.js —— 三种返回形状都说成人话。 */

/**
 * 执行删除（或空跑）。一条请求过完服务端的四道闸：
 * 进程探测 → 备份 → 事务+外键 → VACUUM+自检。被拒时服务端说清卡在哪一步。
 */
/* 会话清理的确认串，与文件清理同一条规矩：输对之前按钮按不动。
   词由服务端给（见上面 confirmWords）。 */

async function callPurge(dryRun) {
  if (operationBusy) return;
  const d = taskState.data;
  const ids = [...taskState.sel];
  if (!d || !ids.length) return;

  operationBusy = true;
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
    operationBusy = false;
    if (dryRun) renderDryRun(data);
    else void finishPurge(data).catch(err => showToast(`无法显示清理结果：${esc(err.message)}`, { error: true }));
  } catch (err) {
    tEls.msg.className = 'drawer-msg is-err';
    tEls.msg.textContent = err.message;
  } finally {
    // 收尾时按确认串的真实状态恢复，不要无条件打开 —— 那会绕过刚加的门控
    operationBusy = false;
    tEls.go.disabled = taskWriteBlocked() || tEls.word.value !== TASK_PURGE_WORD();
    tEls.dryBtn.disabled = false;
    tEls.go.textContent = '删除';
  }
}

/** 空跑：逐库逐表摊开会删掉的行，数据库没有任何改动。
 *  行与文案的构造在 views/tasks.js（dryRunHtml，有契约测试）。 */
function renderDryRun(data) {
  const { rowsHtml, bodiesHtml, totalRows } = dryRunHtml(data);
  tEls.dryList.innerHTML = rowsHtml;
  tEls.dryWrap.hidden = false;
  tEls.msg.className = 'drawer-msg is-ok';
  tEls.msg.innerHTML =
    `空跑完成：共 <b>${totalRows.toLocaleString()}</b> 行，数据库没有任何改动。${bodiesHtml}` +
    `确认无误后输入「${TASK_PURGE_WORD()}」再删除。`;
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
    await load(true);
    if (!isAll() && !isAudit()) await loadTasks(true);
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
    for (const x of visibleTasks(taskState.data, { q: taskState.q, states: taskState.states, sort: taskState.sort })) {
      if (isPurgeable(x)) taskState.sel.add(x.id);
    }
    renderTaskList(); renderTaskFoot(); return;
  }
  if (t.closest('#taskClearSel')) {
    taskState.sel.clear(); renderTaskList(); renderTaskFoot(); return;
  }
  if (t.closest('#taskSkipPinned')) {
    tq.skipPinned = !tq.skipPinned; saveTqScope(); renderTaskQuick(); return;
  }
  if (t.closest('#taskQuickBtn')) {
    const s = taskQuickSetCall();
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
function taskWriteBlocked() {
  const d = taskState.data;
  return !d || d.readOnly || d.app?.running || d.app?.unknown;
}

function syncTaskWord() {
  if (operationBusy) return;
  const ok = tEls.word.value === TASK_PURGE_WORD();
  tEls.go.disabled = taskWriteBlocked() || !ok;
  // 与文件清理同一份提示逻辑；无输入且未输对时不动消息（上一条提示可能还在）
  if (ok || tEls.word.value.length) {
    tEls.msg.className = 'drawer-msg';
    tEls.msg.textContent = confirmWordHint(tEls.word.value, TASK_PURGE_WORD(), '删除');
  }
}
tEls.word.addEventListener('input', syncTaskWord);

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
