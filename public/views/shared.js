/**
 * 视图层的共享原语。
 *
 * 这里的每个函数都是**纯的**：入参给出全部输入，返回字符串或数字，
 * 不读全局 state、不碰 DOM。这样 node --test 能直接拿夹具调它们、
 * 断言产出的 HTML，而不需要一个假 DOM。
 *
 * 为什么要做到这一步：原来的渲染函数散在 app.js 里，同时读 state、
 * 往 els.* 上写、又返回字符串，三者混在一起。测试只能靠"在源码里
 * 找某个字符串"来间接检查，于是任何一次重排都会让测试变红，而
 * 界面行为其实没变 —— 测试保护的是"上次是怎么写的"。
 */

/* 体积换算只该有一份实现 —— 它在 logic.js 里，带单测。
   re-export 给外部，本地用 fmtBytesLocal 别名。 */
import { fmtBytes as fmtBytesLocal } from '../logic.js';
/* 各家 Agent 的品牌标识（simple-icons，CC0）。单独一个文件：
   那五段 path 加起来 5KB 多，混在原语里会把真正在用的代码挤下去。 */
import { BRAND_ICONS } from './brand-icons.js';

/** HTML 转义。名字短是为了让模板串读起来还像 HTML。 */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 体积与日期的格式化**故意不在这里**。
 *
 * 它们已经在 public/logic.js（fmtBytes，带单测）与 app.js（bytesTip /
 * bytesWithExact / shortPath / fmtDate）里各有一份，且细节不同：
 * 比如 shortPath 只把 `/Users/<name>` 缩成 `~`，而"中间省略"是另一套语义。
 * 复制到这一层会立刻产生第二份实现，之后改一处忘另一处 —— 正是这个重构
 * 要消灭的东西。所以这里只管视图独有的部分。
 */

/* ── 体积的展示形态 ───────────────────────────────────────── */

/* 体积换算只该有一份实现 —— 它在 logic.js 里，带单测。 */
export { fmtBytes } from '../logic.js';

/** 悬停提示：完整字节数。
 *  磁盘审计的数最后要跟 `du` 对得上 —— "1.40 GB" 对不上，
 *  "1,502,341,376 字节" 才对得上。所以凡是拿来核对的体积都挂这个。 */
export const bytesTip = (n) => `${Number(n || 0).toLocaleString()} 字节`;

/** 正文里的体积：加粗 + 悬停给精确字节数。 */
export const bytesB = (n) => `<b title="${bytesTip(n)}">${fmtBytesLocal(n)}</b>`;

/** 带精确字节数的体积片段 —— toast 里所有数字都走它。 */
export const bytesWithExact = (n) => `<b title="${n.toLocaleString()} 字节">${fmtBytesLocal(n)}</b>`;

/* ── 字体排版辅助：路径与日期 ─────────────────────────────── */

/** 把家目录缩成 ~。只缩第一段，其余原样保留。 */
export const shortPath = (p) => (p || '').replace(/^\/Users\/[^/]+/, '~');

export const fmtDate = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 详情里给到分钟 —— 同一天里的两条会话，"最后使用"只写日期就分不开了。 */
export const fmtDateTime = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${fmtDate(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* ── 状态 ─────────────────────────────────────────────────── */

/** 四档状态 → CSS 类。字典只有这一份，别处一律从这里取。 */
export const STATUS_CLASS = {
  good: 'st-good', warning: 'st-warning', serious: 'st-serious', critical: 'st-critical',
};

/** 四档状态 → 人话。 */
export const STATUS_LABEL = {
  good: '可安全清理', warning: '谨慎清理', serious: '异常，建议清理', critical: '请勿删除',
};

/* ── 图标 ─────────────────────────────────────────────────── */

/** 图标路径。只放路径，外壳由 icon() 生成 —— 五个分类图标共用一套属性。 */
export const ICONS = {
  alert: '<path d="M12 8v4.5M12 16h.01M10.3 3.9 2.6 17.2A1.9 1.9 0 0 0 4.3 20h15.4a1.9 1.9 0 0 0 1.7-2.8L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z"/>',
  terminal: '<path d="M4 7l4 5-4 5M12 17h8"/>',
  box: '<path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5v-7Z"/><path d="M3 8.5 12 13l9-4.5M12 13v7"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  doc: '<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/>',
  db: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l9-9M17 5l2 2M14 8l2 2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.box}</svg>`;

/* ── 侧栏导航图标 ───────────────────────────────────────────
 * 窄屏（< 1080px）侧栏收成 56px 纯图标，那时**图标是唯一的识别线索**。
 * 所以不能只靠一个色点：七个圆点除了颜色没有任何区别，而颜色对色盲
 * 用户不可靠（六色里有两对在常见色盲下接近）。
 *
 * 五个工具用**各自的品牌 logo**（见 brand-icons.js，取自 simple-icons，CC0）：
 * 用户本来就认识这些图形，比手画的近似形状认得出。它们都是实心 fill 路径。
 *
 * 两个跨工具视图（all / audit）不是某个工具、没有品牌，用手画线稿：
 *   all    四格      → 汇总
 *   audit  盾牌       → 安全检查
 */
export const NAV_LINE_ICONS = {
  all: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
  audit: '<path d="M12 3 20 6v6c0 4.4-3.3 7.6-8 9-4.7-1.4-8-4.6-8-9V6l8-3Z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
};

/**
 * 导航图标：品牌 logo 用实心 fill，跨工具视图用线稿 stroke。
 * 两者的 paint 属性不同（fill=currentColor vs fill=none stroke=…），
 * 所以必须分开 —— 把实心路径套上 fill=none 会画出一个空轮廓。
 * 颜色都由各自的 --tool-* / --muted 经 currentColor 决定。
 */
export const navIcon = (id, cls = 'app-tab-icon') => {
  const brand = BRAND_ICONS[id];
  if (brand) {
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${brand}"/></svg>`;
  }
  const line = NAV_LINE_ICONS[id] || NAV_LINE_ICONS.all;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${line}</svg>`;
};

/**
 * 分类徽标：档位决定颜色，规则表决定文字与图标。
 *
 * 档位不在字典里时**不能印出 undefined** —— 这套工具的全部信任都建立在
 * "屏幕上的字是真的"上，一个 "badge undefined" 就会让人怀疑所有数字。
 * 未知档位按 review 的样子显示（中性、不吓人也不放行），文字给出原始档位名，
 * 便于发现问题出在规则表而不是界面。
 */
export const badge = (cat) => {
  // 未知档位退回 warning（中性偏谨慎）：不假装安全，也不假装要删
  const cls = STATUS_CLASS[cat.status] || STATUS_CLASS.warning;
  const text = cat.action || STATUS_LABEL[cat.status] || (cat.status ? String(cat.status) : '未分类');
  return `<span class="badge ${cls}">${icon(cat.icon)}${esc(text)}</span>`;
};
