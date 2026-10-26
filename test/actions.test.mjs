/**
 * 点击动作的测试。
 *
 * 这一组替换掉的是"读源码猜行为"：以前这些逻辑埋在 260 行的 click 处理器里，
 * 只能靠人肉审查。现在每个动作是纯函数，入参就是它的全部输入。
 *
 * 这里的断言全部围绕**曾经出过的错**，不是围绕实现细节：
 *   · 三块分组只勾筛出来的那些（点一下别把 M 全勾上）
 *   · 软链接与受保护项永远不进选区（否则服务端拒绝整批，一个都删不掉）
 *   · 推荐清理先清筛选再勾（看不见的选区不该被删）
 *   · 分组框只动可见行
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toggleSplitGroup, selectAllVisible, clearSelection, selectRecommended,
  toggleGroupBox, toggleRow, toggleStatus, toggleExplain,
  toggleCategory, toggleRecommendItem, toggleAllGroup, toggleToolFilter, nextTheme,
} from '../public/actions.js';

/* ── 夹具 ─────────────────────────────────────────────────── */

const mkState = (over = {}) => ({
  selection: new Set(),
  group: null,
  open: new Set(),
  explain: new Set(),
  statuses: new Set(),
  recOff: new Set(),
  q: '',
  ...over,
});

/** 一个文件行：p 是路径，k 是稳定 key。 */
const f = (p, extra = {}) => ({ p, k: `k:${p}`, s: 100, t: 'root', ...extra });

const keyOf = (x) => x.k;

/* 一批文件：两个孤儿、三个在用、一个软链接、一个受保护类别里的。
   足够覆盖"筛选 / 可勾 / 分组"三个维度的交叉。 */
const FILES = [
  f('orphan-a', { sid: 's1', orphan: true }),
  f('orphan-b', { sid: 's2', orphan: true }),
  f('live-a', { sid: 's3', orphan: false }),
  f('live-b', { sid: 's4', orphan: false }),
  f('live-c', { sid: 's5', orphan: false }),
  f('link-1', { sid: 's6', orphan: true, link: true }),
  f('plain-1'),   // 没有 sid：归 other
];

const groupOf = (x) => (!x.sid ? 'other' : x.orphan === true ? 'orphan' : 'live');
const canPick = (x) => !x.link;

/* ── 三块分组 ─────────────────────────────────────────────── */

test('三块分组：勾上这一组里能被勾的那些', () => {
  const st = mkState();
  toggleSplitGroup(st, 'orphan', { files: FILES, groupOf, canPick, matches: () => true, keyOf });
  // orphan 组有三个：orphan-a / orphan-b / link-1，软链接被排除
  assert.deepEqual([...st.selection].sort(), ['k:orphan-a', 'k:orphan-b']);
  assert.equal(st.group, 'orphan');
});

test('三块分组：只勾**当前筛选下看得见的** —— 不能偷偷扩大范围', () => {
  const st = mkState();
  // 用户搜了 "a"，只剩 orphan-a 可见
  const matches = (x) => x.p === 'orphan-a';
  const r = toggleSplitGroup(st, 'orphan', { files: FILES, groupOf, canPick, matches, keyOf });
  assert.deepEqual([...st.selection], ['k:orphan-a'], '不该把看不见的 orphan-b 也勾上');
  assert.equal(r.allWasOn, false);
});

test('三块分组：再点同一块是整组取消，且清掉分组筛选', () => {
  const st = mkState({ selection: new Set(['k:orphan-a', 'k:orphan-b']), group: 'orphan' });
  const r = toggleSplitGroup(st, 'orphan', { files: FILES, groupOf, canPick, matches: () => true, keyOf });
  assert.equal(st.selection.size, 0);
  assert.equal(st.group, null);
  assert.equal(r.allWasOn, true);
});

test('三块分组：换一组是"换成它"而不是"再加上它"', () => {
  const st = mkState({ selection: new Set(['k:orphan-a', 'k:orphan-b']), group: 'orphan' });
  toggleSplitGroup(st, 'live', { files: FILES, groupOf, canPick, matches: () => true, keyOf });
  assert.deepEqual([...st.selection].sort(), ['k:live-a', 'k:live-b', 'k:live-c']);
  assert.equal(st.group, 'live');
});

test('三块分组：软链接永不进选区（连"部分勾上"都不行）', () => {
  const st = mkState();
  toggleSplitGroup(st, 'orphan', { files: FILES, groupOf, canPick, matches: () => true, keyOf });
  assert.ok(!st.selection.has('k:link-1'), '软链接不能进选区');
});

test('三块分组：空组点下去不炸，也不留下空选区', () => {
  const st = mkState();
  const r = toggleSplitGroup(st, 'other', {
    files: [f('only-link', { sid: 'x', orphan: true, link: true })],
    groupOf, canPick, matches: () => true, keyOf,
  });
  assert.equal(st.selection.size, 0);
  assert.equal(r.allWasOn, false);
});

/* ── 全选 / 取消 ──────────────────────────────────────────── */

test('全选可见：勾满所有可清项，软链接与受保护跳过', () => {
  const st = mkState();
  const groups = [{ cat: { id: 'c', verdict: 'safe' }, files: FILES }];
  const selectableOnly = (fs, cat) => fs.filter((x) => canPick(x) && cat.verdict !== 'never');
  const r = selectAllVisible(st, groups, { selectableOnly, keyOf });
  assert.equal(st.selection.size, 6, '七个里六个能勾（软链接那个不行）');
  assert.equal(r.added, 6);
});

test('全选可见：受保护分类整类跳过', () => {
  const st = mkState();
  const groups = [{ cat: { id: 'locked', verdict: 'never' }, files: FILES.slice(0, 3) }];
  const selectableOnly = (fs, cat) => fs.filter((x) => canPick(x) && cat.verdict !== 'never');
  selectAllVisible(st, groups, { selectableOnly, keyOf });
  assert.equal(st.selection.size, 0);
});

test('全选可见：已经勾过的只算新增', () => {
  const st = mkState({ selection: new Set(['k:orphan-a']) });
  const selectableOnly = (fs) => fs.filter(canPick);
  const r = selectAllVisible(st, [{ cat: { verdict: 'safe' }, files: [FILES[0], FILES[1]] }],
    { selectableOnly, keyOf });
  assert.equal(r.added, 1, '只新增 orphan-b');
  assert.equal(st.selection.size, 2);
});

test('取消：清空选区并把分组筛选一起撤掉', () => {
  const st = mkState({ selection: new Set(['a', 'b']), group: 'orphan' });
  const r = clearSelection(st);
  assert.equal(st.selection.size, 0);
  assert.equal(st.group, null, '只清选区不清筛选，会让清单还筛着而三块全空');
  assert.equal(r.changed, true);
});

test('取消：本来就是空的，返回 changed=false（避免白重画）', () => {
  assert.equal(clearSelection(mkState()).changed, false);
});

/* ── 推荐清理 ─────────────────────────────────────────────── */

test('推荐清理：先把筛选清干净，再勾满推荐范围', () => {
  const st = mkState({
    q: 'abc', statuses: new Set(['good']), group: 'orphan',
    selection: new Set(['leftover']),
  });
  const cats = [{ id: 'cache', verdict: 'safe' }, { id: 'logs', verdict: 'safe' }];
  const filesOf = (id) => (id === 'cache' ? [f('c1'), f('c2')] : [f('l1')]);
  const r = selectRecommended(st, cats, {
    filesOf, keyOf, selectableOnly: (fs, cat) => fs.filter((x) => canPick(x) && cat.verdict !== 'never'),
  });

  assert.equal(st.q, '', '搜索词要清掉');
  assert.equal(st.statuses.size, 0);
  assert.equal(st.group, null);
  assert.ok(!st.selection.has('leftover'), '旧选区要清掉');
  assert.deepEqual([...st.selection].sort(), ['k:c1', 'k:c2', 'k:l1']);
  assert.equal(r.count, 3);
});

test('推荐清理：推荐范围里的软链接要被挡掉（否则服务端拒绝整批）', () => {
  const st = mkState();
  const cats = [{ id: 'plugins', verdict: 'safe' }];
  const filesOf = () => [f('ok'), f('a.bin', { link: true }), f('old-exe', { link: true })];
  selectRecommended(st, cats, {
    filesOf, keyOf, selectableOnly: (fs, cat) => fs.filter((x) => canPick(x) && cat.verdict !== 'never'),
  });
  assert.deepEqual([...st.selection], ['k:ok'], '两个软链接都不能进去');
});

/* ── 分组框 / 单行 ────────────────────────────────────────── */

test('分组框：只动当前可见的行，并把卡片展开', () => {
  const st = mkState();
  const filesOf = () => FILES;
  const r = toggleGroupBox(st, 'orphan', true, {
    filesOf, matches: (x) => x.p.startsWith('orphan'), keyOf,
    selectableOnly: (fs, cat) => fs.filter(canPick),
    catOf: () => ({ verdict: 'safe' }),
  });
  assert.deepEqual([...st.selection].sort(), ['k:orphan-a', 'k:orphan-b']);
  assert.ok(st.open.has('orphan'), '勾上一整卡要能看见里面');
  assert.equal(r.count, 2);
});

test('分组框：取消时从选区里删掉这些行', () => {
  const st = mkState({ selection: new Set(['k:orphan-a', 'k:orphan-b', 'k:live-a']) });
  // matches 必须与'这一卡里看得见的行'一致：这里模拟没有筛选，但只有 orphan 组的行
  toggleGroupBox(st, 'orphan', false, {
    filesOf: () => FILES.filter((x) => groupOf(x) === 'orphan'), matches: () => true, keyOf,
    selectableOnly: (fs) => fs.filter(canPick),
    catOf: () => ({ verdict: 'safe' }),
  });
  assert.deepEqual([...st.selection], ['k:live-a'], '只删 orphan 组，别人不动');
});

test('单行：加/删一个 key', () => {
  const st = mkState();
  toggleRow(st, 'k:x', true);
  assert.ok(st.selection.has('k:x'));
  toggleRow(st, 'k:x', false);
  assert.ok(!st.selection.has('k:x'));
});

/* ── 筛选 ─────────────────────────────────────────────────── */

test('状态筛选：多选切换', () => {
  const st = mkState();
  toggleStatus(st, 'good');
  toggleStatus(st, 'critical');
  assert.deepEqual([...st.statuses].sort(), ['critical', 'good']);
  toggleStatus(st, 'good');
  assert.deepEqual([...st.statuses], ['critical']);
});

test('说明与卡片展开：各自独立，互不影响', () => {
  const st = mkState();
  toggleExplain(st, 'cache');
  assert.ok(st.explain.has('cache'));
  assert.ok(!st.open.has('cache'), '展开说明不该顺带展开清单');
  toggleCategory(st, 'cache');
  assert.ok(st.open.has('cache'));
});

test('推荐项开关：切 recOff', () => {
  const st = mkState();
  toggleRecommendItem(st, 'cache');
  assert.ok(st.recOff.has('cache'));
  toggleRecommendItem(st, 'cache');
  assert.ok(!st.recOff.has('cache'));
});

/* ── 「全部」视图 ─────────────────────────────────────────── */

test('全部视图：默认展开的组能收起 —— 不能被"默认"规则立刻翻回来', () => {
  const st = { open: new Set(), collapsed: new Set(), tools: new Set() };
  // 第 0 组落在默认展开范围内，当前是开的
  const r1 = toggleAllGroup(st, '/w/a', 0, 2);
  assert.equal(r1.isOpen, false, '第一下应当收起');
  assert.ok(st.collapsed.has('/w/a'));

  // 再点：又展开
  const r2 = toggleAllGroup(st, '/w/a', 0, 2);
  assert.equal(r2.isOpen, true);
  assert.ok(st.open.has('/w/a'));
});

test('全部视图：默认范围外的组，点一下展开', () => {
  const st = { open: new Set(), collapsed: new Set() };
  const r = toggleAllGroup(st, '/w/z', 5, 2);
  assert.equal(r.isOpen, true);
  assert.ok(st.open.has('/w/z'));
});

test('工具筛选：多选切换', () => {
  const st = { tools: new Set() };
  toggleToolFilter(st, 'zcode');
  toggleToolFilter(st, 'codex');
  assert.deepEqual([...st.tools].sort(), ['codex', 'zcode']);
  toggleToolFilter(st, 'zcode');
  assert.deepEqual([...st.tools], ['codex']);
});

/* ── 主题 ─────────────────────────────────────────────────── */

test('主题三态循环：跟随系统 → 深 → 浅 → 跟随系统', () => {
  assert.equal(nextTheme(null), 'dark');
  assert.equal(nextTheme(''), 'dark');
  assert.equal(nextTheme('dark'), 'light');
  assert.equal(nextTheme('light'), '', '从浅色回到跟随系统（读出来是空串）');
});
