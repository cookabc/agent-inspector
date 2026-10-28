/**
 * 纯函数的行为。这些函数不碰 DOM，所以能在 node --test 里直接跑。
 *
 * 重点是 fmtBytes 的进位边界：它在屏幕上印出来的每个数字，都是这套工具
 * 说"我算的是真的"的依据。印成 "1024.0 MB" 这种不存在于任何量级的写法，
 * 比少一位小数糟得多。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes, isSelectable } from '../public/logic.js';

test('locked categories remain unselectable even with a review verdict', () => {
  assert.equal(isSelectable({}, { locked: true, verdict: 'review' }), false);
});

const KB = 1024, MB = 1024 ** 2, GB = 1024 ** 3, TB = 1024 ** 4;

test('常规量级与精度', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(KB), '1 KB');
  assert.equal(fmtBytes(1536), '2 KB');
  assert.equal(fmtBytes(1536 * KB), '1.5 MB');
  assert.equal(fmtBytes(2.84 * GB), '2.84 GB');
  // 10 GB 以上只留一位
  assert.equal(fmtBytes(12.345 * GB), '12.3 GB');
  assert.equal(fmtBytes(1.234 * TB), '1.23 TB');
});

test('进位边界：不能印出 1024', () => {
  // 这几个数按小单位四舍五入会到 1024 —— 必须换到再大的单位重新算。
  assert.equal(fmtBytes(1073741000), '1.00 GB');   // 1023.999 MB → 1024
  assert.equal(fmtBytes(1048570), '1.0 MB');       // 1023.99 KB  → 1024
  assert.equal(fmtBytes(1048575), '1.0 MB');
  assert.equal(fmtBytes(1048064), '1.0 MB');
  assert.equal(fmtBytes(10 * GB - 1), '10.00 GB');   // 还差一点到 10 GB，走两位档
  assert.equal(fmtBytes(10 * GB), '10.0 GB');        // 刚好到 10 GB，换成一位档
  assert.equal(fmtBytes(TB - 1), '1.00 TB');
});

test('任何体积都不会印出 1024 或更高', () => {
  // 扫一遍有代表性的量级（含各单位的进位点附近），确认没有任何一个
  // 输出真的写成 "1024.x"。这是上一个测试的兜底：边界不只是一两个数。
  const probe = [];
  for (const size of [KB, MB, GB, TB, 1024 ** 5, 1024 ** 6]) {
    for (let delta = -3; delta <= 3; delta++) probe.push(size + delta);
    for (const f of [0.999, 0.9999, 0.99999]) probe.push(Math.floor(size * f));
  }
  // 顶上那两档：TB 满了要能进位到 PB，PB 满了要能进位到 EB
  probe.push(1024 ** 5, 1024 ** 5 - 1, 1024 ** 6, 1024 ** 6 - 1);
  for (const n of probe) {
    const out = fmtBytes(n);
    const value = Number(out.split(' ')[0]);
    assert.ok(!(value >= 1024), `${n} 印成了 ${out}`);
  }
});

test('单位阶梯到 EB 才封顶，中间没有卡住的地方', () => {
  assert.equal(fmtBytes(TB), '1.00 TB');
  assert.equal(fmtBytes(1023 * TB), '1023.00 TB');
  assert.equal(fmtBytes(1024 * TB), '1.00 PB');   // 任何量级都不印 1024
  assert.equal(fmtBytes(1024 ** 5), '1.00 PB');
  assert.equal(fmtBytes(1024 ** 6), '1.00 EB');
  // 9.007e15 字节 ≈ 8 PB —— 顺带确认这个量级也不会掉进科学计数法
  assert.equal(fmtBytes(Number.MAX_SAFE_INTEGER), '8.00 PB');
});

test('输出永远不出现 undefined / NaN / 科学计数法', () => {
  for (const n of [0, 1, KB, MB, GB, TB, 5 * TB, 123456789012]) {
    const out = fmtBytes(n);
    assert.match(out, /^[\d.]+ (B|KB|MB|GB|TB)$/, `${n} → ${out}`);
    assert.ok(!out.includes('NaN') && !out.includes('e+'));
  }
});

test('单调：更大的数不会印出更小的值', () => {
  // 单位换档时最容易翻车的地方，用一组递增样本对一下
  const samples = [0, 1, KB - 1, KB, MB - 1, MB, GB - 1, GB, 10 * GB, TB - 1, TB];
  const rank = { B: 1, KB: 2, MB: 3, GB: 4, TB: 5 };
  let prev = -Infinity;
  for (const n of samples) {
    const [v, u] = fmtBytes(n).split(' ');
    const abs = Number(v) * (1024 ** (rank[u] - 1));
    assert.ok(abs >= prev, `${n} 折算后比前一个小`);
    prev = abs;
  }
});

/* ── isSelectable ──────────────────────────────────────────
   这个判据漏过一次：行级复选框是对的，但批量入口各自判断、各自漏了
   软链接那一半。点「推荐清理」→ 选区里混进一个软链接 → 服务端
   "先校验全批再动手" → 整批被拒，用户看到的是"勾上了却删不掉"。 */

test('软链接一律不可选，不管它在哪个分类', () => {
  const cats = [
    { verdict: 'safe', id: 'cache' },
    { verdict: 'junk', id: 'junk' },
    { verdict: 'review', id: 'oldRelease' },
    { verdict: 'never', id: 'database' },
    undefined,
  ];
  for (const cat of cats) {
    assert.equal(isSelectable({ link: true }, cat), false, `cat=${cat?.id}`);
  }
});

test('受保护分类一律不可选，哪怕它是普通文件', () => {
  assert.equal(isSelectable({}, { verdict: 'never' }), false);
  assert.equal(isSelectable({ link: false }, { verdict: 'never' }), false);
});

test('普通文件在非保护分类里可选', () => {
  for (const v of ['safe', 'junk', 'review', 'serious']) {
    assert.equal(isSelectable({}, { verdict: v }), true, v);
  }
});

test('分类查不到时不放行 —— 判不出来就不许勾', () => {
  /* 这条曾被写成相反的样子：`cat?.verdict ?? 'review'`，即"查不到就当谨慎清理"，
     于是分类表与规则表短暂不一致时，未归类的东西成了默认可删项。
     两种错法的代价不对称：误锁一个需要人手动放开（可恢复），
     误放一个受保护的东西（不可恢复）。所以缺省必须是 never。 */
  assert.equal(isSelectable({}), false, '没有分类 → 不可勾');
  assert.equal(isSelectable({}, null), false, '分类为 null → 不可勾');
  assert.equal(isSelectable({}, {}), false, '分类对象缺 verdict → 不可勾');
  assert.equal(isSelectable({}, { verdict: 'review' }), true, '明确给了 review 才可勾');
  assert.equal(isSelectable({ link: true }, { verdict: 'review' }), false, '软链接一律不可勾');
});

test('fmtBytes 对脏输入不印出 NaN / Infinity / 负数', () => {
  /* 界面上一旦出现 "NaN B" 或 "-1 B"，人只会以为工具算错了。
     目录在删除回执里用 -1 当哨兵，那个值不该直接流到格式化函数里。 */
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, -1, -1048576, 'abc', {}, []]) {
    const out = fmtBytes(bad);
    assert.doesNotMatch(out, /NaN|Infinity|^-/, `fmtBytes(${String(bad)}) 印出了 ${out}`);
  }
  assert.equal(fmtBytes(-1), '0 B');
  assert.equal(fmtBytes(NaN), '0 B');
});

test('真实形态：Codex 旧版本目录里的 codex 是个软链接，同目录的其他文件不是', () => {
  // 这就是用户实际撞到的那一条：
  //   packages/app-server-daemon/releases/0.159.3-aarch64-apple-darwin/codex
  const oldRelease = { verdict: 'review', id: 'oldRelease' };
  assert.equal(isSelectable({ p: 'packages/app-server-daemon/releases/0.159.3/codex', link: true }, oldRelease), false);
  assert.equal(isSelectable({ p: 'packages/app-server-daemon/releases/0.159.3/README.md' }, oldRelease), true);
});
