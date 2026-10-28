/**
 * 视图层的契约测试。
 *
 * 与它替换掉的 frontend-static.test.mjs 的区别，是这一层的**判据**变了：
 *
 *   旧：在源码里找某个字符串（`assert.match(app, /tabindex="\$\{on \? .../)`）
 *   新：拿夹具调用渲染函数，断言它产出的 HTML
 *
 * 为什么用契约而不是源码字面：源码正则保护的是"这段代码怎么写的"。想改模板的排版、把
 * 三元表达式换成 if、把两个 span 合并成一个 —— 只要行为没变，这些断言
 * 都会变红。于是重构的第一步永远被自己的测试挡住，而真正的回归（比如
 * 受保护项突然变成可勾）反倒不一定被抓住，因为它藏在一堆字符串里。
 *
 * 新写法锁的是**用户看得见的结果**：
 *   · 软链接与受保护项没有可点的复选框（disabled + 说明）
 *   · 分组框按"真正能勾的行"算，不是按全部行
 *   · 空态说清是哪个条件筛空的
 *   · 展开态/收起态各自存在且互斥
 *   · 一切文本都经过转义（分类名里放 <script> 不会变成标签）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, icon, badge, STATUS_CLASS, STATUS_LABEL,
} from '../public/views/shared.js';
import {
  canPickWith, selectableOnlyWith, rowHtml, groupCard, emptyHintHtml,
  caretBtn, groupBox, MAX_ROWS,
} from '../public/views/files.js';

/* ── 夹具 ─────────────────────────────────────────────────── */

const cat = (over = {}) => ({
  id: 'cache', label: '缓存', status: 'good', verdict: 'safe', icon: 'box',
  bytes: 1024 * 1024, count: 2, outcome: '下次联网重新拉取', what: '缓存目录', why: '跑起来就有',
  action: null, ...over,
});

const file = (over = {}) => ({
  p: 'cache/foo.bin', t: 'root', s: 1024, m: Date.parse('2026-10-01T00:00:00Z'),
  k: 'root:cache/foo.bin', ...over,
});

const ctx = (over = {}) => ({
  selection: new Set(),
  multiTarget: false,
  canReveal: true,
  targets: [{ key: 'root', short: '~/.app', label: '主目录' }],
  appLabel: '某工具',
  ...over,
});

/* ── 转义：屏幕上不许出现能变成标签的东西 ─────────────────── */

test('esc：五种字符全转，且不会二次转义已转好的内容', () => {
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('a & b'), 'a &amp; b');
  assert.equal(esc(`"'`), '&quot;&#39;');
  // 已经是实体串的，& 会被再转一次 —— 这是对的：它是字面量，不是实体
  assert.equal(esc('&amp;'), '&amp;amp;');
  assert.equal(esc(null), 'null');
  assert.equal(esc(undefined), 'undefined');
  assert.equal(esc(0), '0');
});

test('分类名与到期说明里的尖括号被转义，不会撑破 HTML', () => {
  const evil = cat({ label: '<img src=x onerror=alert(1)>', outcome: '</span><script>x</script>' });
  const html = groupCard({
    cat: evil, files: [file()], totalHere: 1, isOpen: true,
    explain: true, selCount: 0, pickable: 1, rowCtx: ctx(),
  });
  assert.ok(!html.includes('<img'), '标签名不该原样出现');
  assert.ok(!html.includes('<script'), '不该出现真的 script 标签');
  assert.ok(html.includes('&lt;img'), '应当以转义形式出现');
});

/* ── 可选中判据 ───────────────────────────────────────────── */

test('可选中：受保护分类与软链接都不行，其余可以', () => {
  assert.equal(canPickWith(file(), cat()), true);
  assert.equal(canPickWith(file(), cat({ verdict: 'never' })), false);
  assert.equal(canPickWith(file(), cat({ verdict: 'review' })), true);
  // 软链接：即使分类是可清的，也不行 —— 服务端一律拒绝删除
  assert.equal(canPickWith(file({ link: true }), cat()), false);
  // 分类缺失/未定义 verdict：保守拒绝，不是放行
  assert.equal(canPickWith(file(), null), false);
  assert.equal(canPickWith(file(), {}), false);
  assert.equal(canPickWith(file(), cat({ verdict: undefined })), false);
});

test('可选中：一批里筛掉软链接与受保护项', () => {
  const files = [
    file({ k: 'a' }),
    file({ k: 'b', link: true }),
    file({ k: 'c' }),
    file({ k: 'd' }),
  ];
  assert.deepEqual(selectableOnlyWith(files, cat()).map((f) => f.k), ['a', 'c', 'd']);
  assert.deepEqual(selectableOnlyWith(files, cat({ verdict: 'never' })), []);
});

/* ── 行 ───────────────────────────────────────────────────── */

test('行：可清的行有启用的复选框，受保护的有 disabled 与说明', () => {
  const ok = rowHtml(file(), cat(), ctx());
  assert.match(ok, /<input type="checkbox" data-key="root:cache\/foo.bin"/);
  assert.ok(!ok.includes('disabled'), '可清的行不该被禁用');

  const locked = rowHtml(file(), cat({ verdict: 'never' }), ctx());
  assert.match(locked, /disabled/);
  assert.match(locked, /aria-label="受保护内容"/);
});

test('行：软链接不可勾，并在行上写明原因（而不是让人点一下才报错）', () => {
  const html = rowHtml(file({ link: true, k: 'k' }), cat(), ctx());
  assert.match(html, /disabled aria-label="符号链接，不可清理"/);
  assert.match(html, /软链接/);
  // 行本身带 is-link 类，样式上也要能区分
  assert.match(html, /class="row\s+is-link"/);
});

test('行：已选中的行带 checked 与 is-on', () => {
  const html = rowHtml(file(), cat(), ctx({ selection: new Set(['root:cache/foo.bin']) }));
  assert.match(html, /checked/);
  assert.match(html, /class="row is-on"/);
});

test('行："在 Finder 中显示"只在支持的平台上出现', () => {
  assert.match(rowHtml(file(), cat(), ctx({ canReveal: true })), /data-reveal=/);
  assert.ok(!rowHtml(file(), cat(), ctx({ canReveal: false })).includes('data-reveal='));
});

test('行：多扫描目标时标出这一行落在哪个根下', () => {
  const t = [{ key: 'ide', short: 'Cursor', label: 'App Support' }];
  const withMulti = rowHtml(file({ t: 'ide' }), cat(), ctx({ multiTarget: true, targets: t }));
  assert.match(withMulti, /row-tag/);
  assert.match(withMulti, /App Support/);
  // 单目标时不加这个标签 —— 它只在"相对路径看不出归属"时才有信息量
  assert.ok(!rowHtml(file(), cat(), ctx({ multiTarget: false })).includes('row-tag'));
});

test('行：孤儿会话只标"孤儿"两个字，完整会话 id 进 title', () => {
  const html = rowHtml(file({ sid: 'deadbeef', orphan: true }), cat(), ctx());
  assert.match(html, />孤儿</);
  assert.match(html, /title="会话 deadbeef 已不在/);
  // 非孤儿不打标
  assert.ok(!rowHtml(file({ sid: 'deadbeef', orphan: false }), cat(), ctx()).includes('孤儿'));
});

test('行：体积与时间都在，体积带精确字节的 title', () => {
  /* 1536 字节 → "2 KB"：KB 档留 0 位小数，这是 fmtBytes 的既有口径
     （logic.js 里有测试钉住）。悬停时给精确值，所以行内四舍五入不丢信息。 */
  const html = rowHtml(file({ s: 1536 }), cat(), ctx());
  assert.match(html, /row-size" title="1,536 字节">2 KB/, '体积按 1024 进制且带精确字节');
  assert.match(html, /row-time/);
});

/* ── 分组框的状态 ─────────────────────────────────────────── */

test('分组框：选中数按"能勾的行"算 —— 全勾上才是 checked', () => {
  assert.match(groupBox(cat(), 0, 3), /^(?!.*checked)/);
  // 3 个能勾、勾了 3 个 → checked
  assert.match(groupBox(cat(), 3, 3), /checked/);
  // 3 个能勾、勾了 1 个 → indeterminate，不是 checked
  const partial = groupBox(cat(), 1, 3);
  assert.match(partial, /data-indeterminate="1"/);
  assert.ok(!/\schecked/.test(partial), '半选不该同时带 checked');
});

test('分组框：受保护分类整块禁用', () => {
  const html = groupBox(cat({ verdict: 'never' }), 0, 0);
  assert.match(html, /\bdisabled\b/);
  assert.match(html, /aria-label="受保护内容，不可清理"/);
  assert.equal((html.match(/aria-label=/g) || []).length, 1);
});

/* ── 卡片 ─────────────────────────────────────────────────── */

test('卡片：收起时不画行，展开时画', () => {
  const base = { cat: cat(), files: [file(), file({ k: 'b', p: 'cache/bar.bin' })], totalHere: 2, explain: false, selCount: 0, pickable: 2, rowCtx: ctx() };
  const closed = groupCard({ ...base, isOpen: false });
  assert.ok(!closed.includes('group-body'), '收起态不该有行容器');
  assert.ok(!closed.includes('data-key='), '收起态不该画任何行');

  const open = groupCard({ ...base, isOpen: true });
  assert.match(open, /class="group-body"/);
  assert.match(open, /data-key="root:cache\/foo.bin"/);
});

test('卡片：展开态的三角 aria-expanded=true，收起态 false', () => {
  assert.match(caretBtn(cat(), true), /aria-expanded="true"/);
  assert.match(caretBtn(cat(), true), /：收起清单/);
  assert.match(caretBtn(cat(), false), /aria-expanded="false"/);
  assert.match(caretBtn(cat(), false), /：展开清单/);
});

test('卡片：筛选后只有数字真的不同才写"筛出 N / M"与整类体积', () => {
  const all = [file(), file({ k: 'b', s: 1024 })];
  // 没筛：总数一致，不写"筛出"
  const noFilter = groupCard({
    cat: cat({ bytes: 2048 }), files: all, totalHere: 2, isOpen: false,
    explain: false, selCount: 0, pickable: 2, rowCtx: ctx(),
  });
  assert.ok(!noFilter.includes('筛出'));
  assert.ok(!noFilter.includes('/ ' + '1.0 KB'), '没筛时不写两个一样的数');

  // 筛过：写"筛出 1 / 2"
  const filtered = groupCard({
    cat: cat({ bytes: 2048 }), files: [all[0]], totalHere: 2, isOpen: false,
    explain: false, selCount: 0, pickable: 2, rowCtx: ctx(),
  });
  assert.match(filtered, /筛出 1 \/ 2 项/);
});

test('卡片：已选数写进计数那句话', () => {
  const html = groupCard({
    cat: cat(), files: [file(), file({ k: 'b' })], totalHere: 2, isOpen: false,
    explain: false, selCount: 1, pickable: 2, rowCtx: ctx(),
  });
  assert.match(html, /，已选 1/);
});

test('卡片：受保护分类带 is-locked，视觉上要能看出来', () => {
  const html = groupCard({
    cat: cat({ verdict: 'never' }), files: [], totalHere: 0, isOpen: false,
    explain: false, selCount: 0, pickable: 0, rowCtx: ctx(),
  });
  assert.match(html, /is-locked/);
});

test('卡片：超过 MAX_ROWS 时只画前面那些，并说明还有多少', () => {
  const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => file({ k: `k${i}`, p: `f/${i}` }));
  const html = groupCard({
    cat: cat(), files: many, totalHere: many.length, isOpen: true,
    explain: false, selCount: 0, pickable: many.length, rowCtx: ctx(),
  });
  assert.equal((html.match(/data-key=/g) || []).length, MAX_ROWS, '只该画 MAX_ROWS 行');
  assert.match(html, /还有 5 项/);
});

test('卡片：展开但筛空了，说"没有匹配的条目"而不是留一片空白', () => {
  const html = groupCard({
    cat: cat(), files: [], totalHere: 3, isOpen: true,
    explain: false, selCount: 0, pickable: 3, rowCtx: ctx(),
  });
  assert.match(html, /没有匹配的条目/);
});

test('卡片：说明面板展开时才有内容', () => {
  const withExplain = groupCard({
    cat: cat(), files: [], totalHere: 0, isOpen: false,
    explain: true, selCount: 0, pickable: 0, rowCtx: ctx(),
  });
  assert.match(withExplain, /class="group-explain"/);
  assert.match(withExplain, /这是什么/);
  assert.match(withExplain, /为什么在这里/);
  assert.match(withExplain, /收起说明/);

  const closed = groupCard({
    cat: cat(), files: [], totalHere: 0, isOpen: false,
    explain: false, selCount: 0, pickable: 0, rowCtx: ctx(),
  });
  assert.ok(!closed.includes('group-explain'));
  assert.match(closed, /这是什么，为什么在这里/);
});

/* ── 空态文案 ─────────────────────────────────────────────── */

test('空态：没说清是哪个条件筛空的，等于什么也没说', () => {
  const one = emptyHintHtml({ q: 'abc' });
  assert.match(one.html, /搜索「abc」/);
  assert.match(one.html, /一起筛下来是空的/);
  assert.match(one.html, /Esc/);

  // 三个条件叠在一起时要全列出来 —— 用户才知道该撤哪一个
  const many = emptyHintHtml({ q: 'abc', statuses: new Set(['good', 'critical']), group: 'orphan' });
  assert.match(many.html, /搜索「abc」/);
  assert.match(many.html, /可安全清理/);
  assert.match(many.html, /请勿删除/);
  assert.match(many.html, /只在这一组里/);
});

test('空态：状态筛选里出现字典外的值时，原样显示而不是漏掉', () => {
  // 后端将来加一档而前端字典没跟，用户至少还能看到那个 key —— 不能静默吞掉
  const html = emptyHintHtml({ statuses: new Set(['unknown-tier']) }).html;
  assert.match(html, /unknown-tier/);
});

test('空态：什么条件都没设时只给一句实话，不编理由', () => {
  const none = emptyHintHtml({});
  assert.equal(none.html, '没有匹配的条目。');
});

/* ── 徽标与图标 ───────────────────────────────────────────── */

test('徽标：档位决定颜色类，文字优先用 action', () => {
  assert.match(badge(cat({ status: 'good', action: null })), /st-good/);
  // 受保护项：verdict=never 对应的档位是 critical
  assert.match(badge(cat({ status: 'critical', verdict: 'never' })), /st-critical/);
  assert.match(badge(cat({ action: '自定义文案' })), /自定义文案/);
  // 没有 action 时退回档位的人话
  assert.match(badge(cat({ status: 'warning', action: null })), /谨慎清理/);
  // 档位不在字典里时不能印出 "undefined" —— 那会让屏幕撒谎
  const unknown = badge({ status: 'nope', icon: 'box' });
  assert.ok(!/class="badge undefined"/.test(unknown), '未知档位不该产出 undefined 类名');
  assert.ok(!/>undefined</.test(unknown), '未知档位不该印出 undefined');
});

test('图标：认识的名字给对应路径，不认识的回落到方块', () => {
  assert.match(icon('db'), /ellipse/);
  assert.match(icon('key'), /circle/);
  assert.match(icon('不存在的名字'), /3 8\.5 12 4/, '应当回落到 box');
  assert.match(icon('db', 'extra'), /class="extra"/);
});

test('状态字典与档位一一对应，没有漏档', () => {
  for (const k of ['good', 'warning', 'serious', 'critical']) {
    assert.ok(STATUS_CLASS[k], `缺 CSS 类：${k}`);
    assert.ok(STATUS_LABEL[k], `缺人话：${k}`);
    assert.match(STATUS_CLASS[k], new RegExp(`^st-${k}$`));
  }
});

/* ── 「全部」视图：折叠分组与工具状态 ─────────────────────── */

/* 这一组测试对应一次真实的效率测量：119 个会话分布在 12 个文件夹里，
   其中一个文件夹装了 90 个 —— 全部铺开是 5514px，整页六屏，而用户要找的
   那一段几乎总在最上面。折叠之后 1850px，两屏。 */
import {
  groupSessions, sessionGroup, sessionGroupHead, sessionGroupRows,
  allLedeHtml, toolFilterChip, DEFAULT_OPEN_GROUPS, ROWS_PER_GROUP,
} from '../public/views/all.js';

const sess = (over = {}) => ({
  app: 'zcode', appLabel: 'ZCode', title: '会话', workspace: '/w/a',
  updatedAt: 1_700_000_000_000, bytes: 1024, ...over,
});

test('分组：按文件夹归并，组内与组间都按最近使用降序', () => {
  const { groups } = groupSessions([
    sess({ title: 'a1', workspace: '/w/a', updatedAt: 100 }),
    sess({ title: 'b1', workspace: '/w/b', updatedAt: 300 }),
    sess({ title: 'a2', workspace: '/w/a', updatedAt: 200 }),
  ]);
  assert.equal(groups.length, 2);
  // 组间：/w/b 最近（300）在前
  assert.equal(groups[0].ws, '/w/b');
  // 组内：a2(200) 在 a1(100) 之前
  const a = groups.find((g) => g.ws === '/w/a');
  assert.deepEqual(a.rows.map((r) => r.title), ['a2', 'a1']);
});

test('分组：工具筛选与搜索都能收窄，且如实报匹配数', () => {
  const tasks = [
    sess({ app: 'zcode', title: '数据库迁移', workspace: '/w/a' }),
    sess({ app: 'codex', title: '数据库回滚', workspace: '/w/b' }),
    sess({ app: 'codex', title: '前端样式', workspace: '/w/b' }),
  ];
  const byTool = groupSessions(tasks, { tools: new Set(['codex']) });
  assert.equal(byTool.matched, 2);
  assert.equal(byTool.total, 3);

  const byQ = groupSessions(tasks, { q: '数据库' });
  assert.equal(byQ.matched, 2);

  // 两个条件同时生效
  const both = groupSessions(tasks, { tools: new Set(['codex']), q: '数据库' });
  assert.equal(both.matched, 1);
});

test('分组：工作区为空的会话单独成组，组名不用空字符串', () => {
  const { groups } = groupSessions([sess({ workspace: '' })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].base, '（还原不出文件夹）');
  assert.equal(groups[0].path, '（还原不出文件夹）');
});

test('组头：折叠时它是唯一可见的东西，所以必须带齐名字、路径、条数、体积', () => {
  const { groups } = groupSessions([
    sess({ workspace: '/Users/x/proj', bytes: 2048 }),
    sess({ workspace: '/Users/x/proj', bytes: 2048 }),
  ]);
  const head = sessionGroupHead(groups[0], false);
  assert.match(head, /proj/, '要有文件夹名');
  assert.match(head, /~\/proj/, '路径要缩成 ~');
  assert.match(head, /2 个/, '要有条数');
  assert.match(head, /4 KB|4\.0 KB/, '要有合计体积');
  assert.match(head, /aria-expanded="false"/);
  assert.match(head, /：展开 2 个会话/);
});

test('折叠状态不画行；展开才画 —— 这是六屏变两屏的关键', () => {
  const { groups } = groupSessions([sess({ title: '很长的标题' })]);
  const closed = sessionGroup(groups[0], false);
  assert.ok(!closed.includes('all-row'), '折叠时不该有任何行');
  assert.ok(!closed.includes('很长的标题'), '折叠时不该有标题文字');

  const open = sessionGroup(groups[0], true);
  assert.match(open, /all-row/);
  assert.match(open, /很长的标题/);
});

test('展开的组也只列 ROWS_PER_GROUP 行，其余交给搜索', () => {
  const many = Array.from({ length: ROWS_PER_GROUP + 7 }, (_, i) =>
    sess({ title: `会话${i}`, workspace: '/w/a' }));
  const { groups } = groupSessions(many);
  const html = sessionGroupRows(groups[0]);
  assert.equal((html.match(/all-row/g) || []).length, ROWS_PER_GROUP);
  assert.match(html, /还有 7 个会话/);
  assert.match(html, /用上面的搜索框/, '要告诉人下一步怎么做，而不只是说"还有很多"');
});

test('默认展开的组数是个小常数 —— 展开太多就退回六屏', () => {
  // 这条钉的是设计意图：折叠的价值全部来自"只开前面几个"
  assert.ok(DEFAULT_OPEN_GROUPS >= 1 && DEFAULT_OPEN_GROUPS <= 3,
    `默认展开 ${DEFAULT_OPEN_GROUPS} 组太贪或太少`);
});

test('汇总句：搜索筛出更少的会话时如实说"当前筛出 N 个"', () => {
  const d = { tools: [{}, {}], total: 100, bytes: 1024 * 1024, groups: [] };
  const all = allLedeHtml(d);
  assert.ok(!all.includes('当前筛出'), '没筛时不提');

  const filtered = allLedeHtml(d, 3);
  assert.match(filtered, /当前筛出 <b>3<\/b> 个/);
});

test('工具状态：零会话给灰标签，有提示仍是正常钮，真读不到才红', () => {
  // 真故障：一条会话都没有，且报了错
  const fail = toolFilterChip({ app: 'x', label: 'X', count: 0, error: '库打不开' }, true);
  assert.match(fail, /all-tool is-err/);
  assert.match(fail, /读不到/);

  // 零会话但没报错：灰标签，说明"没有它的会话"
  const zero = toolFilterChip({ app: 'x', label: 'X', count: 0 }, true);
  assert.match(zero, /这次汇总里没有它的会话/);
  assert.ok(!zero.includes('is-err'));

  // 有 4 个会话 + 一条提示：正常筛选钮，提示进 tooltip
  const ok = toolFilterChip({ app: 'dsh', label: 'DeepSeek', count: 4, error: '有 2 条没有投影缓存' }, true);
  assert.match(ok, /data-all-tool="dsh"/);
  assert.ok(!ok.includes('is-err'), '有会话时不该显示成故障');
  assert.ok(!/>[^<]*读不到/.test(ok), '有会话时不该在版面上说"读不到"');
  assert.match(ok, /提示：有 2 条没有投影缓存/, '提示要保留，只是放进 tooltip');
});

test('工具状态：选中态真的反映在 aria-pressed 上', () => {
  assert.match(toolFilterChip({ app: 'a', label: 'A', count: 2 }, true), /aria-pressed="true"/);
  assert.match(toolFilterChip({ app: 'a', label: 'A', count: 2 }, false), /aria-pressed="false"/);
});

/* ── 会话面板模板（views/tasks.js）──────────────────────────
   模板住在 views/tasks.js 之后，"在源码里找字符串"的断言换成对
   产出的直接断言 —— 锁的是用户看得见的结果，不是上次的写法。 */

import {
  isPurgeable, stateLabel, stateTone, STATE_TONE, STATE_META_CN, STATUS_CLASS_TONE,
  taskSelTotals, taskQuickSet, visibleTasks, groupTasksByWorkspace,
  dbBarSegments, taskRowHtml, taskGroupHtml, recoverRowHtml, dryRunHtml, checkLine,
  fileBasedNote, REASON_LABEL, REASON_TONE,
  CONTENT_ROLE_LABEL, taskContentsHtml, mergeByRole,
} from '../public/views/tasks.js';
import { auditSummary, auditLedeHtml, auditToolHtml, auditHitGroups, auditGroupHtml } from '../public/views/audit.js';

const trow = (over = {}) => ({
  id: 'sess-1', title: '迁移数据库', workspace: '/Users/x/proj', state: 'active', reason: null,
  bytes: 2048, updatedAt: Date.parse('2026-10-01T00:00:00Z'), createdAt: Date.parse('2026-10-01T00:00:00Z'),
  model: 'm', children: 0, rows: 3, typeLabel: '对话', bodyRel: null, residual: false,
  lineage: null, pinned: false, ...over,
});

test('状态文案：reason 优先于 state，两者都有档位映射', () => {
  assert.equal(stateLabel(trow({ reason: 'deleted', state: 'active' })), '已在界面删除');
  assert.equal(stateLabel(trow({ reason: null, state: 'active' })), '活跃会话');
  assert.equal(stateTone(trow({ reason: 'manual', state: 'active' })), 'st-warning');
  assert.equal(stateTone(trow({ reason: null, state: 'deleted' })), 'st-serious');
  for (const k of Object.keys(REASON_LABEL)) assert.ok(REASON_TONE[k], `reason ${k} 缺色档`);
  for (const k of Object.keys(STATE_META_CN)) assert.ok(STATE_TONE[k], `state ${k} 缺色档`);
  for (const k of Object.values(STATUS_CLASS_TONE)) assert.match(k, /^st-/);
});

test('可清理判定：reason 有值即可勾，缺失不可勾', () => {
  assert.equal(isPurgeable(trow({ reason: 'deleted' })), true);
  assert.equal(isPurgeable(trow({ reason: null })), false);
  assert.equal(isPurgeable(trow({ reason: 'manual', state: 'active' })), true);
});

test('会话行：受保护的行复选框禁用，可清的行不禁用', () => {
  const open = taskRowHtml(trow({ reason: 'deleted' }), { sel: false, open: false, showWorkspace: true });
  assert.ok(!open.includes('disabled'), '可清的行不该禁用复选框');

  const locked = taskRowHtml(trow({ reason: null }), { sel: false, open: false, showWorkspace: true });
  assert.match(locked, /disabled/);
  assert.match(locked, /aria-label="选择会话/);
  assert.match(locked, /活跃会话/);
});

test('会话行：勾选与展开的态都长在类名与属性上', () => {
  const on = taskRowHtml(trow(), { sel: true, open: false, showWorkspace: true });
  assert.match(on, /class="trow is-on"/);
  assert.match(on, /checked/);
  assert.ok(!on.includes('tdetail'), '收起态不该有详情');

  const open = taskRowHtml(trow(), { sel: false, open: true, showWorkspace: false });
  assert.match(open, /class="tsession is-open"/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /复制会话 ID/);
});

test('会话行：分页续段把"删了毁整条会话"写在详情里', () => {
  const html = taskRowHtml(
    trow({ lineage: { continuation: true, endOrdinal: 7 } }),
    { sel: false, open: true, showWorkspace: true });
  assert.match(html, /分页第 7 段起/);
  assert.match(html, /missing source rollout/);
  assert.match(html, /删掉任何一段，整条会话都再也恢复不了/);
});

test('会话行：Cursor 独占 blob 只进详情，不进清单行', () => {
  const plain = taskRowHtml(trow(), { sel: false, open: false, showWorkspace: true });
  assert.ok(!plain.includes('连带回收'));

  const open = taskRowHtml(trow(), {
    sel: false, open: true, showWorkspace: true,
    exclusive: { exclusiveBytes: 1536, exclusiveBlobs: 2 },
  });
  assert.match(open, /删除会连带回收/);
  // 1536 字节按 fmtBytes 的既有口径（KB 档 0 位小数）印成 "2 KB"，精确值在 title 里
  assert.match(open, /<b>2 KB<\/b>/);
  assert.match(open, /title="1,536 字节"/);
});

test('分组头：折叠时名字、路径、条数、体积都在', () => {
  const g = { ws: '/Users/x/proj', tasks: [trow(), trow()], bytes: 4096 };
  const html = taskGroupHtml(g, { folded: false, selCount: 1, rowsHtml: '<div>row</div>' });
  assert.match(html, /<b>proj<\/b>/);
  assert.match(html, /~\/proj/);
  assert.match(html, /2 个会话，已选 1/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<div>row<\/div>/);

  const folded = taskGroupHtml(g, { folded: true, selCount: 0, rowsHtml: '<div>row</div>' });
  assert.ok(!folded.includes('tgroup-body'), '折叠时不画行');
  assert.match(folded, /aria-expanded="false"/);
});

test('空标题的工作区分组不冒充有名字', () => {
  const g = { ws: '(未知工作区)', tasks: [trow()], bytes: 1 };
  const html = taskGroupHtml(g, { folded: false, selCount: 0, rowsHtml: '' });
  assert.match(html, /<b>\(未知工作区\)<\/b>/);
});

test('groupTasksByWorkspace：无主工作区归一组，组按体积降序', () => {
  const groups = groupTasksByWorkspace([
    trow({ workspace: '', bytes: 2 }), trow({ id: 'b', workspace: '/w/a', bytes: 1 }),
    trow({ id: 'c', workspace: '/w/b', bytes: 100 }),
  ]);
  assert.equal(groups[0].ws, '/w/b');
  assert.equal(groups[1].ws, '(未知工作区)', '空工作区单独成组，体积排在其真实大小该在的位置');
  assert.equal(groups[0].bytes, 100);
});

test('visibleTasks：状态筛选、搜索与三种排序', () => {
  const d = { tasks: [
    trow({ id: 'a', title: '迁移数据库', bytes: 10, updatedAt: 3 }),
    trow({ id: 'b', title: '写前端', workspace: '/w/web', bytes: 30, updatedAt: 2 }),
    trow({ id: 'c', title: '修 bug', bytes: 20, updatedAt: 1, state: 'deleted' }),
  ] };
  assert.deepEqual(visibleTasks(d, { states: new Set(), q: '', sort: 'size' }).map((x) => x.id), ['b', 'c', 'a']);
  assert.deepEqual(visibleTasks(d, { states: new Set(), q: '', sort: 'time' }).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(visibleTasks(d, { states: new Set(['deleted']), q: '' }).map((x) => x.id), ['c']);
  assert.deepEqual(visibleTasks(d, { states: new Set(), q: '前端' }).map((x) => x.id), ['b']);
  assert.equal(visibleTasks(null, { states: new Set(), q: '' }).length, 0);
});

test('taskSelTotals：合计只算勾选的行', () => {
  const d = { tasks: [trow({ id: 'a', bytes: 10, children: 1, rows: 2 }), trow({ id: 'b', bytes: 100, children: 0, rows: 5 })] };
  const s = taskSelTotals(d, new Set(['a']));
  assert.equal(s.count, 1);
  assert.equal(s.bytes, 10);
  assert.equal(s.children, 1);
  assert.equal(s.rows, 2);
  assert.equal(taskSelTotals(null, new Set()).count, 0);
});

test('taskQuickSet：只勾已删除的，跳过近期与置顶', () => {
  const now = Date.now();
  const d = { tasks: [
    trow({ id: 'old', state: 'deleted', reason: 'deleted', updatedAt: now - 90 * 86400000 }),
    trow({ id: 'recent', state: 'deleted', reason: 'deleted', updatedAt: now - 3 * 86400000 }),
    trow({ id: 'pinned', state: 'deleted', reason: 'deleted', updatedAt: now - 90 * 86400000, pinned: true }),
    trow({ id: 'live', state: 'active', updatedAt: now - 90 * 86400000 }),
  ] };
  const s = taskQuickSet(d, { ageDays: 30, skipPinned: true });
  assert.deepEqual(s.tasks.map((x) => x.id), ['old']);
  assert.equal(s.skippedRecent, 1);
  assert.equal(s.skippedPinned, 1);
  assert.equal(s.total, 3);

  // 放宽两个开关，置顶与近期都进来
  const wide = taskQuickSet(d, { ageDays: 0, skipPinned: false });
  assert.equal(wide.tasks.length, 3);
  assert.equal(taskQuickSet(null, { ageDays: 0, skipPinned: false }).tasks.length, 0);
});

test('dbBarSegments：分段之和等于分母，整数宽度合计恰好 100', () => {
  const d = {
    db: { total: 700, bodies: { bytes: 300 } },
    fileBased: false,
    totals: { byState: [
      { state: 'active', bytes: 600, count: 2 },
      { state: 'deleted', bytes: 200, count: 1 },
    ] },
  };
  const { segs, floors, total } = dbBarSegments(d);
  assert.equal(total, 1000);
  assert.equal(segs.reduce((s, x) => s + x.bytes, 0), 1000, '余量段把分母补齐');
  assert.equal(floors.reduce((a, b) => a + b, 0), 100, '宽度合计恒为 100');
  // 状态段的标签走中文字典；最后一段是余量
  assert.equal(segs[0].label, '活跃会话');
  assert.equal(segs[segs.length - 1].key, 'overhead');
});

test('dbBarSegments：文件型工具没有库时分母就是正文文件', () => {
  const d = {
    db: { total: 0, bodies: { bytes: 100 } },
    fileBased: true,
    totals: { byState: [{ state: 'active', bytes: 80, count: 1 }] },
  };
  const { segs } = dbBarSegments(d);
  const last = segs[segs.length - 1];
  assert.equal(last.bytes, 20);
  assert.equal(last.label, '未归入会话的文件');
});

test('dryRunHtml：逐库逐表形状与 Cursor 形状分开渲染', () => {
  const perDb = dryRunHtml({ perDb: [{ name: 'db.sqlite', table: 'session', count: 2 }, { name: 'db.sqlite', table: 'message', count: 5 }] });
  assert.equal(perDb.totalRows, 7);
  assert.match(perDb.rowsHtml, /session（db\.sqlite）/);
  assert.equal(perDb.bodiesHtml, '');

  const cursor = dryRunHtml({ sessionRows: 3, sessions: 1, blobs: 9, sessionBytes: 1024, blobBytes: 2048 });
  assert.equal(cursor.totalRows, 3);
  assert.match(cursor.rowsHtml, /连带删除的工具结果 blob/);
  // 1024+2048=3072 字节 → KB 档 0 位小数 → "3 KB"
  assert.match(cursor.bodiesHtml, /<b>3 KB<\/b>/);

  const codex = dryRunHtml({ perDb: [], bodyBytes: 4096 });
  assert.match(codex.bodiesHtml, /rollout 文件里/);
});

test('checkLine：三种返回形状都说成人话，不用别人的术语', () => {
  assert.equal(checkLine({ integrity: 'ok', fkViolations: 0 }), '完整性 ok，外键违规 0。');
  assert.equal(checkLine({ integrity: 'ok', dangling: 2 }), '完整性 ok，悬空引用 2 处。');
  assert.equal(
    checkLine({ integrity: [{ name: 'a.sqlite', integrity: 'ok', fkViolations: 0 }, { name: 'b.sqlite', integrity: 'ok', fkViolations: 0 }] }),
    '2 个库完整性全部 ok，外键违规 0。');
  assert.equal(
    checkLine({ integrity: [{ name: 'a.sqlite', integrity: 'ok', fkViolations: 0 }, { name: 'b.sqlite', integrity: 'corrupt', fkViolations: 1 }] }),
    'a.sqlite ok/违规 0，b.sqlite corrupt/违规 1。');
});

test('recoverRow：勾选态长在类名上，路径未还原要说出来', () => {
  const s = { id: 'orphan-1', title: '丢失的会话', workspace: '/w/a', date: 1790000000000, messages: 3, tools: 2, bytes: 512, workspaceResolved: true };
  const plain = recoverRowHtml(s, false);
  assert.ok(!plain.includes('is-on'));
  assert.ok(!plain.includes('路径未还原'));

  const sel = recoverRowHtml({ ...s, workspaceResolved: false }, true);
  assert.match(sel, /recover-row is-on/);
  assert.match(sel, /checked/);
  assert.match(sel, /路径未还原/);
  assert.match(sel, /aria-label="选择会话 丢失的会话"/);
});

test('fileBasedNote：适配器给了文案就用它的，缺了退回通用句', () => {
  assert.match(fileBasedNote({ appLabel: 'Claude Code', fileBasedNote: '正文在 projects/ 下。' }), /正文在 projects\/ 下。/);
  assert.match(fileBasedNote({ appLabel: '某工具' }), /没有数据库行可删/);
  assert.match(fileBasedNote({}), /这个工具/);
});

/* ── 安全审计视图（views/audit.js）────────────────────────── */

const ahit = (over = {}) => ({
  title: '有泄漏的会话', bodyRel: 'x/bubble.json', truncated: false, sensitiveReadCount: 0,
  sensitiveReads: [], findings: [], ...over,
});

test('auditSummary：跨 app 归并三档计数与规模', () => {
  const d = { apps: [
    { totals: { high: 2, medium: 1, info: 3 }, sessionsScanned: 10, bytesScanned: 1000, problems: ['a 库慢'] },
    { totals: { high: 0, medium: 0, info: 0 }, sessionsScanned: 5, bytesScanned: 500 },
    { absent: true, sessionsScanned: 0, bytesScanned: 0 },
  ] };
  const s = auditSummary(d);
  assert.deepEqual(s.totals, { h: 2, m: 1, i: 3 });
  assert.equal(s.scanned, 15);
  assert.equal(s.bytes, 1500);
  assert.equal(s.problems.length, 1);
  assert.match(s.problems[0], /a 库慢/);
});

test('auditLede：命中与规模都在那一句里，只读说明带在后面', () => {
  const s = auditSummary({ apps: [{ totals: { high: 1, medium: 2, info: 3 }, sessionsScanned: 4, bytesScanned: 2048 }] });
  const html = auditLedeHtml({}, s);
  assert.match(html, /4/);
  assert.match(html, /1<\/b> 处高危/);
  assert.match(html, /2<\/b> 处疑似/);
  assert.match(html, /只读/);
});

test('auditTool：未安装、暂不支持、三档计数三种形态', () => {
  // 缺库的 app 在服务端响应里 supported 恒为真值（absent 单独标）
  assert.match(auditToolHtml({ app: 'x', label: 'X', supported: true, absent: true, totals: {} }), /未安装/);
  assert.match(auditToolHtml({ app: 'x', label: 'X', supported: false, reason: '没适配' }), /暂不支持/);
  const ok = auditToolHtml({ app: 'x', label: 'X', supported: true, totals: { high: 2, medium: 1, info: 4 }, sessionsScanned: 9, ms: 12 });
  assert.match(ok, /data-app-tone="x"/);
  assert.match(ok, /is-high/);
  assert.match(ok, /次读取/);
  assert.match(ok, /扫了 9 个会话/);
});

test('auditHitGroups：只有高危/疑似的会话成组，且按严重度排序', () => {
  const d = { apps: [
    { app: 'a', label: 'A', hits: [ahit({ title: '低', findings: [{ level: 'info' }] }), ahit({ title: '高', findings: [{ level: 'high' }, { level: 'high' }] })] },
    { app: 'b', label: 'B', hits: [ahit({ title: '中', findings: [{ level: 'medium' }] })] },
  ] };
  const groups = auditHitGroups(d);
  assert.deepEqual(groups.map((g) => g.h.title), ['高', '中'], 'info-only 的不进列表');
});

test('auditGroup：掩码证据转义，敏感读取只做背景说明', () => {
  const html = auditGroupHtml(
    { app: 'a', label: '<b>A</b>' },
    ahit({
      findings: [{ level: 'high', kind: 'secret-out', style: 'aws-key', valueMasked: 'AKIA****', from: '/Users/x/.env', evidence: 'export AWS_KEY=AKIA...' }],
      sensitiveReadCount: 6, sensitiveReads: ['/Users/x/.env', '/Users/x/.aws/credentials', '/a', '/b', '/c', '/d'],
      truncated: true,
    }));
  assert.ok(!html.includes('<b>A</b>'), '工具名要转义');
  assert.match(html, /&lt;b&gt;A&lt;\/b&gt;/);
  assert.match(html, /高危/);
  assert.match(html, /读到的AWS 访问密钥又出现在外发命令里/);
  assert.match(html, /读取来源 ~\/\.env/);
  assert.match(html, /AKIA\*\*\*\*/);
  assert.match(html, /另读过 6 个敏感文件/);
  // 列前四个之后交代还有更多，再接截断说明
  assert.match(html, /、b 等；部分内容因扫描上限被跳过，结果不完整/);
});

test('auditGroup：内嵌型命中的说法与外发型分开', () => {
  const html = auditGroupHtml({ app: 'a', label: 'A' },
    ahit({ findings: [{ level: 'medium', kind: 'secret-inline', style: 'github', valueMasked: 'ghp_****' }] }));
  assert.match(html, /外发命令里内嵌了GitHub 令牌/);
});

/* ── 三块分组与清理抽屉（views/files.js 第二批）────────────── */

import {
  splitBlockHtml, drawerStatsHtml, drawerMixHtml, drawerListHtml, recChipsHtml,
} from '../public/views/files.js';
import { confirmWordHint } from '../public/views/shared.js';

const srow = (over = {}) => ({ p: 'cache/a.bin', t: 'root', s: 1024, k: 'root:cache/a.bin', link: false, ...over });
const sctx = (over = {}) => ({ selection: new Set(), keyOf: (f) => f.k, canPick: (f) => !f.link, anyPicked: false, ...over });

test('split-block：可勾时是 role=checkbox，勾满 / 勾一半 / 没勾三种说法', () => {
  const files = [srow(), srow({ k: 'b', p: 'x' })];
  const base = { cls: 'is-other', title: '非会话文件', desc: 'd', xs: files, extra: '', split: 'other', hit: files };

  const none = splitBlockHtml({ ...base, ...sctx() });
  assert.match(none, /role="checkbox"/);
  assert.match(none, /aria-checked="false"/);
  assert.match(none, /点这里选中这一组/);

  const some = splitBlockHtml({ ...base, ...sctx({ selection: new Set(['root:cache/a.bin']), anyPicked: true }) });
  assert.match(some, /aria-checked="mixed"/);
  assert.match(some, /再点一下补全/);
  assert.match(some, /已选 <b>1<\/b> \/ <b>2<\/b> 项/);

  const all = splitBlockHtml({ ...base, ...sctx({ selection: new Set(['root:cache/a.bin', 'b']) }) });
  assert.match(all, /aria-checked="true"/);
  assert.match(all, /再点一下取消/);
  assert.match(all, /class="split-block is-other is-on/);
});

test('split-block：已有勾选时，没勾的块说"换成这一组"而不是"选中"', () => {
  const html = splitBlockHtml({
    cls: 'is-other', title: 'x', desc: 'd', xs: [srow()], extra: '', split: 'other', hit: null,
    ...sctx({ anyPicked: true }),
  });
  assert.match(html, /点这里换成这一组/);
  assert.ok(!html.includes('点这里选中这一组'));
});

test('split-block：整组不可勾时退出交互，不假装是复选框', () => {
  const html = splitBlockHtml({
    cls: 'is-orphan', title: 'x', desc: 'd', xs: [srow({ link: true })], extra: '', split: 'orphan', hit: null,
    ...sctx(),
  });
  assert.ok(!html.includes('role="checkbox"'), '没有可勾项就不该有复选框语义');
  assert.ok(!html.includes('tabindex'));
  assert.ok(!html.includes('data-split'));
  assert.match(html, /这一组没有可勾选的条目/);
  assert.match(html, /is-empty/);
});

test('split-block：筛过时写"筛出 N / M"，且只有数字真的变了才补整组体积', () => {
  const files = [srow(), srow({ k: 'b', p: 'x' })];
  const html = splitBlockHtml({
    cls: 'is-other', title: 'x', desc: 'd', xs: files, extra: '', split: 'other', hit: [files[0]],
    ...sctx(),
  });
  assert.match(html, /筛出 1 \/ 2 个文件/);
  assert.match(html, /这一组当前筛选下没有条目|点这里选中这一组/);
});

test('drawerStats：条目、合计带精确字节，最大一项带完整路径 title', () => {
  const rows = [srow({ s: 1024, p: 'a/b.bin' }), srow({ s: 4096, k: 'x', p: 'c/d.bin' })];
  const html = drawerStatsHtml(rows, { titleOf: (f) => `~/${f.p}` });
  assert.match(html, /<span>条目<\/span><b>2<\/b>/);
  assert.match(html, /title="5,120 字节"/);
  assert.match(html, /title="~\/c\/d\.bin，4,096 字节"/);
});

test('drawerMix：同名分类按 id 合并，前五类之外报总数', () => {
  const cat = (id, label, status = 'good') => ({ id, label, status });
  const rows = Array.from({ length: 7 }, (_, i) => srow({ s: 10 * (i + 1), k: `k${i}` }));
  const html = drawerMixHtml(rows, (f) => cat(`c${f.s}`, `类${f.s}`));
  assert.match(html, /包含 /);
  assert.match(html, /…共 7 类/);

  const merged = drawerMixHtml(rows, () => cat('same', '同一类'));
  assert.ok(!merged.includes('…共'), '同 id 合并后只有一类');
  assert.match(merged, /同一类/);
});

test('drawerList：只列最大的 300 项，并明说截断不等于范围', () => {
  const many = Array.from({ length: 305 }, (_, i) => srow({ s: i, k: `k${i}`, p: `f/${i}.bin` }));
  const html = drawerListHtml(many, { titleOf: (f) => f.p });
  assert.equal((html.match(/<li /g) || []).length, 301, '300 行 + 1 行截断说明');
  assert.match(html, /下面还有 5 项没列出来/);
  assert.match(html, /<b>它们同样在这次的删除范围里<\/b>/);
  // 最大项排最前
  assert.ok(html.indexOf('304.bin') < html.indexOf('303.bin'));

  const few = drawerListHtml([srow()], { titleOf: (f) => f.p });
  assert.ok(!few.includes('drawer-more'));
});

test('recChips：排除状态长在 is-on 与 aria-pressed 上，说明进 title', () => {
  const cats = [
    { id: 'cache', label: '缓存', status: 'good', what: '可重建的副本', bytes: 2048 },
    { id: 'logs', label: '日志', status: 'good', what: '命令输出', bytes: 4096 },
  ];
  const html = recChipsHtml(cats, new Set(['logs']));
  assert.match(html, /data-rec="cache" aria-pressed="true"/);
  assert.match(html, /class="rec-chip st-good is-on"/);
  assert.match(html, /data-rec="logs" aria-pressed="false"/);
  assert.match(html, /title="可重建的副本"/);
  // 体积带精确字节
  assert.match(html, /title="4,096 字节"/);
});

test('confirmWordHint：三条路径共用同一句式，输对与空输入都返回空串', () => {
  assert.equal(confirmWordHint('', '彻底删除', '彻底删除'), '');
  assert.equal(confirmWordHint('彻底删除', '彻底删除', '彻底删除'), '');
  assert.equal(confirmWordHint('彻底', '彻底删除', '彻底删除'), '还差「删除」—— 输全才能彻底删除。');
  assert.equal(confirmWordHint('清', '清理', '删除'), '还差「理」—— 输全才能删除。');
  assert.equal(confirmWordHint('回', '回灌', '写入'), '还差「灌」—— 输全才能写入。');
});

/* ── 跨层枚举契约 ───────────────────────────────────────────
   后端 lib/tasks-shape.mjs 是 state/reason 值域的唯一来源；前端字典
   （views/tasks.js）是它们的人话。后端加一档而前端字典没跟上时，
   缺的那个值会以 undefined 一路画到界面上 —— 在这里锁住对齐。 */

import { STATES, REASONS, CONTENT_ROLES } from '../lib/tasks-shape.mjs';

test('后端每个 state 在前端都有文案与色档，反之亦然', () => {
  for (const s of STATES) {
    assert.ok(STATE_META_CN[s], `后端 state「${s}」在前端字典缺文案`);
    assert.ok(STATE_TONE[s], `后端 state「${s}」在前端字典缺色档`);
  }
  assert.deepEqual(Object.keys(STATE_META_CN).sort(), [...STATES].sort(),
    '前端 state 字典与后端值域不一致（多出或缺少键）');
});

test('后端每个 reason 在前端都有文案与色档', () => {
  for (const r of REASONS) {
    assert.ok(REASON_LABEL[r], `后端 reason「${r}」在前端字典缺文案`);
    assert.ok(REASON_TONE[r], `后端 reason「${r}」在前端字典缺色档`);
  }
  assert.deepEqual(Object.keys(REASON_LABEL).sort(), [...REASONS].sort(),
    '前端 reason 字典与后端值域不一致');
});

test('会话内容的角色前后端双向对齐', () => {
  /* 「所属内容」按 role 分组。后端枚举出的每个 role 前端都必须有中文名 ——
     少一个就会在界面上直接印出英文标识（"projection" 这种不该给人看）。
     反向也要查：前端多写一个后端不会产出的 role，那是死字典。 */
  for (const role of CONTENT_ROLES) {
    assert.ok(CONTENT_ROLE_LABEL[role], `后端 role「${role}」在前端缺中文名`);
  }
  assert.deepEqual(Object.keys(CONTENT_ROLE_LABEL).sort(), [...CONTENT_ROLES].sort(),
    '前端 role 字典与后端值域不一致（多出或缺少键）');
});

/* ── 面板文案矩阵（views/tasks.js 第二批）─────────────────── */

import {
  taskLedeHtml, taskWarnHtml, taskEmptyWarnHtml, taskQuickTexts,
  taskDrawerStatsHtml, taskDrawerNoteHtml, taskDrawerListHtml,
} from '../public/views/tasks.js';

const panel = (over = {}) => ({
  appLabel: 'ZCode', readOnly: false, fileBased: false, untitled: 0,
  totals: { count: 3, bytes: 2048, byState: [{ state: 'active', count: 3, bytes: 2048 }] },
  db: { total: 4096, dbs: [{ path: '/Users/x/.zcode/cli/db/db.sqlite', role: 'chat' }] },
  app: { running: false, unknown: false, hits: [] },
  tasks: [trow(), trow({ id: 'b' }), trow({ id: 'c' })],
  backupDir: '/tmp/backups', problems: [], ...over,
});

test('taskLede：四种形态各说各的，不把 A 工具的说法安到 B 头上', () => {
  const ro = taskLedeHtml(panel({ readOnly: true }));
  assert.match(ro, /按键族摊开/);
  assert.ok(!ro.includes('正文文件合计') && !ro.includes('rollout'));

  const fb = taskLedeHtml(panel({ fileBased: true, db: { total: 0, bodies: { count: 5, bytes: 2048 } } }));
  assert.match(fb, /正文文件/);
  /* 会话正文已归会话管理，所以这里要说的不是"去文件那条线"，
     而是"清理时正文文件会一并移入废纸篓" —— 它现在就在这个面板里发生。 */
  assert.match(fb, /一并移入废纸篓/);
  assert.doesNotMatch(fb, /走文件那条线/, '旧口径（去文件清单清）已不成立');

  const two = taskLedeHtml(panel({ db: { total: 4096, bodies: { count: 2, bytes: 1024 } } }));
  assert.match(two, /分两处存/);
  assert.match(two, /rollout 文件/);

  const one = taskLedeHtml(panel());
  assert.match(one, /会话库/);
});

test('taskLede：可清数量在"全部可清"与"部分可清"时补一句，全不可清不啰嗦', () => {
  const allPurgeable = [trow({ reason: 'deleted' }), trow({ id: 'b', reason: 'deleted' }), trow({ id: 'c', reason: 'deleted' })];
  const all = taskLedeHtml(panel({ fileBased: true, db: { total: 0, bodies: { count: 3, bytes: 2048 } }, tasks: allPurgeable }));
  assert.match(all, /这 3 条都可以清/);
  // 活跃且工作区在（reason=null）的行不可清 → 不补
  assert.ok(!taskLedeHtml(panel()).includes('可以清'));
});

test('taskLede：无名会话的交代只出现在只读形态里', () => {
  assert.match(taskLedeHtml(panel({ readOnly: true, untitled: 2 })), /2<\/b> 条 Cursor 没有生成标题/);
  assert.ok(!taskLedeHtml(panel({ untitled: 2 })).includes('没有生成标题'));
});

test('taskWarn：五分支各自的能力前提，problems 一律压过 is-ok', () => {
  const safe = taskWarnHtml(panel());
  assert.equal(safe.className, 'app-warn is-ok');
  assert.match(safe.html, /没在运行，可以安全清理/);
  assert.match(safe.html, /完整备份到/);

  const running = taskWarnHtml(panel({ app: { running: true, unknown: false, hits: [{ name: 'ZCode', pids: 2 }] } }));
  assert.match(running.html, /<b>ZCode 正在运行<\/b>/);
  assert.match(running.html, /完全退出/);

  const unknown = taskWarnHtml(panel({ app: { running: false, unknown: true, error: 'pgrep 没了' } }));
  assert.match(unknown.html, /无法确认 ZCode 是否退出/);
  assert.match(unknown.html, /pgrep 没了/);

  const ro = taskWarnHtml(panel({ readOnly: true, readOnlyNote: '这个库由 IDE 独占写入。' }));
  assert.match(ro.html, /会话只读/);
  assert.match(ro.html, /IDE 独占写入/);

  const fb = taskWarnHtml(panel({ fileBased: true }));
  // 文案里嵌着 <b> 标签，正则别去匹配标签本身 —— 只查"在这里清理"这个说法
  assert.match(fb.html, /在[\s\S]{0,14}这里[\s\S]{0,8}清理/,
    '正文即文件的两家也从会话管理删，不再指向文件清单');
  assert.doesNotMatch(fb.html, /走<b>文件清理/);

  // 有读取问题时必须上屏，且"绿色安全"的调子不能再挂着
  const withProblem = taskWarnHtml(panel({ problems: ['db.sqlite 打不开（只读）'] }));
  assert.equal(withProblem.className, 'app-warn');
  assert.match(withProblem.html, /db\.sqlite 打不开（只读）/);
});

test('taskEmptyWarn：空面板说明文件型与读取问题，无可说时为 null', () => {
  const fb = taskEmptyWarnHtml(panel({ fileBased: true }));
  assert.match(fb.html, /在[\s\S]{0,14}这里[\s\S]{0,8}清理/);
  assert.equal(fb.className, 'app-warn is-ok');

  const problem = taskEmptyWarnHtml(panel({ problems: ['读不到'] }));
  assert.equal(problem.className, 'app-warn');
  assert.match(problem.html, /读不到/);

  assert.equal(taskEmptyWarnHtml(panel()), null);
  assert.equal(taskEmptyWarnHtml(null), null);
});

test('taskQuickTexts：跳过计数折进行内，按钮的空范围说下一步', () => {
  const s = { tasks: [trow()], bytes: 1024, skippedRecent: 2, skippedPinned: 0 };
  const t = taskQuickTexts(panel(), s, { ageDays: 30, skipPinned: true });
  assert.match(t.subHtml, /勾选 <b>1<\/b> 个，共 1 KB/);
  assert.match(t.subHtml, /已跳过 2 个近期还在用的/);
  assert.ok(!t.subHtml.includes('置顶'), 'skipPinned 关着时不提置顶');
  assert.match(t.figureTitle, /它的删除只是打标记/);
  assert.match(t.btnTitle, /先摊开确认清单/);

  const empty = taskQuickTexts(panel(), { tasks: [], bytes: 0, skippedRecent: 0, skippedPinned: 0 }, { ageDays: 30, skipPinned: true });
  assert.match(empty.btnTitle, /放宽"跳过最近"再试/);
});

test('taskDrawerStats：正文即文件的加"库里的条目"，Cursor 空跑时显式说"正在算"', () => {
  const bodies = taskDrawerStatsHtml({ count: 2, rows: 9, bytes: 2048, exTotal: null, exPending: false, hasBodies: true });
  assert.match(bodies, /库里的条目/);
  assert.ok(!bodies.includes('连带回收'), 'Codex 形态不该出现连带');

  const cursor = taskDrawerStatsHtml({ count: 2, rows: 0, bytes: 1024, exTotal: null, exPending: true, hasBodies: false });
  assert.match(cursor, /dstat-pending/);
  assert.match(cursor, /正在算/);
  const failed = taskDrawerStatsHtml({ count: 2, rows: 0, bytes: 1024, exTotal: null, exPending: false, exFailed: true, hasBodies: false });
  assert.match(failed, /未能估算/);
  assert.ok(!failed.includes('正在算'));

  const done = taskDrawerStatsHtml({
    count: 2, rows: 0, bytes: 1024,
    exTotal: { bytes: 3072, blobs: 5 }, exPending: false, hasBodies: false,
  });
  assert.match(done, /连带回收/);
  assert.match(done, /预计共回收/);
  assert.match(done, /4 KB/);
});

test('taskDrawerNote：运行中 / Cursor / Codex 两段式 / 默认各说各的', () => {
  const running = taskDrawerNoteHtml(panel({ app: { running: true, unknown: false, hits: [] } }), {});
  assert.match(running, /仍在运行/);

  const cursor = taskDrawerNoteHtml(
    panel({ history: 'cursor-db', db: { total: 1, dbs: [
      { path: '/x/state.vscdb', role: 'kv' }, { path: '/x/search.db', role: 'index' },
    ] } }),
    { exB: 2048, exN: 3 });
  assert.match(cursor, /state\.vscdb/);
  assert.ok(!cursor.includes('search.db'), '搜索索引不该被说成"会从里面移除"');
  assert.match(cursor, /3<\/b> 个工具结果 blob/);

  /* 以前这里断言的是"正文不在库里，文件要去文件清单再清一遍" ——
     级联之后那句话过时了：会话文件会随这次删除一起走。
     现在守两件事：没有级联数据时不吹牛；给了规模就要把口径说清。 */
  const codexPlain = taskDrawerNoteHtml(
    panel({ db: { total: 4096, dbs: [{ path: '/x/state_5.sqlite', role: 'chat' }], bodies: { count: 1, bytes: 10 } } }), {});
  assert.match(codexPlain, /正文合计只是下限/, '没有级联数据时不能承诺会删文件');

  const codexCascade = taskDrawerNoteHtml(
    panel({ db: { total: 4096, dbs: [{ path: '/x/state_5.sqlite', role: 'chat' }], bodies: { count: 1, bytes: 10 } } }),
    { cascade: { count: 3, bytes: 2048 } });
  assert.match(codexCascade, /3<\/b> 个会话文件/, '要给出将一起删除的文件数与体积');
  assert.match(codexCascade, /回收.*只算数据库收缩/, '口径必须说清：回收数字不含文件');
  assert.match(codexCascade, /先备份/, '文件也要先备份');

  const plain = taskDrawerNoteHtml(panel(), {});
  assert.match(plain, /正文合计只是下限/);
});

test('taskDrawerList：按体积降序、截断说明、工具名做前缀', () => {
  const picked = [trow({ id: 'a', title: '小', bytes: 1 }), trow({ id: 'b', title: '大', bytes: 999 })];
  const html = taskDrawerListHtml(picked, 'ZCode');
  assert.ok(html.indexOf('大') < html.indexOf('小'));
  assert.match(html, /<span>ZCode，大<\/span>/);
  assert.ok(!html.includes('…还有'));

  const many = Array.from({ length: 205 }, (_, i) => trow({ id: `k${i}`, title: `会话${i}`, bytes: i }));
  const cut = taskDrawerListHtml(many, 'ZCode');
  assert.match(cut, /…还有 5 个/);
});

test('确认词输错时要求重输，不能把等长错误说成已经输全', () => {
  assert.equal(confirmWordHint('错误', '清理', '删除'), '请输入「清理」才能删除。');
  assert.equal(confirmWordHint('清理其他', '清理', '删除'), '请输入「清理」才能删除。');
});

test('正文统计超过主库文件时体积条仍限制在 100%，保留磁盘分母', () => {
  const result = dbBarSegments({ db: { total: 100 }, totals: { byState: [
    { state: 'active', bytes: 120 }, { state: 'archived', bytes: 80 },
  ] } });
  assert.equal(result.total, 100);
  assert.equal(result.floors.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(result.floors, [60, 40]);
});

test('一键清理不能选中包含活跃后代的已删除任务', () => {
  const data = { tasks: [trow({ id: 'blocked', state: 'deleted', reason: null, updatedAt: 1 }),
    trow({ id: 'allowed', state: 'deleted', reason: 'deleted', updatedAt: 1 })] };
  assert.deepEqual(taskQuickSet(data, { ageDays: 0, skipPinned: false }).tasks.map(t => t.id), ['allowed']);
});

/* ── 会话的「所属内容」清单（views/tasks.js 第三批）───────────
 * 这块回答的问题只有一个：「删掉这条会话，到底带走什么」。
 * 五种工具的级联范围差得极远，所以判据是**差别要看得见**：
 * 每类内容都要有中文名和体积，不可删的要明说「不删」，
 * 会在恢复时出问题的（分页段）要单独警告。 */

const contents = (over = {}) => ({
  dbRows: [], files: [], blobs: null, notes: [], ...over,
});

test('所属内容：清单为空时整块不出现，不留一个 0 项的空壳', () => {
  const t = trow({ contents: contents() });
  assert.equal(taskContentsHtml(t), '');
  assert.equal(taskContentsHtml(trow({ contents: null })), '', '没有 contents 字段也不该画');
});

test('所属内容：库行与文件分别成行，体积与条目数都要在', () => {
  const t = trow({ contents: contents({
    dbRows: [{ db: 'db.sqlite', table: 'message', count: 312 }, { db: 'db.sqlite', table: 'part', count: 88 }],
    files: [
      { rel: 'cli/image-cache/sess_x', role: 'media', bytes: 3 * 1024 * 1024, removable: true, count: 6 },
      { rel: 'cli/rollout/model-io-sess_x.jsonl', role: 'body', bytes: 1024 * 1024, removable: true, count: 1 },
    ],
  }) });
  const html = taskContentsHtml(t);
  assert.match(html, /所属内容/);
  assert.match(html, /2 张表 · 400 行/, '库行要给出表数与行数');
  assert.match(html, /会话贴图/, 'role 要翻成中文');
  assert.match(html, /6 个文件/, '目录型条目要写清里面几个文件');
  assert.match(html, /3\.0 MB|3 MB/, '贴图体积要显示');
  assert.match(html, /共回收/, '要有一句总量结论');
});

test('所属内容：同一角色的多条路径在展示层合成一行，但条目数累加', () => {
  const files = [
    { rel: 'sessions/a', role: 'body', bytes: 100, removable: true, count: 1 },
    { rel: 'sessions/b', role: 'body', bytes: 200, removable: true, count: 1 },
  ];
  const merged = mergeByRole(files);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].bytes, 300);
  assert.equal(merged[0].count, 2);
  const html = taskContentsHtml(trow({ contents: contents({ files }) }));
  assert.match(html, /正文/);
  assert.match(html, /300 B|2 个文件/);
});

test('所属内容：不可删的条目写「不删」，不能让人以为会一起清掉', () => {
  const t = trow({ contents: contents({
    files: [{ rel: 'User/globalStorage/conversation-search.db', role: 'index', bytes: 4096, removable: false, count: 1 }],
  }) });
  const html = taskContentsHtml(t);
  assert.match(html, /不删/, '不可删必须显式标出');
  assert.doesNotMatch(html, /共回收/, '一项都删不掉时不该有"共回收"结论');
});

test('所属内容：分页段与投影的专用提醒只在有这类内容时出现', () => {
  const withSeg = trow({ contents: contents({
    files: [{ rel: 'sessions/x', role: 'segment', bytes: 10, removable: true, count: 2 }],
  }) });
  assert.match(taskContentsHtml(withSeg), /分页续段/);

  const plain = trow({ contents: contents({
    files: [{ rel: 'a.jsonl', role: 'body', bytes: 10, removable: true, count: 1 }],
  }) });
  assert.doesNotMatch(taskContentsHtml(plain), /分页续段/);
});

test('所属内容：notes 原样呈现，warn 档带独立样式', () => {
  const t = trow({ contents: contents({
    files: [{ rel: 'a.jsonl', role: 'body', bytes: 10, removable: true, count: 1 }],
    notes: [
      { text: '这是普通说明', tone: 'info' },
      { text: '这是要当心的', tone: 'warn' },
    ],
  }) });
  const html = taskContentsHtml(t);
  assert.match(html, /这是普通说明/);
  assert.match(html, /class="is-warn"[^>]*>这是要当心的/, 'warn 档要有独立 class');
});

test('所属内容：路径与标题里的尖括号会被转义', () => {
  const t = trow({ contents: contents({
    files: [{ rel: '<script>alert(1)</script>', role: 'body', bytes: 1, removable: true, count: 1 }],
    notes: [{ text: '<img onerror=x>', tone: 'info' }],
  }) });
  const html = taskContentsHtml(t);
  assert.doesNotMatch(html, /<script>/, '路径必须转义');
  assert.doesNotMatch(html, /<img onerror/, '说明文字必须转义');
  assert.match(html, /&lt;script&gt;/);
});

test('所属内容：Cursor 的独占 blob 单独成行，与文件分开算', () => {
  const t = trow({ contents: contents({
    blobs: { count: 12, bytes: 5 * 1024 * 1024 },
    files: [{ rel: 'projects/x/agent-transcripts/y/y.jsonl', role: 'transcript', bytes: 1024, removable: true, count: 1 }],
  }) });
  const html = taskContentsHtml(t);
  assert.match(html, /独占内容/);
  assert.match(html, /12 个只被这条会话引用/);
  assert.match(html, /子 Agent 记录/);
});

test('会话详情不再有「在文件清单中定位」——正文已不在那里', () => {
  /* 会话正文移出文件清单后，这个按钮只会把人带到一个搜不出结果的搜索框。
     正文的去处由「所属内容」交代，删除由会话抽屉统一做。 */
  const html = taskRowHtml(trow({
    bodyRel: 'projects/x/sess-1.jsonl',
    contents: contents({ files: [{ rel: 'projects/x/sess-1.jsonl', role: 'body', bytes: 10, removable: true, count: 1 }] }),
  }), { sel: false, open: true });
  assert.doesNotMatch(html, /在文件清单中定位/);
  assert.doesNotMatch(html, /data-locate/);
  assert.match(html, /所属内容/, '正文的去处改由内容清单交代');
});

test('空跑对正文即文件的工具列出将移入废纸篓的文件，而不是 0 行', () => {
  /* Claude / DeepSeek 没有库行 —— 以前这里显示"共 0 行"，
     看起来像什么都不会发生，实际上要删的是整批正文文件。 */
  const r = dryRunHtml({
    perDb: [],
    files: [
      { rel: 'projects/x/a.jsonl', role: 'body', bytes: 1024 },
      { rel: 'projects/x/b.jsonl', role: 'body', bytes: 512 },
    ],
  });
  assert.match(r.rowsHtml, /a\.jsonl/);
  assert.match(r.rowsHtml, /b\.jsonl/);
  assert.doesNotMatch(r.rowsHtml, /没有数据库行可删/, '有文件可删时不该显示空表');

  // 有库行的工具维持原状：逐表列行数
  const db = dryRunHtml({ perDb: [{ table: 'message', name: 'db.sqlite', count: 5 }] });
  assert.match(db.rowsHtml, /message/);
});
