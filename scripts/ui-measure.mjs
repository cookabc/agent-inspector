/**
 * UI 效率测量：把"效率"拆成可数的东西。
 *
 * 量的是四件用户真正会感受到的事：
 *   1. 首屏折叠线之上有什么（fold）—— 不滚屏就能看到的信息量
 *   2. 各区块多高、从第几像素开始 —— 谁在吃视口
 *   3. 整页要滚几屏 —— 到常用动作的距离
 *   4. 首屏可交互元素的数量 —— 第一眼要做多少个决定
 *
 * 用法：node scripts/ui-measure.mjs [port]
 *
 * 这些数字是"更有效率"这个说法的唯一依据。改版前后各跑一次，
 * 才有资格说"从六屏变成两屏"。
 */

import { launch } from './cdp.mjs';

const APP_PORT = process.argv[2] || 4199;

const PROBE = String.raw`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const fold = window.innerHeight;

  const sections = ['#overview', '#treemap', '#clean', '#tasks', '#files', '#diagnosis', '#allView', '#auditView'];
  const rectOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { top: Math.round(r.top + window.scrollY), h: Math.round(r.height) };
  };

  /* 首屏里能看见的文字量：把折叠线之上所有可见节点的文本接起来数长度。
     同一块视口，字多还是少 —— 这是"信息密度"。 */
  const foldText = () => {
    let chars = 0, blocks = 0;
    const walk = (n) => {
      if (n.nodeType === 3) { chars += (n.textContent || '').trim().length; return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.bottom < 0 || r.top > fold) return;
      if (r.top < fold && /^(P|LI|H1|H2|H3|H4|SPAN|B|CODE|STRONG)$/.test(n.tagName)) blocks += 1;
      for (const c of n.childNodes) walk(c);
    };
    walk(document.querySelector('#single') || document.body);
    return { chars, blocks };
  };

  /* 折叠线之上的可交互元素 —— 第一眼要做多少个决定 */
  const foldControls = () => {
    let n = 0;
    for (const el of document.querySelectorAll('#single button, #single input, #single select')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.top < fold && r.bottom > 0) n += 1;
    }
    return n;
  };

  const out = {};
  const tabs = [...document.querySelectorAll('#appTabs [role="tab"]')].map(t => t.dataset.app);
  for (const id of tabs) {
    const tab = document.querySelector('[data-app="' + id + '"]');
    if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
    /* 等这一屏真的读完 —— 固定 sleep 会抓到半张卡片（Cursor 的库几百 MB），
       同一份代码两次测量能差上千像素。 */
    for (let k = 0; k < 150; k++) {
      await sleep(400);
      const busy = document.querySelector('#single')?.getAttribute('aria-busy') === 'true';
      if (busy) continue;
      if (id === 'all') {
        const l = (document.querySelector('#allLede')?.textContent) || '';
        if (l && !l.includes('正在') && (document.querySelectorAll('#allList .all-group').length || document.querySelectorAll('#allEmpty:not([hidden])').length)) break;
      } else if (id === 'audit') {
        const l = (document.querySelector('#auditLede')?.textContent) || '';
        if (l && !l.includes('正在')) break;
      } else {
        const l = (document.querySelector('#taskLede')?.textContent) || '';
        if (l && !l.includes('正在') && document.querySelector('#taskList .trow, #taskEmpty:not([hidden])')) break;
      }
    }
    await sleep(500);
    window.scrollTo(0, 0);
    await sleep(80);

    const secs = {};
    for (const s of sections) secs[s] = rectOf(s);
    const docH = document.documentElement.scrollHeight;
    const t = foldText();
    out[id] = {
      docH,
      screens: +(docH / fold).toFixed(2),
      sections: secs,
      foldChars: t.chars,
      foldBlocks: t.blocks,
      foldControls: foldControls(),
    };
  }
  return JSON.stringify({ fold: window.innerHeight, views: out });
})()`;

const b = await launch({ port: 9336, profile: 'agent-inspector-measure' });
try {
  await b.goto(`http://127.0.0.1:${APP_PORT}/`, '#appTabs [role="tab"]');
  const data = JSON.parse(await b.evaluate(PROBE));

  console.log(`\n视口高 ${data.fold}px\n`);
  console.log('视图      文档高   屏数  首屏字数  首屏段落  首屏控件');
  console.log('─'.repeat(62));
  for (const [id, v] of Object.entries(data.views)) {
    console.log(
      `${id.padEnd(8)}  ${String(v.docH).padStart(6)}  ${String(v.screens).padStart(5)}  ` +
      `${String(v.foldChars).padStart(8)}  ${String(v.foldBlocks).padStart(8)}  ${String(v.foldControls).padStart(8)}`,
    );
  }

  console.log('\n各区块（起点+高度，px；— = 该视图没有这块）');
  console.log('─'.repeat(80));
  const secs = ['#overview', '#treemap', '#clean', '#tasks', '#files'];
  console.log('视图      ' + secs.map((s) => s.padStart(13)).join(''));
  for (const [id, v] of Object.entries(data.views)) {
    console.log(id.padEnd(9) + secs.map((s) => {
      const g = v.sections[s];
      return String(g ? `${g.top}+${g.h}` : '—').padStart(13);
    }).join(''));
  }
} finally {
  await b.close();
}
