/**
 * 视图层的契约测试。
 *
 * 与它替换掉的 frontend-static.test.mjs 的区别，是这一层的**判据**变了：
 *
 *   旧：在源码里找某个字符串（`assert.match(app, /tabindex="\$\{on \? .../)`）
 *   新：拿夹具调用渲染函数，断言它产出的 HTML
 *
 * 为什么必须换：旧写法保护的是"上次是怎么写的"。想改模板的排版、把
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
  assert.match(html, /disabled aria-label="受保护内容，不可清理"/);
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

test('空态：分类筛选用标签名而不是内部 id', () => {
  const html = emptyHintHtml({ catFilter: 'sessionMedia', catLabel: '会话媒体' }).html;
  assert.match(html, /会话媒体/);
  assert.ok(!html.includes('sessionMedia'), '别把内部 id 印给用户看');
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
