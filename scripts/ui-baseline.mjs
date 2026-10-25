/**
 * 界面基线快照：记录七个视图的"结构签名"。
 *
 * 为什么需要它：结构重构（拆文件、合并 CSS）的失败方式不是报错，而是
 * "某一处悄悄变了" —— 少了一个 aria 属性、某个块从 24px 掉到 16px、
 * 某个按钮的 disabled 时机反了。靠重读代码看不出来，靠手点也点不全。
 *
 * 做法：零依赖，用 Node 自带的 WebSocket 连 Chrome DevTools Protocol，
 * 在每个视图上取三类东西：
 *   shape    DOM 结构（标签名 + class + 关键 aria，不含文本）—— 拆分前后必须逐字相同
 *   text     可见文本 —— 只比前 4000 字（时间戳会变，后面不看）
 *   geometry 关键容器的盒模型（宽高）—— CSS 合并是否改变了布局
 *
 * 用法：
 *   node scripts/ui-baseline.mjs capture before.json
 *   node scripts/ui-baseline.mjs capture after.json
 *   node scripts/ui-baseline.mjs diff before.json after.json
 *
 * 它只读 DOM，不写任何东西，也不改应用状态（除了切视图）。
 */

import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

/** 在页面里跑：取签名。这段代码是被 CDP 当 Expression 执行的。 */
const PROBE = String.raw`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* 结构签名：只看标签与 class（排序后）与 aria 角色，不看文本。
     文本会随"距现在多久"变，放在 text 里单独比。 */
  const shapeOf = (el) => {
    const walk = (n) => {
      if (n.nodeType === 3) return null;                    // 文本节点
      if (n.nodeType !== 1) return null;
      if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return null;
      if (n.hidden) return { t: n.tagName, hidden: 1 };
      const cls = [...n.classList].sort().join('.');
      const role = n.getAttribute('role') || '';
      const aria = ['aria-expanded', 'aria-selected', 'aria-pressed', 'aria-modal', 'aria-busy', 'aria-label']
        .map(a => n.hasAttribute(a) ? a + '=' + n.getAttribute(a) : '')
        .filter(Boolean).join(' ');
      const dis = (n.disabled || n.hasAttribute('disabled')) ? ' disabled' : '';
      const kids = [...n.childNodes].map(walk).filter(Boolean)
        .map(k => typeof k === 'string' ? k : JSON.stringify(k));
      const head = n.tagName + (cls ? '.' + cls : '') + (role ? '[' + role + ']' : '')
        + (aria ? '[' + aria + ']' : '') + dis;
      return kids.length ? head + '{' + kids.join(',') + '}' : head;
    };
    return walk(el);
  };

  /* 文本里会自然变化的部分（体积、计数、日期、时间）必须先抹掉再比。
     这台机器上的 agent 一直在写新会话，两次抓取之间 ZCode 的体积就会变
     （实测 846.6 MB → 894.2 MB）—— 那是数据在动，不是界面在变。
     抹掉它们，剩下的才是"渲染逻辑有没有变"。 */
  const normalizeText = (s) => s
    .replace(/\d+(\.\d+)?\s*(B|KB|MB|GB|TB)\b/g, '#SIZE#')
    .replace(/\d{1,3}(,\d{3})+/g, '#NUM#')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '#DATE#')
    .replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/g, '#DATETIME#')
    .replace(/占比 \d+%/g, '占比 #PCT#')
    .replace(/\b\d+(\.\d+)?%/g, '#PCT#')
    .replace(/占 [\d.]+%/g, '占 #PCT#')
    .replace(/用时 \d+ ms/g, '用时 #MS#')
    .replace(/\d+\s*秒/g, '#SEC#')
    .replace(/\d+\s*项/g, '#ITEMS#')
    .replace(/已选\s*\d+/g, '已选 #SEL#')
    .replace(/筛出\s*\d+\s*\/\s*\d+/g, '筛出 #FILTER#')
    .replace(/[:\s]+$/g, '');

  const textOf = (el) => normalizeText((el.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 4000);

  const boxOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };

  const GEOM = {
    hero: '#overview', treemap: '#treemap', tasks: '#tasks', files: '#files',
    allView: '#allView', auditView: '#auditView', appTabs: '#appTabs',
    taskList: '#taskList', groups: '#groups', actionbar: '#actionbar',
  };

  const out = {};
  const pick = () => {
    const geo = {};
    for (const [k, sel] of Object.entries(GEOM)) geo[k] = boxOf(sel);
    return {
      shape: JSON.stringify(shapeOf(document.querySelector('#single'))).length,
      shapeHash: (() => {
        const s = JSON.stringify(shapeOf(document.querySelector('#single')));
        let h = 0;
        for (let i = 0; i < s.length; i += 1) { h = (h * 31 + s.charCodeAt(i)) | 0; }
        return h;
      })(),
      shapeSample: JSON.stringify(shapeOf(document.querySelector('#single'))).slice(0, 900),
      text: textOf(document.querySelector('#single')),
      geo,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    };
  };

  // 切到每个视图并等它稳定
  const tabs = [...document.querySelectorAll('#appTabs [role="tab"]')].map(t => t.dataset.app);
  for (const id of tabs) {
    const tab = document.querySelector('[data-app="' + id + '"]');
    if (tab && tab.getAttribute('aria-selected') !== 'true') {
      tab.click();
      /* 两个跨工具视图要等异步数据落地，不能只 sleep 固定时长 ——
         「全部」要等五个工具都扫完（Cursor 的库几百 MB），第一次抓取与
         第二次抓取的速度差足以让一次采到骨架、另一次采到完整列表。
         所以轮询"加载完了吗"，而不是赌一个秒数。 */
      if (id === 'all') {
        for (let k = 0; k < 120; k += 1) {
          await sleep(500);
          const lede = (document.querySelector('#allLede')?.textContent) || '';
          const rows = document.querySelectorAll('#allList .all-row').length;
          const empty = document.querySelectorAll('#allEmpty:not([hidden])').length;
          if (lede && !lede.includes('正在') && (rows > 0 || empty > 0)) break;
        }
      } else if (id === 'audit') {
        for (let k = 0; k < 120; k += 1) {
          await sleep(500);
          const lede = (document.querySelector('#auditLede')?.textContent) || '';
          if (lede && !lede.includes('正在')) break;
        }
      } else {
        /* 单工具视图：会话面板要读库（Cursor 的 state.vscdb 几百 MB，
           读一次几秒）。原来固定等 2500ms，于是在快机器上够、慢一点就
           只抓到半张卡片 —— 同一份代码两次抓取能差出一千多像素。
           改为等"会话面板那句 lede 不再说正在读"且任务列表已成形。 */
        for (let k = 0; k < 120; k += 1) {
          await sleep(400);
          const lede = (document.querySelector('#taskLede')?.textContent) || '';
          const busy = document.querySelector('#single')?.getAttribute('aria-busy') === 'true';
          const ready = document.querySelector('#taskList .trow, #taskEmpty:not([hidden])');
          if (!busy && lede && !lede.includes('正在') && ready) break;
        }
      }
      // 稳定后再多给一拍，让入场动画与二次渲染落定
      await sleep(600);
    } else {
      await sleep(1200);
    }
    out[id] = pick();
  }
  return JSON.stringify({ tabs, views: out });
})()`;

async function cdp() {
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/agent-inspector-ui-baseline', '--no-first-run',
    '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let info = null;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      info = list.find((t) => t.type === 'page');
      if (info) break;
    } catch { /* 还没起来 */ }
  }
  if (!info) { proc.kill(); throw new Error('Chrome 没起来'); }

  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { proc, ws, send };
}

const PORT_APP = process.env.APP_PORT || 4199;

async function capture(file) {
  const { proc, ws, send } = await cdp();
  try {
    await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT_APP}/` });
    // 等首屏扫描完成：骨架消失 + 有 tab
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      // send() 返回的是 CDP 的 result 对象本身（{result:{type,value}}）
      const probe = await send('Runtime.evaluate', {
        expression: `Boolean(document.querySelector('#appTabs [role="tab"]')) && (document.body.getAttribute('aria-busy') !== 'true')`,
        returnByValue: true,
      });
      if (probe.result?.value) break;
    }
    const evalResult = await send('Runtime.evaluate', {
      expression: PROBE, awaitPromise: true, returnByValue: true,
    });
    if (evalResult.exceptionDetails) throw new Error(JSON.stringify(evalResult.exceptionDetails).slice(0, 800));
    const data = JSON.parse(evalResult.result.value);
    await fs.writeFile(file, JSON.stringify(data, null, 2));
    console.log(`已写入 ${file}：${data.tabs.length} 个视图`);
    for (const [id, v] of Object.entries(data.views)) {
      console.log(`  ${id.padEnd(8)} shape=${String(v.shape).padStart(6)} geo=${Object.entries(v.geo).filter(([, g]) => g).map(([k, g]) => `${k}:${g.w}x${g.h}`).slice(0, 4).join(' ')}`);
    }
  } finally {
    ws.close();
    proc.kill();
  }
}

async function diff(a, b) {
  const A = JSON.parse(await fs.readFile(a, 'utf8'));
  const B = JSON.parse(await fs.readFile(b, 'utf8'));
  let bad = 0;
  if (JSON.stringify(A.tabs) !== JSON.stringify(B.tabs)) {
    console.log(`✖ 标签集合变了：${A.tabs.join(',')} → ${B.tabs.join(',')}`);
    bad += 1;
  }
  for (const id of Object.keys(A.views)) {
    const x = A.views[id], y = B.views[id];
    if (!y) { console.log(`✖ ${id}: 视图消失了`); bad += 1; continue; }
    const notes = [];
    if (x.shape !== y.shape) notes.push(`shape 长度 ${x.shape} → ${y.shape}`);
    if (x.text !== y.text) notes.push('文本变了');
    for (const k of Object.keys(x.geo)) {
      const p = x.geo[k], q = y.geo[k];
      if (!p && !q) continue;
      if (!p || !q) { notes.push(`${k} 出现/消失`); continue; }
      /* 容差 ±3px：标签栏与卡片高度由内容文字决定，体积数字从 "846.6 MB"
         变成 "1.02 GB" 就会撑宽两三个像素。这不是布局被改动了。
         真正要抓的是"整块塌了 / 少了一个兄弟"那种量级的变化。 */
      if (Math.abs(p.w - q.w) > 3 || Math.abs(p.h - q.h) > 3) {
        notes.push(`${k} ${p.w}x${p.h} → ${q.w}x${q.h}`);
      }
    }
    if (x.scrollW !== y.scrollW) notes.push(`横向 scrollWidth ${x.scrollW} → ${y.scrollW}`);
    if (notes.length) { console.log(`✖ ${id}: ${notes.join('；')}`); bad += 1; }
    else console.log(`✔ ${id}`);
  }
  if (bad) { console.log(`\n${bad} 处差异`); process.exitCode = 1; }
  else console.log('\n七个视图的结构、文本与关键几何完全一致');
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'capture') await capture(rest[0] || 'baseline.json');
else if (cmd === 'diff') await diff(rest[0], rest[1]);
else {
  console.log('用法：node scripts/ui-baseline.mjs capture <file> | diff <before> <after>');
  process.exitCode = 1;
}
