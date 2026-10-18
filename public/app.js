/* Agent Inspector —— 前端
 *
 * 一次只审一个 app：ZCode / Codex / Claude Code / Cursor 把东西存在四个完全不同的地方，
 * 分类表也各自一套。把四张表叠成一个总数只会骗人，所以顶栏那排标签决定下面每一块读谁的数据。
 */

const $ = (id) => document.getElementById(id);

const els = {
  rootPath: $('rootPath'), scanNote: $('scanNote'), rescanBtn: $('rescanBtn'), themeBtn: $('themeBtn'),
  appTabs: $('appTabs'),
  // 全域总览（"全部"模式）
  all: $('all'), allBytes: $('allBytes'), allSub: $('allSub'),
  allRecFigure: $('allRecFigure'), allRecBtn: $('allRecBtn'), allRecNote: $('allRecNote'),
  allApps: $('allApps'),
  projLede: $('projLede'), projList: $('projList'), projUnres: $('projUnres'),
  single: $('single'),
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
  scan: null,            // /api/scan 的原始返回：{ apps: [每个 app 一份视图], grand, ... }
  apps: [],              // 本次扫描到的 app 视图，按注册表顺序
  appId: null,           // 当前在看哪个 app；'' = 全域总览
  index: null,           // 当前 app 的那一份视图 —— 单工具渲染只读它；全域模式下为 null
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

/** 全域模式：一次看全部工具。这个取值不能与任何 app id 撞上。 */
const ALL = '';

/* 一个 app 可能有多个扫描目标（Cursor 的 ~/.cursor 与 App Support）。
   勾选、删除都要带上目标与 app，否则两个目标里的同名路径会互相冒名顶替。
   行上的 k 在 indexRows() 里预置好了；keyOf 只为尚未标过的临时对象兜底。 */
const keyOf = (f, appId) => f.k || `${appId !== undefined ? appId : (f.app ?? state.appId)}/${f.t}:${f.p}`;

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

async function load(refresh = false) {
  els.scanNote.textContent = '扫描中…';
  const res = await fetch('/api/scan' + (refresh ? '?refresh=1' : ''));
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  state.scan = await res.json();
  state.apps = state.scan.apps;
  // 每行在数据入手的这一刻就带上归属与稳定 key。之前靠 files.includes()
  // 反查 —— 抽屉里 3352 行 × 1.8 万文件是千万级比较，而这里一次写入零成本。
  indexRows();
  if (!state.apps.some((a) => a.app === state.appId)) state.appId = pickApp();
  applyApp();
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

/** 默认看谁：全域总览 → 上次看的单工具 → 第一个装了的。四个都没装也停在总览。 */
function pickApp() {
  try {
    const last = localStorage.getItem(APP_KEY);
    // ''（全域）是有效记忆：默认即管理视角
    if (last !== null) {
      if (last === ALL) return ALL;
      const hit = state.apps.find((a) => a.app === last && a.totals.files > 0);
      if (hit) return hit.app;
    }
  } catch {}
  return ALL;
}

/** 把渲染层切到当前 app 的那一份视图；全域模式下切走单工具视图。 */
function applyApp() {
  state.index = state.appId === ALL ? null : state.apps.find((a) => a.app === state.appId);
  state.selection.clear();
  state.group = null;   // 换 app，筛选也从头开始
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
  // 导航那四条指向单工具的区块（总览/清理/文件/任务）。全域模式下它们
  // 全部隐藏 —— 留着只会让人点进一片空白。
  document.body.dataset.mode = state.appId === ALL ? 'all' : 'single';
  if (state.index) {
    els.rootPath.textContent = state.index.targets.filter((t) => t.exists).map((t) => t.short).join(' + ')
      || `${state.index.label}：这台机器上没有`;
  } else {
    els.rootPath.textContent = '全部工具';
  }
  els.scanNote.textContent = `扫描用时 ${(state.scan.durationMs / 1000).toFixed(1)}s`;

  renderAppTabs();
  renderAll();
}

const APP_KEY = 'zci-app';

function renderAppTabs() {
  els.appTabs.innerHTML = `<button type="button" class="app-tab ${state.appId === ALL ? 'is-on' : ''}"
      role="tab" aria-selected="${state.appId === ALL}" data-app="${ALL}"
      title="所有工具的总占地、可回收总量与按项目横切">
      <span class="app-tab-name">全部</span>
      <span class="app-tab-size">${fmtBytes(state.scan.grand.bytes)}</span>
    </button>`
    + state.apps.map((a) => {
      const on = a.app === state.appId;
      const empty = a.totals.files === 0;
      return `<button type="button" class="app-tab ${on ? 'is-on' : ''}${empty ? ' is-empty' : ''}"
      role="tab" aria-selected="${on}" data-app="${esc(a.app)}"
      title="${esc(a.targets.map((t) => `${t.short}${t.exists ? '' : '（没有）'}`).join('、'))} · ${
        a.totals.files.toLocaleString()} 个文件">
      <span class="app-tab-name">${esc(a.label)}</span>
      <span class="app-tab-size">${empty ? '未安装' : fmtBytes(a.totals.bytes)}</span>
    </button>`;
    }).join('');
}

function catById(id) {
  const view = state.index;
  if (!view) return { id, label: id, status: 'warning', verdict: 'review' };
  return (view.catalog || view.categories).find((c) => c.id === id)
    || view.catalog[view.catalog.length - 1];
}

function filesOf(catId) {
  return state.byCat.get(catId) || [];
}

/* ── 首屏 ───────────────────────────────────────────────── */

/* ── 全域总览 ───────────────────────────────────────────── */

const summary = { data: null, at: 0 };
const projects = { data: null, at: 0, inflight: null };
const SUMMARY_MS = 15_000;
const PROJECTS_MS = 60_000;

/** 全域总量与"可回收"口径：复用 /api/scan 的缓存索引，轻。 */
async function loadSummary(force = false) {
  if (!force && summary.data && Date.now() - summary.at < SUMMARY_MS) return summary.data;
  const res = await fetch('/api/summary' + (force ? '?refresh=1' : ''));
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  summary.data = await res.json();
  summary.at = Date.now();
  return summary.data;
}

/** 项目横切：各工具的会话各扫一遍（服务端走缓存），慢，所以懒加载。 */
function loadProjects(force = false) {
  if (!force && projects.data && Date.now() - projects.at < PROJECTS_MS) {
    renderProjects(projects.data);
    return Promise.resolve(projects.data);
  }
  if (projects.inflight) return projects.inflight;
  projects.inflight = fetch('/api/projects' + (force ? '?refresh=1' : ''))
    .then(async (res) => {
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      projects.data = await res.json();
      projects.at = Date.now();
      return projects.data;
    })
    .finally(() => { projects.inflight = null; });
  return projects.inflight;
}

function renderGlobal() {
  loadSummary().then((s) => {
    // 换 tab 换得快了，晚到的旧响应要丢掉
    if (state.appId !== ALL) return;

    // 所有工具一个都没落盘：这屏不该显示 0 B 和一堆空条，而要直说"没有可审计的东西"。
    if (!s.apps.some((a) => a.installed)) {
      els.allBytes.textContent = '—';
      els.allSub.innerHTML =
        '这台机器上没找到任何一个 coding agent 的数据目录。' +
        '装过其中一个之后刷新，它们的落盘位置会出现在上面的标签里。';
      els.allRecFigure.textContent = '—';
      els.allRecNote.textContent = '';
      els.allRecBtn.disabled = true;
      els.allApps.innerHTML = s.apps.map((a) => `
        <div class="all-app is-empty">
          <span class="all-app-name">${esc(a.label)}</span>
          <span class="all-app-bar"><i style="width:0"></i></span>
          <span class="all-app-bytes">未安装</span>
          <span class="all-app-rec"></span>
        </div>`).join('');
      els.projLede.textContent = '没有数据目录可读取，因此没有可归并的会话。';
      els.projList.innerHTML = '';
      els.projUnres.hidden = true;
      return;
    }

    els.allRecBtn.disabled = false;
    els.allBytes.textContent = fmtBytes(s.grand.bytes);
    els.allSub.innerHTML =
      `${s.apps.length} 个工具共 <b>${s.grand.files.toLocaleString()}</b> 个文件、` +
      `<b>${s.grand.dirs.toLocaleString()}</b> 个目录。`;
    els.allRecFigure.textContent = fmtBytes(s.reclaimable);
    els.allRecNote.innerHTML = s.reclaimableExtra > 0
      ? `另有 <b>${fmtBytes(s.reclaimableExtra)}</b> 可清但默认没勾` +
        `（体积大或你可能正用着，切到具体工具里放回来）。`
      : '';
    els.allApps.innerHTML = s.apps.map((a) => {
      // 占比极小（Claude 的 28 MB 对 5 GB 就是 0.5%）时，纯按比例画会短到看不见。
      // 给一个 1.2% 的下限让"有这么一点"可被看见，但真实数值始终写在右边 ——
      // 条是示意，数字是事实。
      const pct = s.grand.bytes ? (a.bytes / s.grand.bytes) * 100 : 0;
      const width = a.installed && a.bytes > 0 ? Math.max(1.2, pct) : 0;
      return `
      <div class="all-app${a.installed ? '' : ' is-empty'}">
        <span class="all-app-name">${esc(a.label)}</span>
        <span class="all-app-bar"><i style="width:${width.toFixed(2)}%"></i></span>
        <span class="all-app-bytes">${a.installed ? fmtBytes(a.bytes) : '未安装'}</span>
        <span class="all-app-rec">${a.reclaimable ? '可清 ' + fmtBytes(a.reclaimable) : ''}</span>
      </div>`;
    }).join('');
  }).catch((err) => {
    els.allSub.innerHTML = `<b>读取失败：</b>${esc(err.message)}`;
  });

  // 项目横切懒加载：第一次进入总览才付读取四个会话库的代价。
  // 这一步在真机上约 2～4 秒（Cursor 的库 364 MB），所以不能只留一句静态的
  // "正在读取" —— 把已知道的东西先摆出来：几个工具、各自有多少会话。
  if (!projects.data) {
    const known = state.apps.filter((a) => a.targets.some((t) => t.exists));
    els.projLede.innerHTML = known.length
      ? `正在读取 ${known.length} 个工具的会话记录（${known.map((a) => esc(a.label)).join('、')}）…`
      : '正在读取各工具的会话…';
    els.projList.innerHTML = skeletonRows(known.length || 3);
    els.projUnres.hidden = true;
    loadProjects()
      .then(() => { if (state.appId === ALL) renderProjects(projects.data); })
      .catch((err) => {
        els.projLede.innerHTML = `<b>读取失败：</b>${esc(err.message)}`;
        els.projList.innerHTML = '';
      });
  } else {
    renderProjects(projects.data);
  }
}

/** 项目列表的加载占位：高度与真实行接近，加载完不会有整页跳动。 */
const skeletonRows = (n) => Array.from({ length: Math.min(n + 2, 6) },
  () => '<div class="proj-skel" aria-hidden="true"></div>').join('');

function renderProjects(d) {
  const total = d.totals;
  // 哪个工具的会话库读不出来，总量就会静默少一块 —— 这件事在任何
  // 渲染分支里都不能漏说，包括"一条会话都没有"的早退分支。
  const warnHtml = d.problems?.length
    ? d.problems.map((m) => `<p class="is-warn">${esc(m)}</p>`).join('')
    : '';
  // 一条会话都没读到：说清是"没有历史"而不是"归并失败"，这两件事该分开。
  if (!d.projects.length && !d.unresolvable.length) {
    els.projLede.innerHTML = warnHtml
      ? '没有读到任何会话 —— 见下面的原因。'
      : '没有读到任何会话。这些工具是装过的，但里面还没有可归并的历史记录。';
    els.projList.innerHTML = '';
    els.projUnres.hidden = !warnHtml;
    els.projUnres.innerHTML = warnHtml;
    return;
  }
  els.projLede.innerHTML =
    `<b>${total.projects}</b> 个项目、<b>${total.sessions.toLocaleString()}</b> 条会话，` +
    `正文合计 <b>${fmtBytes(total.bytes)}</b>。同一项目在多个工具里的残留归在一起 —— ` +
    `点一行展开看是哪些工具、各留了多少。`;
  if (!d.projects.length) {
    els.projList.innerHTML = '<p class="empty">没有能按项目归并的会话 —— 它们都缺工作区信息，见下面那一段。</p>';
  } else {
    els.projList.innerHTML = d.projects.map((p) => `
      <div class="proj" data-proj="${esc(p.key)}">
        <button class="proj-head" type="button" aria-expanded="false">
          <span class="proj-path" title="${esc(p.path || p.label)}">${esc(p.path || p.label)}</span>
          <span class="proj-apps">${
            // 用 app 的显示名而不是内部 id：这一行读起来是"ZCode 23 · Codex 5"，
            // 和页面其它地方对得上。
            p.apps.map((a) => `<i title="${esc(a.appLabel)}：${a.sessions} 条会话">${
              esc(a.appLabel)} ${a.sessions}</i>`).join('')
          }</span>
          <span class="proj-bytes">${fmtBytes(p.bytes)}</span>
          <span class="proj-caret" aria-hidden="true"></span>
        </button>
        <div class="proj-body" hidden></div>
      </div>`).join('');
  }
  if (d.unresolvable.length) {
    els.projUnres.hidden = false;
    els.projUnres.innerHTML =
      `<p>另有 <b>${d.unresolvable.length}</b> 组会话无法归并（共 ${fmtBytes(
        d.unresolvable.reduce((s, u) => s + u.bytes, 0))}）：` +
      `${d.unresolvable.slice(0, 6).map((u) => esc(u.label)).join('、')}` +
      `${d.unresolvable.length > 6 ? ' 等' : ''}。` +
      `Cursor 窗口没开过文件夹、Claude 会话首行读不到 cwd 时就会这样 —— 猜一个项目名比不猜更糟。</p>`;
  } else {
    els.projUnres.hidden = true;
  }
  // 某个工具的会话库读不出来时，总量会静默变小 —— 必须让人知道少了谁。
  if (warnHtml) {
    els.projUnres.hidden = false;
    els.projUnres.innerHTML += warnHtml;
  }
}

/** 展开一个项目：列出它下面所有工具的会话。展开是纯粹的本地动作，不再打接口。 */
function toggleProject(key) {
  const d = projects.data;
  const p = d && d.projects.find((x) => x.key === key);
  if (!p) return;
  const wrap = els.projList.querySelector(`[data-proj="${CSS.escape(key)}"]`);
  if (!wrap) return;
  const body = wrap.querySelector('.proj-body');
  const head = wrap.querySelector('.proj-head');
  const opening = body.hidden;
  body.hidden = !opening;
  head.setAttribute('aria-expanded', String(opening));
  wrap.classList.toggle('is-open', opening);
  if (!opening) return;

  // 会话清理分两条线：库里按行删（ZCode/Codex 的会话）与删正文文件
  // （Claude 的全部、Codex 的残骸）。项目卡片不把两者搅进一个按钮 ——
  // 这里只列出"能做什么"，每件事都从它自己的入口走。
  const residual = p.tasks.filter((t) => t.residual);
  const rows = p.tasks.map((t) => {
    const clean = t.reason != null;
    return `<div class="proj-task${clean ? '' : ' is-locked'}">
      <span class="ptask-app">${esc(t.appLabel)}</span>
      <span class="ptask-title" title="${esc(t.title)}">${esc(t.title)}</span>
      <span class="ptask-state">${esc(clean ? (REASON_LABEL[t.reason] || t.reason) : (STATE_META_CN[t.state] || t.state))}</span>
      <span class="ptask-bytes">${fmtBytes(t.bytes || 0)}</span>
    </div>`;
  }).join('');

  const perApp = [...new Set(p.tasks.map((t) => t.appId))]
    .map((id) => `<button class="btn btn-ghost btn-sm" data-gotoapp="${esc(id)}" type="button">${
      esc((state.apps.find((a) => a.app === id) || {}).label || id)} 里查看</button>`).join('');

  // 行级清理的候选：带 reason 的 ZCode/Codex 会话（库里真有行可删）。
  // Claude 全部、Cursor 全部、残骸都不在此列 —— 它们没有"行"，各走各的线。
  const rowPurgeable = p.tasks.filter((t) => t.reason != null && !t.residual &&
    rowPurgeableLine(t.appId) === 'db');
  const rowBytes = rowPurgeable.reduce((s, t) => s + (t.bytes || 0), 0);

  body.innerHTML = `
    <div class="proj-tasks">${rows}</div>
    <div class="proj-actions">
      ${rowPurgeable.length
        ? `<button class="btn btn-primary btn-sm" data-projrows="${esc(key)}" type="button">按行清理会话库（${
            rowPurgeable.length} 条 · ${fmtBytes(rowBytes)}）</button>`
        : ''}
      ${residual.length
        ? `<button class="btn btn-ghost btn-sm" data-projfiles="${esc(key)}" type="button">清掉 ${
            residual.length} 个残留文件（${fmtBytes(residual.reduce((s, t) => s + (t.bytes || 0), 0))}）</button>`
        : ''}
      ${perApp}
    </div>
    <p class="proj-note">带状态的（已删除 / 已归档 / 残骸）说明界面上已经不用了。` +
      `「按行清理」跨工具编排进一个确认流：进程探测、备份、事务删除、VACUUM 与自检` +
      `照单工具同一套四道闸走，逐工具分批执行。</p>`;
}

/** 这个 app 的会话清理走哪条线：'db' = 库里有行可删，'files' = 正文即文件，null = 只读。 */
function rowPurgeableLine(appId) {
  const a = state.apps.find((x) => x.app === appId);
  if (!a) return null;
  if (a.writable === false) return null;
  return a.history === 'claude-files' ? 'files' : 'db';
}

/**
 * 把一个项目里各工具可按行清理的会话，编排进同一个任务抽屉。
 *
 * taskState.data 换成一个合成的跨 app 视图：tasks 来自多个工具、
 * 按 app 分组挂在 batches 上。抽屉的文案、空跑、确认串全部复用 ——
 * 只有 callPurge 知道要按 app 分批发请求。
 */
function pickProjectRows(key) {
  const d = projects.data;
  const p = d && d.projects.find((x) => x.key === key);
  if (!p) return;

  const picked = p.tasks.filter((t) => t.reason != null && !t.residual &&
    rowPurgeableLine(t.appId) === 'db');
  if (!picked.length) return;

  // 按 app 分组，保留每个工具自己的 db 形状（ZCode 的 main/index、Codex 的 dbs/bodies）
  const byApp = new Map();
  for (const t of picked) {
    if (!byApp.has(t.appId)) byApp.set(t.appId, []);
    byApp.get(t.appId).push(t);
  }

  const label = p.path ? p.path.split('/').pop() || p.path : (p.label || '该项目');
  taskState.data = {
    // 合成视图的标记：callPurge 看到它就走多 app 分批；单工具路径不变
    crossApp: true,
    projectKey: key,
    appId: [...byApp.keys()].join('+'),
    appLabel: [...new Set(picked.map((t) => t.appLabel))].join('、'),
    backupDir: null,       // 由每个 app 的 /api/tasks 返回自带
    db: {},                // 逐 app 的库信息在抽屉文案里按 app 拼
    batches: [...byApp.entries()].map(([appId, tasks]) => ({
      appId,
      appLabel: tasks[0].appLabel,
      ids: tasks.map((t) => t.id),
      count: tasks.length,
      bytes: tasks.reduce((s, t) => s + (t.bytes || 0), 0),
    })),
    tasks: picked,
    totals: {
      count: picked.length,
      bytes: picked.reduce((s, t) => s + (t.bytes || 0), 0),
      rows: picked.reduce((s, t) => s + (t.rows || 0), 0),
      byState: [],
    },
    app: { running: false, hits: [] },   // 逐 app 探测在 callPurge 内做；这里只影响按钮初态
    readOnly: false,
    fileBased: false,
    projectName: label,
  };
  taskState.sel = new Set(picked.map((t) => t.id));

  openTaskDrawer();
  // 任务面板的 lede/warn 是按单工具写的；项目卡片借走时同步成编排的说法，
  // 否则屏幕上还是"总览模式下不读会话库"那句旧话。
  renderTasks();
  // 抽屉的"运行中"判断读 taskState.data.app.running —— 合成视图先按未运行渲染，
  // 真实探测结果由空跑/删除前的逐 app 检查给出并回填。
}

/** 把一个项目下的残骸会话映射成文件勾选，走文件清理那条线（废纸篓/彻底删除）。 */
function pickProjectResiduals(key) {
  const d = projects.data;
  const p = d && d.projects.find((x) => x.key === key);
  if (!p) return;
  state.selection.clear();
  let n = 0;
  for (const t of p.tasks) {
    if (!t.residual || !t.bodyRel) continue;
    const view = state.apps.find((a) => a.app === t.appId);
    if (!view) continue;
    // bodyRel 的基准因 app 而异：Codex 相对 ~/.codex（ sessions/… ），
    // Claude 的会话视图却把 projects/ 当前缀剥掉了（见 tasks-claude.mjs）——
    // 两种都试一次。查的是预建的 key 表，不再线性扫文件数组。
    const rootKey = view.targets[0].key;
    const f = state.fileByKey.get(`${t.appId}/${rootKey}:${t.bodyRel}`)
      || state.fileByKey.get(`${t.appId}/${rootKey}:projects/${t.bodyRel}`);
    if (f) { state.selection.add(f.k); n += 1; }
  }
  if (!n) {
    els.projLede.innerHTML = '<b>这些残骸在文件清单里找不到对应文件</b> —— 目录大概变了，点「重新扫描」再来。';
    return;
  }
  renderActionbar();
  openDrawer();
}

/** 全域"清理推荐"：把各工具的 recommend 分类文件全勾上，打开同一个确认抽屉。 */
async function pickAllRecommended() {
  state.selection.clear();
  let count = 0;
  for (const a of state.apps) {
    if (a.totals.files === 0) continue;
    // 口径与单工具的"推荐清理"完全一致：recommend && !recommendDefaultOff。
    // 全域模式下没有 recOff 的覆盖 —— 让人先看见全量再决定，恰是这个按钮的意义。
    const want = new Set(a.catalog.filter((c) => c.recommend && !c.recommendDefaultOff).map((c) => c.id));
    for (const f of a.files) {
      if (!want.has(f.c)) continue;
      state.selection.add(keyOf(f));
      count += 1;
    }
  }
  if (!count) {
    els.allRecNote.innerHTML = '所有工具都没有可推荐清理的内容。';
    return;
  }
  renderActionbar();
  openDrawer();
}

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
    const selCount = all.filter((f) => state.selection.has(keyOf(f))).length;
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
  const on = state.selection.has(keyOf(f));
  const protectedRow = cat.verdict === 'never';
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
  return `<div class="row ${on ? 'is-on' : ''}">
    <input type="checkbox" data-key="${esc(keyOf(f))}" ${on ? 'checked' : ''}
      ${protectedRow ? 'disabled aria-label="受保护内容"' : ''}>
    <span class="row-path" title="${esc(targetShort(f.t)) + '/' + esc(f.p)}">
      <span class="row-dir">${esc(dir)}</span><b class="row-name">${esc(name)}</b>${tTag}${sidTag}
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
const appLabelOfRow = (f) => (state.apps.find((a) => a.app === appIdOfRow(f)) || {}).label || '';
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
  const rows = allFiles().filter((f) => state.selection.has(keyOf(f)));
  if (!rows.length) return;
  const bytes = rows.reduce((s, f) => s + f.s, 0);
  const biggest = rows.reduce((a, b) => (a.s >= b.s ? a : b), rows[0]);

  els.drawerStats.innerHTML = `
    <div class="dstat"><span>条目</span><b>${rows.length.toLocaleString()}</b></div>
    <div class="dstat"><span>合计</span><b>${fmtBytes(bytes)}</b></div>
    <div class="dstat"><span>最大一项</span><b title="${esc(
      (state.appId === ALL ? appLabelOfRow(biggest) + ' · ' : '') + rowTitle(biggest))}">${fmtBytes(biggest.s)}</b></div>`;

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
    // 跨 app 时必须说清这一行是谁的：不同工具的相同路径名不是同一个东西
    const appTag = state.appId === ALL ? appLabelOfRow(f) + '/' : '';
    return `<li title="${esc(rowTitle(f))}">
      <span class="dl-path"><span class="row-dir">${esc(appTag + dir)}</span><b>${esc(name)}</b></span>
      <span>${fmtBytes(f.s)}</span></li>`;
  }).join('')
    + (rows.length > 300
        // 截断的只是这张预览表，不是删除范围 —— 不写清楚，人会以为剩下的不删。
        ? `<li class="drawer-more"><span>下面还有 ${(rows.length - 300).toLocaleString()} 项没列出来` +
          `（这张表只列最大的 300 项），<b>它们同样在这次的删除范围里</b>。</span><span></span></li>`
        : '');
  els.drawerListCount.textContent = `${rows.length.toLocaleString()} 项`;

  els.drawerMsg.textContent = '';
  els.drawerMsg.className = 'drawer-msg';
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
  const batches = selectedByTarget();   // [[target, paths], …] —— 跨目标时分几次发
  const purge = mode() === 'purge';
  if (!batches.length) return;
  if (purge && els.purgeWord.value !== '彻底删除') {
    els.drawerMsg.textContent = '确认串不正确，请输入「彻底删除」四个字。';
    els.drawerMsg.className = 'drawer-msg is-err';
    return;
  }

  els.drawerGo.disabled = true;
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
    } else {
      els.drawerMsg.className = 'drawer-msg is-ok';
      els.drawerMsg.textContent = purge
        ? `已彻底删除 ${done.length} 项。`
        : `已把 ${done.length} 项移入废纸篓，可在 Finder 的「废纸篓」中恢复。`;
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

/** 在 Finder 中显示：key 就是 "app/目标:路径"，直接查表，不再线性扫全部文件。 */
async function revealPath(key) {
  const f = state.fileByKey?.get(key);
  if (!f) return;
  await fetch('/api/reveal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: appIdOfRow(f), target: f.t, path: f.p }),
  });
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
  // 全域模式与单工具模式渲染的是两套 DOM：前者是总量 + 项目横切，
  // 后者是某一个工具的分类表与清单。二者不会同时可见。
  els.all.hidden = state.appId !== ALL;
  els.single.hidden = state.appId === ALL;
  if (state.appId === ALL) { renderGlobal(); renderActionbar(); return; }
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
    const picked = can.filter((f) => state.selection.has(keyOf(f)));
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

  // 换 app / 切全域：分类表、清单、历史会话整条线跟着换
  const tab = t.closest('[data-app]');
  if (tab) {
    if (tab.dataset.app === state.appId) return;
    state.appId = tab.dataset.app;
    applyApp();
    loadTasks();
    document.getElementById(state.appId === ALL ? 'all' : 'overview')
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // 全域"清理推荐"：各工具的 recommend 全勾上进抽屉
  if (t.closest('#allRecBtn')) { pickAllRecommended(); return; }

  // 项目横切：展开/收起一行的会话明细
  const projHead = t.closest('.proj-head');
  if (projHead) { toggleProject(projHead.closest('[data-proj]').dataset.proj); return; }

  // 项目内：跳到对应工具看它的会话；或把残骸勾上进文件清理；或跨工具按行清理
  const gotoApp = t.closest('[data-gotoapp]');
  if (gotoApp) {
    const tab = els.appTabs.querySelector(`[data-app="${CSS.escape(gotoApp.dataset.gotoapp)}"]`);
    if (tab) tab.click();
    return;
  }
  const projFiles = t.closest('[data-projfiles]');
  if (projFiles) { pickProjectResiduals(projFiles.dataset.projfiles); return; }
  const projRows = t.closest('[data-projrows]');
  if (projRows) { pickProjectRows(projRows.dataset.projrows); return; }

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
    const protectedIds = new Set(state.index.categories.filter((c) => c.verdict === 'never').map((c) => c.id));
    const mine = state.index.files.filter((f) => groupOf(f) === g && !protectedIds.has(f.c));
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
      for (const f of filesOf(c.id)) state.selection.add(keyOf(f));
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
      if (cat.verdict === 'never') continue;   // 受保护内容不进全选
      for (const f of files) state.selection.add(keyOf(f));
    }
    renderSplit(); renderGroups(); renderActionbar(); return;
  }
  if (t.closest('#rescanBtn')) {
    els.rescanBtn.disabled = true;
    // 全域视图的两份数据各有自己的 TTL；重新扫描必须把它们一起作废，
    // 否则总览上的数字会比下面的清单旧一分钟。
    summary.data = null;
    projects.data = null;
    await load(true);
    await loadTasks(true);
    if (state.appId === ALL) renderAll();
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
  // 全域模式下文件清单整块隐藏着，聚焦一个看不见的输入框只会让人困惑。
  const inSingle = state.appId !== ALL;
  if (e.key === '/' && inSingle && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault(); els.search.focus(); els.search.select();
  }
  if (e.key === 'Escape') {
    if (!els.drawer.hidden) closeDrawer();
    else if (!tEls.drawer.hidden) closeTaskDrawer();
    else if (inSingle && document.activeElement === els.search) {
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

const taskState = { data: null, sel: new Set(), q: '', states: new Set(), sort: 'size', group: false, foldedWs: new Set() };

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
};
const REASON_TONE = {
  deleted: 'st-serious', archived: 'st-warning', wsMissing: 'st-serious',
  untracked: 'st-serious', bodyMissing: 'st-serious', empty: 'st-serious',
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

async function loadTasks(refresh = false) {
  const appId = state.appId;
  const view = state.index;
  taskState.data = null;
  taskState.sel.clear();
  taskState.states.clear();
  tEls.warn.hidden = true;
  tEls.comp.hidden = true;
  tEls.foot.hidden = true;
  tEls.list.innerHTML = '';

  // 全域模式没有"某一个工具"的会话面板：任务区直接说去看哪个工具
  if (!view) {
    tEls.lede.textContent = '总览模式下不读会话库 —— 切到具体工具后这里显示它的历史会话。';
    tEls.dbBar.innerHTML = '';
    tEls.chips.innerHTML = '';
    renderTaskFoot();
    renderTaskQuick();
    return;
  }

  if (!view.targets.some((t) => t.exists)) {
    tEls.lede.textContent = `${view.label} 在这台机器上没有数据目录。`;
    return;
  }
  tEls.lede.textContent = `正在读取 ${view.label} 的会话记录…`;
  try {
    const res = await fetch(`/api/tasks?app=${encodeURIComponent(appId)}` + (refresh ? '&refresh=1' : ''));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    // 换 app 换得快了，晚到的旧响应要丢掉
    if (state.appId !== appId || data.appId !== appId) return;
    taskState.data = data;
    renderTasks();
  } catch (err) {
    if (state.appId !== appId) return;
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

const fileBasedNote = (who) =>
  `${icon('doc')}<div>${esc(who)} 的会话正文就是 <code>projects/</code> 下的 <code>.jsonl</code> 文件本身，` +
  `没有数据库行可删。这里勾选后走<b>文件清理</b>那条线：默认进废纸篓，可随时恢复。</div>`;

function renderTasks() {
  const d = taskState.data;
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
    if (d?.fileBased) {
      tEls.warn.hidden = false;
      tEls.warn.className = 'app-warn is-ok';
      tEls.warn.innerHTML = fileBasedNote(d.appLabel);
    }
    return;
  }
  const who = d.appLabel;

  const del = d.totals.byState.find((g) => g.state === 'deleted');
  const text = d.totals.bytes;

  // 跨 app 合成视图：这一屏的任务面板被项目卡片借去展示编排批次，
  // 说法与单工具不同 —— 它不是"某个工具的会话库"，是"这个项目在各工具里的残留"。
  if (d.crossApp) {
    tEls.lede.innerHTML =
      `<b>${esc(d.projectName)}</b> 在 ${d.batches.length} 个工具里共 ` +
      `<b>${d.totals.count}</b> 条可清理会话、<b>${fmtBytes(d.totals.bytes)}</b> 正文。` +
      `仍被工具界面使用的不会出现在这里。`;
    tEls.warn.hidden = false;
    tEls.warn.className = 'app-warn is-ok';
    tEls.warn.innerHTML = `${icon('box')}<div>跨工具清理按工具<b>逐个</b>执行：每个工具独立过` +
      `进程探测 → 备份 → 事务删除 → VACUUM → 自检。哪个工具正开着，就只卡那一步，` +
      `其余照常完成。</div>`;
    tEls.dbBar.innerHTML = '';
    tEls.comp.hidden = true;
    renderTaskChips();
    renderTaskList();
    renderTaskFoot();
    renderTaskQuick();
    renderComposition();
    return;
  }

  // Codex 是两段式存储：库里只有索引和投影，正文在 sessions/ 的 rollout 文件里。
  // 那句话要是照抄 ZCode 的说法，就成了"158 MB 的库装着 581 MB 的正文"。
  tEls.lede.innerHTML = d.readOnly
    ? (d.composition
        // Cursor：正文在库里，按键族摊开
        ? `${esc(who)} 的会话库 <b>${fmtBytes(d.db.total)}</b>，读到 <b>${d.totals.count}</b> 个会话、` +
          `<b>${fmtBytes(text)}</b> 的正文。下面按键族摊开这 ${fmtBytes(d.db.total)} 到底是怎么分的。`
        // Gemini：正文在云端，本机只有摘要索引
        : `${esc(who)} 的会话索引 <b>${fmtBytes(d.db.total)}</b>，读到 <b>${d.totals.count}</b> 条会话的摘要。` +
          `正文在云端，本机没有可回收的会话数据 —— 这里只告诉你有什么、归哪个项目。`)
    : d.db.bodies
      ? `${esc(who)} 的会话分两处存：索引库 <b>${fmtBytes(d.db.total)}</b>，` +
        `正文文件 <b>${fmtBytes(d.db.bodies.bytes)}</b>（<b>${d.db.bodies.count}</b> 个 rollout 文件）。` +
        `读到 <b>${d.totals.count}</b> 个会话。`
      : `会话库 <b>${fmtBytes(d.db.total)}</b>，装着 <b>${d.totals.count}</b> 个任务、` +
        `<b>${fmtBytes(text)}</b> 的正文。` +
        (del
          ? `其中 <b>${del.count}</b> 个已在界面上删除，仍占 <b>${fmtBytes(del.bytes)}</b>。`
          : '');

  // 动手之前的前提，三个 app 三种说法 —— 都从后端的能力标记来，不在前端猜
  tEls.warn.hidden = false;
  if (d.readOnly) {
    // 只读的理由由各适配器给（Cursor 与 Gemini 的"为什么不能删"完全不同），
    // 前端不按 app 名硬编码。
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
  const total = (d.db.total || 1) + bodies;
  const byState = d.totals.byState.map((g) => ({
    label: STATE_META_CN[g.state], bytes: g.bytes, tone: STATE_TONE[g.state], key: g.state,
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
  deleted: '已删除任务', archived: '已归档任务', active: '活跃任务',
  untracked: '界面不可见', empty: '空文件',
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
  tEls.purgeBtn.title = d?.crossApp
    ? `跨 ${d.batches.length} 个工具按行清理这 ${count} 条会话：逐工具探测进程、备份、删除、自检`
    : d?.fileBased
      ? `把这 ${count} 个会话的正文文件交给文件清理：默认移入废纸篓`
      : running
        ? `${d?.appLabel || '应用'} 正在运行：可以先空跑核对，但要完全退出它才能删除`
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
    `${esc(d.appLabel)} 界面上你删过的 <b>${del.count}</b> 个任务。它的"删除"只是打个标记 —— ` +
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
    if (f) state.selection.add(keyOf(f));
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
       <div class="dstat"><span>涉及工具</span><b>${d.crossApp ? d.batches.length : 1}</b></div>
       <div class="dstat"><span>正文合计</span><b>${fmtBytes(bytes)}</b></div>`;

  // 会写到哪几个库，由后端报的路径决定 —— 各工具不一样，前端不硬编码文件名
  if (d.crossApp) {
    // 跨 app：逐工具说一句写哪里、备份到哪。库路径要等各 app 的 /api/tasks
    // 才有 —— 合成视图里没有，就按工具名给原则，细节空跑时摊开。
    tEls.note.innerHTML =
      `这一批横跨 <b>${d.batches.length}</b> 个工具（${esc(d.batches.map((b) => b.appLabel).join('、'))}），` +
      `将按工具<b>逐个</b>执行：每个工具独立过进程探测 → 备份 → 事务删除 → VACUUM → 自检，` +
      `任何一个被拒绝（比如它还开着）就停在那里，已完成的工具不受影响。` +
      `确认串只需要输一次。`;
  } else {
    const dbFiles = (d.db.dbs || [d.db.main, d.db.index].filter(Boolean))
      .map((x) => shortPath(x.path));
    const dbsTxt = dbFiles.map((p) => `<code>${esc(p)}</code>`).join(' 和 ');
    const backupTxt = `动手前会把库完整备份到 <code>${esc(shortPath(d.backupDir))}</code>。`;
    tEls.note.innerHTML = d.app.running
      ? `<b>${esc(who)} 仍在运行</b>，现在不能删除。请完全退出 ${esc(who)} 后重新打开本页。`
      : `删除会把这些会话的行从 ${dbsTxt} 里彻底移除，` +
        `随后 <code>VACUUM</code> 重建数据库把空间真正交还给磁盘。${backupTxt}` +
        // Codex 的正文是磁盘上的 rollout 文件，行级删除碰不到它 —— 不说清楚，
        // 用户会以为回收的数字偏小是工具没干活。
        (d.db.bodies
          ? `但 <b>Codex 的正文不在这些库里</b>：它存在 <code>sessions/</code> 的 rollout 文件里，` +
            `这里只抹索引行。文件要等索引里再也没有它们，才会变成孤儿、归「文件清单」那条线清理。`
          : `<b>正文合计只是下限</b> —— 实际回收通常更多，因为索引也会一起收缩。`);
  }

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
}

const closeTaskDrawer = () => { tEls.scrim.hidden = true; tEls.drawer.hidden = true; };

const ROW_LABEL = {
  session: '会话', message: '消息', part: '附件块', model_usage: '模型调用',
  turn_usage: '回合', tool_usage: '工具调用', todo: '待办', session_entry: '会话条目',
  session_input: '输入队列', session_target: '会话目标', session_task_link: '任务链',
  input_history: '输入历史',
};

/** 删除后的一致性检查：ZCode 一个库给一个结论，Codex 逐库给一组 —— 都说成人能读的一行。 */
function checkLine(data) {
  if (!Array.isArray(data.integrity)) {
    return `完整性 ${data.integrity}，外键违规 ${data.fkViolations}。`;
  }
  const bad = data.integrity.filter((r) => r.integrity !== 'ok' || r.fkViolations);
  if (!bad.length) return `${data.integrity.length} 个库完整性全部 ok，外键违规 0。`;
  return data.integrity.map((r) => `${r.name} ${r.integrity}/违规 ${r.fkViolations}`).join('，') + '。';
}

/**
 * 执行删除（或空跑）。单工具走一条请求；跨 app 合成视图按批次逐个发 ——
 * 每批独立过服务端的四道闸（进程探测 → 备份 → 事务+外键 → VACUUM+自检），
 * 任一批被拒就停下：后面的工具还没动，人看到的是"走到哪、卡在哪"。
 */
async function callPurge(dryRun) {
  const d = taskState.data;
  const batches = d.crossApp
    ? d.batches
    : [{ appId: state.appId, appLabel: d.appLabel, ids: [...taskState.sel] }];
  const idsOf = (b) => d.crossApp ? b.ids : [...taskState.sel];

  tEls.go.disabled = true;
  tEls.dryBtn.disabled = true;
  tEls.msg.className = 'drawer-msg';
  tEls.msg.textContent = dryRun ? '正在空跑核对…' : '正在备份、删除并重建数据库…可能要几十秒';
  if (!dryRun) tEls.go.textContent = '处理中…';

  try {
    const results = [];
    for (const b of batches) {
      const res = await fetch('/api/tasks/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dryRun
          ? { app: b.appId, ids: idsOf(b), dryRun: true }
          : { app: b.appId, ids: idsOf(b), confirm: tEls.word.value }),
      });
      const data = await res.json();
      // 任一批被拒就停：后面的工具还没动。报错里带上工具名，人知道卡在谁那里。
      if (!res.ok) {
        if (results.length) {
          results.push({ appLabel: b.appLabel, ok: false, error: data.error || res.statusText });
          throw new CrossAppError(results, b.appLabel);
        }
        throw new Error(data.error || res.statusText);
      }
      results.push({ appLabel: b.appLabel, appId: b.appId, ok: true, data });
      // 已完成一批就更新进度，几十秒的等待里让人看见走到哪了
      tEls.msg.textContent = dryRun
        ? `空跑核对中… ${results.filter(r => r.ok).length}/${batches.length}（${b.appLabel} 完成）`
        : `处理中… ${results.filter(r => r.ok).length}/${batches.length}（${b.appLabel} 完成）`;
    }

    if (dryRun) renderCrossDryRun(results);
    else await finishCrossPurge(results);
  } catch (err) {
    tEls.msg.className = 'drawer-msg is-err';
    if (err instanceof CrossAppError) {
      const done = err.results.filter((r) => r.ok);
      tEls.msg.innerHTML = err.dryRun
        ? `空跑在 <b>${esc(err.stoppedAt)}</b> 处停下：${esc(err.lastError)}<br>` +
          (done.length ? `此前已核对：${done.map((r) => esc(r.appLabel)).join('、')}（无任何改动）。` : '')
        : `<b>${esc(err.stoppedAt)} 被拒绝</b>：${esc(err.lastError)}<br>` +
          (done.length
            ? `已完成的：${done.map((r) => esc(r.appLabel)).join('、')}（各自备份、各自自检）。` +
              `刷新后再来，已完成的那几个不会再出现在候选里。`
            : '第一个工具就被拒绝，没有任何改动。');
    } else {
      tEls.msg.textContent = err.message;
    }
  } finally {
    tEls.go.disabled = false;
    tEls.dryBtn.disabled = false;
    tEls.go.textContent = '删除';
  }
}

/** 跨 app 批处理的中途失败：带着已完成的部分与卡住的位置抛出。 */
class CrossAppError extends Error {
  constructor(results, stoppedAt) {
    super(`在 ${stoppedAt} 处被拒`);
    this.results = results;
    this.stoppedAt = stoppedAt;
    this.lastError = results[results.length - 1]?.error || '';
    this.dryRun = false;
  }
}

/** 跨 app 空跑：逐工具摊开各自会删的行，与单工具同一版面。 */
function renderCrossDryRun(results) {
  let html = '';
  let totalRows = 0;
  for (const r of results) {
    const { data } = r;
    const rows = Array.isArray(data.perDb)
      ? data.perDb.map((x) => [`${x.table}（${x.name}）`, x.count ?? x.deleted])
      : Object.entries(data.counts || {}).filter(([, n]) => n > 0)
          .map(([k, n]) => [ROW_LABEL[k] || k, n]);
    const n = rows.reduce((s, [, c]) => s + c, 0);
    totalRows += n;
    html += `<li class="dry-head"><span>${esc(r.appLabel)}：${n.toLocaleString()} 行</span><span></span></li>`
      + rows.map(([k, c]) => `<li><span>　${esc(k)}</span><span>${c.toLocaleString()}</span></li>`).join('');
  }
  tEls.dryList.innerHTML = html;
  tEls.dryWrap.hidden = false;
  tEls.msg.className = 'drawer-msg is-ok';
  tEls.msg.textContent = `空跑完成：${results.length} 个工具共 ${totalRows.toLocaleString()} 行，数据库没有任何改动。确认无误后输入「清理」再删除。`;
}

/** 跨 app 删除完成：逐工具汇报回收量与完整性，然后刷新两边的视图。 */
async function finishCrossPurge(results) {
  const perApp = results.map((r) => {
    const { data } = r;
    return `<li><span>${esc(r.appLabel)}</span><span>${
      fmtBytes(data.before.total)} → ${fmtBytes(data.after.total)}，回收 ${fmtBytes(data.freed)}</span></li>`;
  }).join('');
  const totalFreed = results.reduce((s, r) => s + (r.data.freed || 0), 0);
  tEls.msg.className = 'drawer-msg is-ok';
  tEls.msg.innerHTML =
    `完成，回收 <b>${fmtBytes(totalFreed)}</b>。<ul class="cross-result">${perApp}</ul>` +
    `每个工具各自备份、各自过完整性检查。`;
  await loadTasks(true);
  await load(true);          // 库变小了，文件清单也要重算
  // 项目横切的数据也过时了：作废缓存，下次进总览重算
  projects.data = null;
  projects.at = 0;
  summary.data = null;
  summary.at = 0;
  if (state.appId === ALL) renderGlobal();
  renderTasks();
  setTimeout(closeTaskDrawer, 3000);
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
