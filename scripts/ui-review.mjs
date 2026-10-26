/**
 * 逐状态截图：review 用。
 *
 * 上一轮我只截了「宽屏浅色」和「1000px 窄屏」两张就交付了 —— 那不算 review。
 * 侧栏这个改动会碰到的状态至少有六种，每一种都可能露馅：
 *
 *   · 深色主题（工具色是另一套值，选中底色会不会糊）
 *   · 窗口矮（100vh 的侧栏放不下七项 + 底部动作时怎么办）
 *   · 工具没装（is-empty 的 55% 透明度在深色下还剩多少可读性）
 *   · 悬停 / 焦点态
 *   · 「全部」「安全审计」两个跨工具视图（它们的色点走中性色）
 *   · 极窄（56px 图标栏在 400px 窗口里）
 *
 * 用法：node scripts/ui-review.mjs [port] [输出目录]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { launch } from './cdp.mjs';

const PORT = process.argv[2] || 4199;
const OUT = process.argv[3] || '/tmp/ui-review';

/** 等某个视图加载完。 */
const READY = (view) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const t = document.querySelector('[data-app="${view}"]');
  if (t && t.getAttribute('aria-selected') !== 'true') t.click();
  for (let k = 0; k < 150; k++) {
    await sleep(350);
    if (document.querySelector('#single')?.getAttribute('aria-busy') === 'true') continue;
    if ('${view}' === 'all') {
      const l = (document.querySelector('#allLede')?.textContent) || '';
      if (l && !l.includes('正在') && (document.querySelectorAll('#allList .all-group').length || document.querySelectorAll('#allEmpty:not([hidden])').length)) break;
    } else if ('${view}' === 'audit') {
      const l = (document.querySelector('#auditLede')?.textContent) || '';
      if (l && !l.includes('正在')) break;
    } else {
      const l = (document.querySelector('#taskLede')?.textContent) || '';
      if (l && !l.includes('正在') && document.querySelector('#taskList .trow, #taskEmpty:not([hidden])')) break;
    }
  }
  await sleep(600);
  window.scrollTo(0, 0);
  return true;
})()`;

await fs.mkdir(OUT, { recursive: true });

const b = await launch({ port: 9380, profile: 'agent-inspector-review', size: [1440, 1000] });
try {
  await b.goto(`http://127.0.0.1:${PORT}/`, '#appTabs [role="tab"]');

  const shot = async (name) => {
    await fs.writeFile(path.join(OUT, `${name}.png`), await b.screenshot());
    console.log('  ✓', name);
  };

  const setTheme = (theme) => b.evaluate(`(() => {
    document.documentElement.classList.add('is-theme-switching');
    if ('${theme}') document.documentElement.setAttribute('data-theme', '${theme}');
    else document.documentElement.removeAttribute('data-theme');
    for (const a of document.getAnimations()) if (a instanceof CSSTransition) a.cancel();
    setTimeout(() => document.documentElement.classList.remove('is-theme-switching'), 120);
    return true;
  })()`);

  const size = async (w, h) => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 350));
  };

  console.log('截图输出到', OUT);

  // 1) 浅色宽屏 + 一个有内容的工具视图
  await size(1440, 1000);
  await setTheme('');
  await b.evaluate(READY('zcode'));
  await shot('01-light-1440-zcode');

  // 2) 深色 —— 工具色换了一整套值，重点看选中底色与未安装态的对比
  await setTheme('dark');
  await new Promise((r) => setTimeout(r, 400));
  await shot('02-dark-1440-zcode');

  // 3) 深色下的「全部」与「安全审计」（跨工具项用中性色）
  await b.evaluate(READY('all'));
  await shot('03-dark-1440-all');
  await b.evaluate(READY('audit'));
  await shot('04-dark-1440-audit');

  // 4) 悬停 + 焦点态（浅色，看得清边）
  await setTheme('');
  await new Promise((r) => setTimeout(r, 300));
  await b.evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-app="zcode"]').click();
    await sleep(1200);
    // 鼠标停在 Codex 上
    const codex = document.querySelector('[data-app="codex"]');
    const r = codex.getBoundingClientRect();
    codex.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.x + 40, clientY: r.y + 18 }));
    // 键盘焦点落在 Cursor 上
    document.querySelector('[data-app="cursor"]').focus();
    await sleep(300);
    return true;
  })()`);
  await shot('05-light-hover-focus');

  // 5) 窗口矮：100vh 的侧栏放不下七项 + 底部动作时会怎样
  await size(1440, 560);
  await new Promise((r) => setTimeout(r, 400));
  await shot('06-light-short-560');
  const sidebarOverflow = await b.evaluate(`(() => {
    const sb = document.querySelector('.sidebar');
    const tabs = [...document.querySelectorAll('#appTabs [role="tab"]')];
    const sbR = sb.getBoundingClientRect();
    const footR = document.querySelector('.sidebar-foot').getBoundingClientRect();
    const clipped = tabs.filter(t => {
      const r = t.getBoundingClientRect();
      return r.bottom > sbR.bottom + 1;
    }).map(t => t.querySelector('.app-tab-name').textContent.trim());
    return JSON.stringify({
      sidebarH: Math.round(sbR.height),
      scrollH: sb.scrollHeight,
      canScroll: sb.scrollHeight > sb.clientHeight + 1,
      footVisible: footR.bottom <= sbR.bottom + 1,
      clippedTabs: clipped,
    });
  })()`);
  console.log('  矮窗口侧栏:', sidebarOverflow);

  // 6) 极窄：56px 图标栏 + 内容
  await size(420, 900);
  await new Promise((r) => setTimeout(r, 400));
  await b.evaluate(`(async () => { await new Promise(r => setTimeout(r, 1400)); return true; })()`);
  await shot('07-narrow-420');

  // 7) 深色 + 窄屏（图标模式下的深色）—— 最深色底下图标clear不
  await setTheme('dark');
  await new Promise((r) => setTimeout(r, 400));
  await shot('08-dark-narrow-420');

  // 8) 未安装态：找一个 0 文件的工具（Claude 在这台机器上可能有会话但文件不少；
  //    用 is-empty 类查出实际是哪个）
  await setTheme('');
  await size(1440, 1000);
  await new Promise((r) => setTimeout(r, 300));
  const empties = await b.evaluate(`(() => {
    const out = [...document.querySelectorAll('#appTabs .app-tab')].map(t => ({
      name: t.querySelector('.app-tab-name').textContent.trim(),
      empty: t.classList.contains('is-empty'),
    }));
    return JSON.stringify(out);
  })()`);
  console.log('  各导航项 is-empty:', empties);

  console.log('完成');
} finally {
  b.close();
}
