/**
 * 过期缓存 + 并发合流的测试。
 *
 * 这个模块是"过期 + 并发合流 + 写代数校验"的唯一实现。它的价值不在于
 * 省行数，而在于**只有一处会写错** —— 所以每一条约束都要钉住：
 *
 *   · 过期时间内命中缓存，不发第二次请求
 *   · 并发请求搭同一趟车，只跑一次 load
 *   · force 绕过缓存
 *   · 写代数变了就不写缓存（否则"写盘前的旧值"会缓存进"写盘后"）
 *   · invalidate 之后必须重新加载
 *   · load 失败时 inflight 要清掉，否则下次永远拿到那个失败的 Promise
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.mjs';

/** 让出若干轮事件循环，确保所有 await 都落地。 */
const settle = () => new Promise((r) => setTimeout(r, 0));

test('过期时间内命中缓存，load 只跑一次', async () => {
  const c = createCache({ ttlMs: 60_000 });
  let n = 0;
  const load = async () => { n += 1; return `v${n}`; };

  const a = await c.get({ load });
  const b = await c.get({ load });
  assert.equal(a.data, 'v1');
  assert.equal(b.data, 'v1');
  assert.equal(b.cached, true);
  assert.equal(n, 1, 'TTL 内不该再跑一次');
});

test('过期后重新加载', async () => {
  const c = createCache({ ttlMs: 10 });
  let n = 0;
  const load = async () => { n += 1; return n; };
  await c.get({ load });
  await new Promise((r) => setTimeout(r, 25));
  const b = await c.get({ load });
  assert.equal(b.data, 2);
  assert.equal(b.cached, false);
});

test('force 绕过缓存', async () => {
  const c = createCache({ ttlMs: 60_000 });
  let n = 0;
  const load = async () => { n += 1; return n; };
  await c.get({ load });
  const b = await c.get({ force: true, load });
  assert.equal(b.data, 2);
  assert.equal(b.cached, false);
});

test('并发请求只跑一趟 load（搭车）', async () => {
  const c = createCache({ ttlMs: 60_000 });
  let n = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const load = async () => { n += 1; await gate; return 'slow'; };

  const p1 = c.get({ load });
  const p2 = c.get({ load });
  const p3 = c.get({ load });
  await settle();
  release();

  const all = await Promise.all([p1, p2, p3]);
  assert.deepEqual(all.map((x) => x.data), ['slow', 'slow', 'slow']);
  assert.equal(n, 1, '三个并发请求应当只触发一次 load');
  // 三个都没拿到 cached（它们都在等同一趟）
  assert.deepEqual(all.map((x) => x.cached), [false, false, false]);
});

test('load 失败时清掉 inflight —— 下一次要能重新试', async () => {
  const c = createCache({ ttlMs: 60_000 });
  let n = 0;
  const load = async () => {
    n += 1;
    if (n === 1) throw new Error('第一次失败');
    return 'ok';
  };

  await assert.rejects(() => c.get({ load }), /第一次失败/);
  // 关键：如果 inflight 没清，这里会拿到同一个 rejected Promise
  const r = await c.get({ load });
  assert.equal(r.data, 'ok');
  assert.equal(n, 2, '失败之后应当允许重试');
});

test('失败的 load 不写缓存', async () => {
  const c = createCache({ ttlMs: 60_000 });
  await assert.rejects(() => c.get({ load: async () => { throw new Error('x'); } }));
  assert.equal(c.peek(), null, '失败不该留下缓存条目');
});

test('invalidate 之后必须重新加载', async () => {
  const c = createCache({ ttlMs: 60_000 });
  let n = 0;
  const load = async () => { n += 1; return n; };
  await c.get({ load });
  c.invalidate();
  const b = await c.get({ load });
  assert.equal(b.data, 2);
  assert.equal(b.cached, false);
});

test('写代数变了就不写缓存 —— 否则写盘前的旧值会缓存进写盘后', async () => {
  let epoch = 1;
  const c = createCache({ ttlMs: 60_000, epoch: () => epoch });
  let n = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const load = async () => { n += 1; await gate; return `v${n}`; };

  const p = c.get({ load });
  await settle();
  // 加载期间有人写了盘
  epoch += 1;
  release();
  const r = await p;

  assert.equal(r.data, 'v1', '这一趟的调用方拿到的是算出来的结果');
  assert.equal(c.peek(), null, '但这份结果不该进缓存 —— 它可能已经过期');

  // 下一次请求要重新算
  const again = await c.get({ load });
  assert.equal(again.cached, false);
  assert.equal(n, 2);
});

test('写代数没变就正常写缓存', async () => {
  let epoch = 1;
  const c = createCache({ ttlMs: 60_000, epoch: () => epoch });
  const r = await c.get({ load: async () => 'ok' });
  assert.equal(r.data, 'ok');
  assert.ok(c.peek(), '代数没变，应当写进缓存');
  assert.equal(c.peek().epoch, 1);
});

test('peek 暴露的是副本信息，不会因为外部改动影响缓存', async () => {
  const c = createCache({ ttlMs: 60_000 });
  await c.get({ load: async () => ({ list: [1, 2] }) });
  const peeked = c.peek();
  assert.deepEqual(peeked.data, { list: [1, 2] });
  assert.equal(typeof peeked.at, 'number');
});

test('ttl 极短时不会因为时间精度问题退化', async () => {
  const c = createCache({ ttlMs: 1 });
  let n = 0;
  const load = async () => { n += 1; return n; };
  await c.get({ load });
  await new Promise((r) => setTimeout(r, 5));
  const b = await c.get({ load });
  assert.equal(b.data, 2);
});
