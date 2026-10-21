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
const shapeSrc = await fs.readFile(path.join(root, 'lib/tasks-shape.mjs'), 'utf8');

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

test('所有批量入口都过同一个可选中判据，没有各自为政', () => {
  /* 这是一次真实故障的回归锁：行级复选框早就按 verdict/link 禁用了，
     而「分组全选」「推荐清理」「三块分组」各自判断，各自漏了软链接。
     结果点「推荐清理」→ 选区混进一个软链接 → 服务端先校验全批 →
     整批被拒，界面上只报那一个文件。 */
  const routes = [
    ['分组全选', 'selectableOnly(filesOf(id).filter(matches), cat)'],
    ['推荐清理', 'selectableOnly(filesOf(c.id), c)'],
    ['全选可见', 'selectableOnly(files, cat)'],
    ['三块分组', 'groupOf(f) === g && canPick(f)'],
    ['定位会话正文', 'if (f && canPick(f))'],
    ['发送前兜底', 'if (!canPick(f)) continue;'],
    ['抽屉兜底', 'const rows = raw.filter((f) => canPick(f));'],
  ];
  for (const [name, needle] of routes) {
    assert.ok(app.includes(needle), `${name} 没有过可选中判据：找不到 ${needle}`);
  }
  // 判据本体只有 logic.js 一份，app.js 里只是转发
  assert.match(app, /const canPick = \(f, cat\) => isSelectable\(f, cat \|\| catOfRow\(f\)\)/);
  assert.match(app, /import \{ fmtBytes, isSelectable \} from '\.\/logic\.js'/);
});

test('分组复选框的状态按"真正能勾的行"算', () => {
  // 用全部行算的话，软链接与受保护项永远勾不上，框就永远停在半选 ——
  // 点一次还是半选，两次才取消，人看到的是"这个框坏了"。
  assert.match(app, /const pickable = selectableOnly\(all, cat\)/);
  assert.match(app, /selCount === pickable\.length \? 'checked'/);
  assert.match(app, /selCount < pickable\.length \? 'data-indeterminate/);
});

test('清理成功后抽屉立刻关，结果交给 toast —— 不再靠延时等人读完', () => {
  /* 用户报的："移入废纸篓的 loading 结束后，侧边栏没有马上消失"。
     原来的顺序是：成功 → await load(true) 重扫约 1 秒 → 再 setTimeout 1.2 秒
     → 才关。于是转圈早停了，抽屉还杵着，看起来像没反应。
     会话那条线更夸张，写的是 3000。 */
  assert.doesNotMatch(app, /setTimeout\(closeDrawer, \d+\)/, '不该再用延时关抽屉');
  assert.doesNotMatch(app, /setTimeout\(closeTaskDrawer, \d+\)/, '不该再用延时关抽屉');

  const clean = app.slice(app.indexOf('async function runClean'), app.indexOf('/** 在 Finder 中显示'));
  // 只在代码里找位置 —— 注释里正好写着"之前是反过来 —— await load(true)…"
  const codeOnly = clean.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(codeOnly, /closeDrawer\(\);\s*\n\s*showToast\(msg\)/, '成功路径应当先关抽屉再报结果');
  assert.ok(
    codeOnly.indexOf('closeDrawer()') < codeOnly.indexOf('load(true)'),
    '重扫应当在抽屉关掉之后才开始',
  );

  const purge = app.slice(app.indexOf('async function finishPurge'), app.indexOf('/* 会话面板事件 */'));
  assert.match(purge, /closeTaskDrawer\(\);\s*\n\s*showToast\(/, '会话清理同样先关再报');
});

test('失败时保留抽屉，不吐成功 toast', () => {
  const clean = app.slice(app.indexOf('async function runClean'), app.indexOf('/** 在 Finder 中显示'));
  // failed 分支必须在 closeDrawer 之前 return
  const failedIdx = clean.indexOf('${failed.length} 项失败');
  const closeIdx = clean.indexOf('closeDrawer()');
  assert.ok(failedIdx > 0 && failedIdx < closeIdx, '有失败项时要先返回，不能继续走到关闭');
  assert.match(clean, /return;\s*\n\s*\}\s*\n\s*\/\* 全部成功/);
});

test('toast 是个 aria-live 的独立元素，不靠抽屉承载结果', () => {
  assert.match(html, /id="toast"[^>]*role="status"[^>]*aria-live="polite"/);
  /* 不能写 pointer-events:none —— 那会让悬停彻底落空，而 README 承诺
     "屏幕上每个体积都可以悬停看精确字节数"，toast 里的回收量也算。
     所以两个断言反过来锁：既有精确字节的 title，也确实能悬停。 */
  assert.doesNotMatch(css, /\.toast\s*\{[\s\S]{0,600}?pointer-events:\s*none/);
  assert.match(app, /const bytesWithExact = \(n\) => `<b title="\$\{n\.toLocaleString\(\)\} 字节">/);
  // 首屏推荐 lane 收起时要把里面的数字擦掉，别留上一轮的残留
  const rec = app.slice(app.indexOf('function renderRecommend'), app.indexOf('function renderChips'));
  assert.match(rec, /els\.recFigure\.textContent = '—'/);
  assert.match(rec, /els\.recBtn\.textContent = '推荐清理'/);
});

test('构成条按量出来的像素决定放不放文字，不按百分比也不靠估算', () => {
  /* 实测 bug 两次：
     ① 按百分比当阈值（floors[i] > 14）—— 同一个 21% 在宽屏是 200px、
        在窄栏只有 89px，「索引与其他开销 135.5 MB」被裁掉半截。
     ② 改成估算像素 —— 100px 的文字放 106px 的段里仍然溢出 2px。
     最终做法：两个版本都渲进 DOM，量 scrollWidth，放不下的收起来。 */
  const db = app.slice(app.indexOf('function renderDbBar'), app.indexOf('function renderComposition'));
  const dbCode = db.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // 两种写法都在
  assert.match(dbCode, /data-variant="full"/);
  assert.match(dbCode, /data-variant="size"/);
  // 靠量出来的宽度做最终判断 —— 用**段自身**的 scrollWidth，不是 span 的
  assert.match(dbCode, /seg\.scrollWidth > seg\.clientWidth/);
  assert.doesNotMatch(dbCode, /fullEl\.scrollWidth > seg\.clientWidth/);
  // 不许退回按百分比（注释里会提到旧写法，所以只看代码）
  assert.doesNotMatch(dbCode, /floors\[i\] > 1[0-9]/);
});

test('界面上不许把 undefined 印出来：会话行没有 appLabel 字段', () => {
  /* 实测 bug：抽屉清单里写 `${esc(t.appLabel)} · ${esc(t.title)}`，
     而任何后端适配器都没有给会话行塞过 appLabel —— 于是每个 app 的清单
     第一项都是 "undefined · 标题"。这类缺陷不会报错，只是把实现细节
     漏到屏幕上，而这套工具的全部信任都建立在"屏幕上的字是真的"上。

     判据：模板里凡是用了 t.X 的地方，X 必须是 tasks-shape 契约里的字段
     （或适配器确实写了）。这里锁具体这一处，并顺带禁止其它的 t.appLabel。 */
  assert.doesNotMatch(app, /\$\{esc\(t\.appLabel\)\}/, '会话行契约里没有 appLabel');
  // 抽屉用的是这一屏的 appLabel，那来自 /api/tasks 的响应，是有的
  assert.match(app, /const who = d\.appLabel/);
  assert.match(app, /<span>\$\{esc\(who\)\} · \$\{esc\(t\.title\)\}<\/span>/);
});

test('会话行契约的字段确实在 tasks-shape 里，前端不该凭空取', () => {
  // NEUTRAL_ROW 是"每行一定有的字段"的清单；前端只该在这一组里取值
  const shape = shapeSrc;
  for (const field of ['id', 'title', 'workspace', 'state', 'reason', 'bytes', 'updatedAt']) {
    assert.match(shape, new RegExp(`\\b${field}\\b`), `tasks-shape 里应当有 ${field}`);
  }
});

test('推荐项全被排除时不立空壳：标题、0 B、禁用按钮都收起来', () => {
  /* 实测：Cursor 只有一类推荐项（已安装扩展），用户把它关掉之后整块变成
     "标题 + 0 B + 按不动的按钮"，占着 hero 右栏 230px 什么也不提供。
     那不是"没有推荐"，那是三个元素各自说了一遍"没东西"。 */
  const rec = app.slice(app.indexOf('function renderRecommend'), app.indexOf('function renderChips'));
  assert.match(rec, /const nothingOn = !on\.length/, '要按"选中的推荐项"判断，不是"存在的推荐项"');
  assert.match(rec, /els\.recHead\.hidden = nothingOn/);
  assert.match(rec, /els\.recFoot\.hidden = nothingOn/);
  // chip 必须留在那儿 —— 那是把分类放回来的唯一入口
  assert.match(rec, /els\.recScope\.innerHTML = recChips\(all\)/);
});

test('两块会话分组都为空时折成一行说明，并改掉"分成三组"的说法', () => {
  /* Claude Code 与 Cursor 是常态：前者没有索引库可比对，后者文件路径里
     不带 sess_ id。各立一张 126px 的空卡片白白吃掉半屏。 */
  assert.match(app, /const bothEmpty = orphan\.length === 0 && live\.length === 0/);
  assert.match(app, /class="split-note"/);
  // 只剩一块时说"分成三组"是假话；但原因已由 split-note 交代，这里只留操作提示
  assert.match(app, /const twoEmpty = orphan\.length === 0 && live\.length === 0/);
  assert.match(app, /点一块选中整块，再点一下取消/);
  assert.doesNotMatch(app, /所以只有<b>「非会话文件」<\/b>一块/, '别把 split-note 的话再说一遍');
  assert.match(css, /\.split-note \{[\s\S]{0,200}grid-column: 1 \/ -1/);
});

test('一条会话都没有时，搜索/排序/分组/全选这些摆设一起收起', () => {
  const tasks = app.slice(app.indexOf('function renderTasks'), app.indexOf('function renderDbBar'));
  assert.match(tasks, /tEls\.toolbar\.hidden = true/, '空态要收起工具栏');
  assert.match(tasks, /tEls\.toolbar\.hidden = false/, '有数据要把工具栏放回来');
  // 切工具的清场也要重置，否则从空工具切过去会留着隐藏状态
  const reset = app.slice(app.indexOf('function resetTaskPanel'), app.indexOf('async function loadTasks'));
  assert.match(reset, /tEls\.toolbar\.hidden = true/);
});

test('三块分组的数字跟着筛选走，且勾选只覆盖筛出来的那些', () => {
  /* 实测 bug：状态筛选后下面分类卡从 16 组降到 2 组，而上面三块还写着
     "1,360 个文件 / 434.3 MB" —— 屏幕上同时存在两个"这里有多少"的答案。
     根因是筛选只调 renderGroups()，没调 renderSplit()。 */
  const split = app.slice(app.indexOf('function renderSplit'), app.indexOf('function renderRecommend'));
  assert.match(split, /const vis = \(xs\) => xs\.filter\(matches\)/, '三块要按同一套 matches() 过滤');
  assert.match(split, /筛选下没有条目/, '筛空的组要说清是"筛空了"还是"本来就没有"');
  assert.match(split, /筛出 \$\{shown\.length/, 'meta 要写"筛出 N / 一共 M"');

  // 三处触发筛选的地方都要重画 split
  assert.match(app, /renderChips\(\); renderSplit\(\); renderGroups\(\);/);
  assert.match(app, /els\.search\.addEventListener\('input'[\s\S]{0,200}renderSplit\(\); renderGroups\(\)/);
  // Esc 一次清掉搜索 + 状态 + 分组，不管焦点在哪
  assert.match(app, /else if \(state\.q \|\| state\.statuses\.size \|\| state\.group\)/);
  assert.match(app, /renderChips\(\); renderSplit\(\); renderGroups\(\); renderActionbar\(\);/);

  // 点整块只勾筛出来的那些，不偷偷扩大范围
  assert.match(app, /groupOf\(f\) === g && canPick\(f\) && matches\(f\)/);
});

test('会话行不再重复印状态：pill 那一列已删除', () => {
  /* 状态文字原来在 meta 行和右侧药丸各印一遍，药丸吃掉 69px + 12px gap，
     把标题挤到 267px（84 行里 60 行被截断）。 */
  assert.doesNotMatch(app, /class="trow-pill/);
  assert.match(app, /class="trow-state-m \$\{stateTone\(t\)\}"/);
  // 网格从 5 列降到 4 列
  assert.match(css, /\.trow \{[\s\S]{0,200}grid-template-columns: auto auto minmax\(0, 1fr\) auto;/);
});

test('Cursor 的连带回收进详情与抽屉，不进清单行', () => {
  /* 塞进 meta 会撑爆（348px 需要 398px，13 行被截断）；
     塞进体积列会把标题压回 278px。所以它只出现在展开后的详情里。 */
  assert.match(app, /删除会连带回收/);
  assert.match(app, /const exPending = taskState\.exclusive === null && d\.history === 'cursor-db'/);
  assert.match(app, /dstat-pending/, '还没算完时要说"正在算"，不能装作没有连带');
});

test('分类的展开/收起是真正的 button，键盘能走到', () => {
  /* 原来整个 .group-head 靠 click 展开，没有任何可聚焦元素 ——
     键盘用户进不去任何一张分类卡。现在三角是一个真的 <button>，
     带 aria-expanded 与 aria-label；组头里那个"全选"复选框不被卷进按钮语义。 */
  assert.match(app, /<button class="caret-btn" type="button" data-group-toggle=/);
  assert.match(app, /aria-expanded="\$\{isOpen\}" aria-label="\$\{esc\(cat\.label\)\}：/);
  // 重画后要把焦点找回来，否则键盘走到这里就断了
  assert.match(app, /els\.groups\.querySelector\(`\[data-group-toggle="\$\{id\}"\]`\)\?\.focus\(\)/);
  assert.match(css, /\.caret-btn \{[\s\S]{0,300}border: 0/);
});

test('空态要说清是哪个条件筛空的，并给出下一步', () => {
  /* 原来只有一句"没有匹配的条目"，而搜索、状态、分组三个条件可能叠在一起，
     用户不知道该改哪个；提示还挂在列表末尾，离搜索框一百多像素。 */
  assert.match(app, /const why = \[\]/);
  assert.match(app, /一起筛下来是空的/);
  assert.match(app, /按 <kbd>Esc<\/kbd> 清掉搜索/);
  // 提示挪到工具栏正下方
  const html2 = html;
  assert.ok(html2.indexOf('id="emptyHint"') < html2.indexOf('id="groups"'), '空提示要在分组之前');
});

test('点推荐清理却什么都删不掉时，不许给一个按了没反应的按钮', () => {
  /* 实测：Codex 的推荐范围（缓存 71 B + 临时目录 46 B）三个文件全是软链接，
     按钮写着"推荐清理 117 B"，按下去选区是空的、抽屉也不开 —— 屏幕上
     什么也没发生，看起来像工具坏了。 */
  const r = app.slice(app.indexOf('const sumCats'), app.indexOf('const REC_KEY'));
  assert.match(r, /selectableOnly\(all, c\)/, '按钮数字要按"真正能删的"算');
  assert.match(app, /const nothingPickable = on\.length > 0 && count === 0/);
  assert.match(app, /都删不掉 —— 它们是软链接/);
  // openDrawer 里空选区也要有反馈，不能默默 return
  assert.match(app, /showToast\(dropped/);
});

test('两个抽屉的确认串都是"输对才亮"，不是"点了才报错"', () => {
  assert.match(app, /const PURGE_WORD = '彻底删除'/);
  assert.match(app, /const TASK_PURGE_WORD = '清理'/);
  assert.match(app, /els\.drawerGo\.disabled = !ok/);
  assert.match(app, /tEls\.go\.disabled = !ok/);
  // 收尾时按真实状态恢复，不要无条件打开
  assert.match(app, /tEls\.go\.disabled = tEls\.word\.value !== TASK_PURGE_WORD/);
});
