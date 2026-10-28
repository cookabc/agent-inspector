/**
 * 界面截图：给某个视图拍一张首屏。
 *
 * 用法：node scripts/ui-shot.mjs [port] [view] [输出路径]
 * 例：  node scripts/ui-shot.mjs 4199 zcode /tmp/zcode.png
 *
 * 之所以单独一个脚本：数字（ui-measure）能说"多高、几屏"，但说不出
 * "那块空白长什么样"。截图是唯一能证明"标签被裁了""留白在左下角"的东西。
 */

import fs from 'node:fs/promises';
import { launch } from './cdp.mjs';

const PORT = process.argv[2] || 4199;
const VIEW = process.argv[3] || 'zcode';
const OUT = process.argv[4] || `/tmp/ui-fold-${VIEW}.png`;

/** 等某视图加载完：三个跨工具视图各有各的"读完了"信号。 */
const WAIT_READY = (view) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const t = document.querySelector('[data-app="${view}"]');
  if (t && t.getAttribute('aria-selected') !== 'true') t.click();
  const ready = (sel) => document.querySelector(sel);
  for (let k = 0; k < 150; k++) {
    await sleep(400);
    const busy = document.querySelector('#single')?.getAttribute('aria-busy') === 'true';
    if (busy) continue;
    if ('${view}' === 'all') {
      const l = (document.querySelector('#allLede')?.textContent) || '';
      if (l && !l.includes('正在') && (document.querySelectorAll('#allList .all-group').length > 0 || document.querySelectorAll('#allEmpty:not([hidden])').length)) break;
    } else if ('${view}' === 'audit') {
      const l = (document.querySelector('#auditLede')?.textContent) || '';
      if (l && !l.includes('正在')) break;
    } else {
      const l = (document.querySelector('#taskLede')?.textContent) || '';
      if (l && !l.includes('正在') && ready('#taskList .trow, #taskEmpty:not([hidden])')) break;
    }
  }
  await sleep(700);
  window.scrollTo(0, 0);
  return true;
})()`;

const b = await launch({ port: 9351, profile: 'agent-inspector-shot' });
try {
  await b.goto(`http://127.0.0.1:${PORT}/`, '#appTabs [role="tab"]');
  await b.evaluate(WAIT_READY(VIEW));
  await fs.writeFile(OUT, await b.screenshot());
  console.log('已保存', OUT);
} finally {
  await b.close();
}
