/**
 * 导航拥挤度测量：在多个视口宽度下量导航区占多少。
 *
 * 这份脚本是左侧栏改动的依据 —— 它量出了顶栏版的真实拥挤度：
 *
 * 要回答两个问题：
 *   1. 现在 7 个标签 + 品牌 + 操作区，在常见宽度下还剩多少余量？
 *      余量接近 0 就意味着再加一个工具（或某个工具名变长）就会溢出。
 *   2. 改成左侧栏要付出多少横向空间？主内容区（会话管理 + 文件清单
 *      两栏）最少需要多宽？
 *
 * 现在侧栏版的同名测量仍然适用（脚本按 .topbar / .app-tabs 取元素，
 * 已经改成 .sidebar），改回顶栏或再调宽度时可以拿它复查。
 *
 * 用法：node scripts/ui-topbar.mjs [port]
 */

import { launch } from './cdp.mjs';

const APP_PORT = process.argv[2] || 4199;
const WIDTHS = [1280, 1440, 1600, 1920];

const PROBE = String.raw`(() => {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const tabs = [...document.querySelectorAll('#appTabs [role="tab"]')].map((t) => ({
    name: (t.querySelector('.app-tab-name') || t).textContent.trim(),
    w: Math.round(t.getBoundingClientRect().width),
  }));
  const bar = document.querySelector('.sidebar');
  const barStyle = bar ? getComputedStyle(bar) : null;

  return JSON.stringify({
    viewportW: window.innerWidth,
    sidebar: r('.sidebar'),
    brand: r('.brand'),
    tabsBox: r('#appTabs'),
    actions: r('.sidebar-foot'),
    tabs,
    tabsTotal: tabs.reduce((s, t) => s + t.w, 0),
    // 导航区内部内容总高（品牌 + 列表 + 底部动作）与视口高比
    barPadding: barStyle ? parseFloat(barStyle.paddingLeft) + parseFloat(barStyle.paddingRight) : 0,
    single: r('#single'),
    tasks: r('#tasks'),
    files: r('#files'),
    docScrollW: document.documentElement.scrollWidth,
  });
})()`;

const b = await launch({ port: 9370, profile: 'agent-inspector-topbar', size: [1440, 1000] });
try {
  await b.goto(`http://127.0.0.1:${APP_PORT}/`, '#appTabs [role="tab"]');
  // 先切到一个有完整内容的工具视图（两栏都撑开）
  await b.evaluate(`(async () => {
    const t = document.querySelector('[data-app="zcode"]');
    if (t) t.click();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let k = 0; k < 120; k++) {
      await sleep(400);
      const lede = (document.querySelector('#taskLede')?.textContent) || '';
      if (lede && !lede.includes('正在') && document.querySelector('#taskList .trow, #taskEmpty:not([hidden])')) break;
    }
    await sleep(400);
  })()`);

  const rows = [];
  for (const w of WIDTHS) {
    await b.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await new Promise((r) => setTimeout(r, 350));
    rows.push(JSON.parse(await b.evaluate(PROBE)));
  }

  console.log('\n导航拥挤度（侧栏宽 + 标签可见 + 横向溢出）');
  console.log('─'.repeat(96));
  console.log('视口  侧栏   标签区  底部     横向溢出  会话列  文件列');
  for (const r of rows) {
    const overflow = r.docScrollW - r.viewportW;
    console.log(
      `${String(r.viewportW).padStart(4)}  ${String(r.sidebar ? r.sidebar.w : 0).padStart(5)}  ` +
      `${String(r.tabsBox.w).padStart(6)}  ${String(r.actions ? r.actions.w : 0).padStart(6)}  ` +
      `${String(overflow).padStart(8)}  ` +
      `${String(r.tasks ? r.tasks.w : 0).padStart(6)}  ${String(r.files ? r.files.w : 0).padStart(6)}`,
    );
  }

  console.log('\n各标签宽度');
  for (const r of rows) {
    console.log(`  视口 ${r.viewportW}: ` + r.tabs.map((t) => `${t.name}=${t.w}`).join('  '));
  }
} finally {
  b.close();
}
