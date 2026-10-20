/**
 * 静态层面能查出来的前端问题。
 *
 * 这里不跑浏览器 —— 那要拖进一个 puppeteer，而这个项目零依赖是硬规矩。
 * 但有些东西本来就是"文件里能读出来"的：无障碍属性写全了没有、键盘模型
 * 有没有接上、结构化数据有没有跟着重建。这一类缺陷不会让页面报错，
 * 只会让键盘用户和读屏用户走进死路，所以值得用读文件的方式钉住。
 *
 * 浏览器里的实测在开发时做过（方向键切换、Tab 焦点循环、焦点归还），
 * 这里锁的是"别在后续改动里被悄无声息地删掉"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = await fs.readFile(path.join(root, 'public/index.html'), 'utf8');
const app = await fs.readFile(path.join(root, 'public/app.js'), 'utf8');
const css = await fs.readFile(path.join(root, 'public/style.css'), 'utf8');

test('工具标签是标准 tablist：roving tabindex + aria-controls + tabpanel', () => {
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tabpanel"/);
  // 标签渲染时按选中与否给 tabindex，而不是恒为 0 —— 四个 0 会让
  // 键盘用户每过一个工具按一次 Tab，而它们本是同一件事的四个选项。
  assert.match(app, /tabindex="\$\{on \? '0' : '-1'\}"/);
  assert.match(app, /aria-controls="single"/);
  // 面板的可访问名要跟着选中项走
  assert.match(app, /setAttribute\('aria-labelledby', `apptab-\$\{state\.appId\}`\)/);
});

test('tablist 接上了左右方向键与 Home/End', () => {
  assert.match(app, /e\.key === 'ArrowRight'/);
  assert.match(app, /e\.key === 'ArrowLeft'/);
  assert.match(app, /e\.key === 'Home'/);
  assert.match(app, /e\.key === 'End'/);
  // 切换会重画整排，旧元素失效 —— 必须按 id 重新取一次，否则焦点掉到 body
  assert.match(app, /document\.getElementById\(id\)\?\.focus\(\)/);
});

test('两个抽屉都有焦点陷阱，并且开合时管焦点', () => {
  assert.match(app, /function trapTab/);
  assert.match(app, /function openModal/);
  assert.match(app, /function closeModal/);
  // 打开两个抽屉的地方都要调 openModal
  const opens = app.match(/openModal\(/g) || [];
  assert.ok(opens.length >= 3, `openModal 应当有一个定义 + 两处调用，实际 ${opens.length} 次`);
  // 关闭也要各调一次
  const closes = app.match(/closeModal\(/g) || [];
  assert.ok(closes.length >= 3, `closeModal 应当有一个定义 + 两处调用，实际 ${closes.length} 次`);
  // Tab 键要真的走陷阱
  assert.match(app, /e\.key === 'Tab'[\s\S]{0,200}trapTab\(e, els\.drawer\)/);
  assert.match(app, /e\.key === 'Tab'[\s\S]{0,300}trapTab\(e, tEls\.drawer\)/);
});

test('抽屉声明 aria-modal 时，背景滚动真的被锁住', () => {
  assert.match(html, /role="dialog"[^>]*aria-modal="true"/);
  // 声明了 modal 却让底页跟着滚，是"看着对、用起来错"
  assert.match(css, /body\.is-modal\s*\{\s*overflow:\s*hidden/);
});

test('打开抽屉时同步取焦点，不等 rAF', () => {
  // rAF 可能在样式重算前就跑，那时 getClientRects() 还是空的，
  // 焦点留在背后那个按钮上 —— 实测踩过。
  const body = app.slice(app.indexOf('function openModal'), app.indexOf('function closeModal'));
  // 只看代码，不看注释：注释里正好写着"不能用 requestAnimationFrame"
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /requestAnimationFrame/, 'openModal 不该依赖 rAF 等布局');
  assert.match(code, /getClientRects\(\)/, 'openModal 应当同步强制一次布局');
});

test('页面声明了 favicon 与 color-scheme', () => {
  assert.match(html, /rel="icon"[^>]*favicon\.svg/);
  assert.match(html, /name="color-scheme"/);
});

test('切换到另一个工具时，会话面板与搜索状态一起归零', () => {
  // 这两件都在 applyApp / resetTaskPanel 里，漏一个就会"在新工具名下读到旧数字"
  const apply = app.slice(app.indexOf('function applyApp'), app.indexOf('function renderAppTabs'));
  assert.match(apply, /state\.q = ''/, '搜索词要随工具重置');
  assert.match(apply, /state\.statuses\.clear\(\)/, '状态筛选要随工具重置');
  assert.match(apply, /state\.group = null/);
  const reset = app.slice(app.indexOf('function resetTaskPanel'), app.indexOf('async function loadTasks'));
  assert.match(reset, /tEls\.dbBar\.innerHTML = ''/, '库构成条要擦干净');
  assert.match(reset, /tEls\.chips\.innerHTML = ''/, '筛选钮要擦干净');
  assert.match(reset, /els\.taskQuick\.hidden = true/, '首屏快捷项要收起');
});
