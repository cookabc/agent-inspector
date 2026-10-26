/**
 * 侧栏对比度体检：把"看起来有点淡"变成数字。
 *
 * 侧栏里有四类文字/图形，各自有不同的前景与背景组合：
 *   1. 未选中项的名称（--ink-2 落在 --surface 上）
 *   2. 选中项的名称（--ink 落在 tint 过的 --surface 上）
 *   3. 侧栏图标（工具色，--tool-* / --muted）
 *   4. 底部"扫描用时"与两个按钮（--muted）
 *
 * 判据用 WCAG：正文 4.5:1，非文本图形（图标）3:1（AA for graphics）。
 * 这套工具的信任建立在"屏幕上的字是真的"上 —— 一行看不清的导航文字
 * 不算"设计感"，算缺陷。
 *
 * 用法：node scripts/ui-contrast.mjs [port]
 */

import { launch } from './cdp.mjs';

const PORT = process.argv[2] || 4199;

/* 在页面里跑：取每个元素的实际计算色，回溯到不透明的背景色，
   算对比度。半透明层（color-mix / rgba）会一路往上找到能兜住的底。 */
const PROBE = String.raw`(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  // 把带透明的颜色合成到不透明底上
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  // 向上找第一个不透明背景
  const bgOf = (el) => {
    let cur = el, acc = null;
    while (cur) {
      const c = parse(getComputedStyle(cur).backgroundColor);
      if (c && c.a > 0) {
        acc = acc ? over(acc, c) : c;
        if (cc(c) >= 0.999) return acc;   // 完全不透明，够了
      }
      cur = cur.parentElement;
    }
    const page = parse(getComputedStyle(document.body).backgroundColor);
    return acc ? over(acc, page && page.a > 0.999 ? page : { r: 255, g: 255, b: 255, a: 1 })
               : { r: 255, g: 255, b: 255, a: 1 };
  };
  const cc = (c) => c.a;

  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  const measure = (el, label, kind) => {
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) return null;
    const bg = bgOf(el);
    const r = ratio(over(fg, bg), bg);
    return {
      label,
      kind,                       // 'text' | 'graphic'
      size: parseFloat(cs.fontSize),
      fg: cs.color,
      bg: 'rgb(' + Math.round(bg.r) + ', ' + Math.round(bg.g) + ', ' + Math.round(bg.b) + ')',
      ratio: +r.toFixed(2),
      min: kind === 'text' ? (parseFloat(cs.fontSize) >= 18.66 ? 3 : 4.5) : 3,
    };
  };

  const out = [];
  const tabs = [...document.querySelectorAll('#appTabs [role="tab"]')];
  const on = tabs.find(t => t.getAttribute('aria-selected') === 'true');
  const off = tabs.find(t => t.getAttribute('aria-selected') !== 'true');

  if (on) out.push(measure(on.querySelector('.app-tab-name'), '选中项名称', 'text'));
  if (off) out.push(measure(off.querySelector('.app-tab-name'), '未选中项名称', 'text'));
  if (on) out.push(measure(on.querySelector('.app-tab-icon'), '选中项图标', 'graphic'));
  if (off) out.push(measure(off.querySelector('.app-tab-icon'), '未选中项图标', 'graphic'));

  const meta = tabs.find(t => t.classList.contains('app-tab--meta'));
  if (meta) out.push(measure(meta.querySelector('.app-tab-name'), '跨工具项名称', 'text'));

  const note = document.querySelector('.scan-note');
  if (note) out.push(measure(note, '扫描用时', 'text'));

  const rb = document.querySelector('#rescanBtn');
  if (rb) out.push(measure(rb, '重新扫描按钮', 'text'));

  const brand = document.querySelector('.brand-text strong');
  if (brand) out.push(measure(brand, '品牌名', 'text'));
  const rootPath = document.querySelector('#rootPath');
  if (rootPath) out.push(measure(rootPath, '根路径', 'text'));

  return JSON.stringify({
    theme: document.documentElement.getAttribute('data-theme') || 'light(auto)',
    items: out.filter(Boolean),
  });
})()`;

const b = await launch({ port: 9381, profile: 'agent-inspector-contrast', size: [1440, 1000] });
try {
  await b.goto(`http://127.0.0.1:${PORT}/`, '#appTabs [role="tab"]');
  await b.evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-app="zcode"]').click();
    await sleep(1800);
    return true;
  })()`);

  for (const theme of ['', 'dark']) {
    await b.evaluate(`(() => {
      document.documentElement.classList.add('is-theme-switching');
      ${theme ? `document.documentElement.setAttribute('data-theme', '${theme}');` : "document.documentElement.removeAttribute('data-theme');"}
      for (const a of document.getAnimations()) if (a instanceof CSSTransition) a.cancel();
      setTimeout(() => document.documentElement.classList.remove('is-theme-switching'), 120);
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 450));
    const d = JSON.parse(await b.evaluate(PROBE));
    console.log(`\n══ ${d.theme} ══`);
    console.log('元素              实际/要求   状态  前景           背景');
    console.log('─'.repeat(86));
    for (const it of d.items) {
      const ok = it.ratio >= it.min ? '✔' : '✖ 不足';
      console.log(
        `${it.label.padEnd(16)}  ${String(it.ratio).padStart(5)}/${String(it.min).padEnd(3)}  ${ok.padEnd(5)}  ` +
        `${it.fg.padEnd(15)} ${it.bg}`,
      );
    }
    const bad = d.items.filter((x) => x.ratio < x.min);
    console.log(bad.length ? `\n  ${bad.length} 处不达标` : '\n  全部达标');
  }
} finally {
  b.close();
}
