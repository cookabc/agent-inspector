import assert from 'node:assert/strict';
import { test } from 'node:test';
import { squarify, verdictTreemap } from '../public/treemap.js';

test('squarify lays every item out inside the rectangle', () => {
  const items = [
    { id: 'a', value: 50 },
    { id: 'b', value: 30 },
    { id: 'c', value: 20 },
  ];
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  const out = squarify(items, rect);

  assert.equal(out.length, 3);
  for (const box of out) {
    assert.ok(box.x >= rect.x - 0.001, `${box.id} starts inside`);
    assert.ok(box.y >= rect.y - 0.001, `${box.id} starts inside`);
    assert.ok(box.x + box.w <= rect.x + rect.w + 0.001, `${box.id} ends inside`);
    assert.ok(box.y + box.h <= rect.y + rect.h + 0.001, `${box.id} ends inside`);
    assert.ok(box.w > 0 && box.h > 0, `${box.id} has area`);
  }
});

test('squarify gives each item an area proportional to its value', () => {
  const items = [
    { id: 'a', value: 60 },
    { id: 'b', value: 30 },
    { id: 'c', value: 10 },
  ];
  const rect = { x: 0, y: 0, w: 200, h: 100 };
  const out = squarify(items, rect);
  const total = rect.w * rect.h;

  for (const box of out) {
    const expected = (box.value / 100) * total;
    const actual = box.w * box.h;
    // The squarify algorithm leaves a little slack; a few percent is fine.
    assert.ok(
      Math.abs(actual - expected) / expected < 0.05,
      `${box.id} area ${actual} should be close to ${expected}`,
    );
  }
});

test('squarify produces squares rather than slivers', () => {
  // The whole point of squarified treemaps: a 10% item should not be a
  // 1%-wide strip. This is the difference between a readable map and a
  // pile of hairlines.
  const items = Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, value: 10 }));
  const out = squarify(items, { x: 0, y: 0, w: 400, h: 400 });
  for (const box of out) {
    const ratio = Math.max(box.w / box.h, box.h / box.w);
    assert.ok(ratio < 3, `${box.id} aspect ratio ${ratio} is too slanted`);
  }
});

test('squarify keeps the input order in its output', () => {
  const items = [
    { id: 'first', value: 10 },
    { id: 'second', value: 90 },
  ];
  const out = squarify(items, { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(out.map((box) => box.id), ['first', 'second']);
});

test('squarify handles an empty or zero-size input', () => {
  assert.deepEqual(squarify([], { x: 0, y: 0, w: 100, h: 100 }), []);
  assert.deepEqual(squarify([{ id: 'a', value: 0 }], { x: 0, y: 0, w: 100, h: 100 }), []);
  assert.deepEqual(squarify([{ id: 'a', value: 5 }], { x: 0, y: 0, w: 0, h: 100 }), []);
});

test('squarify is deterministic', () => {
  const items = [
    { id: 'a', value: 40 },
    { id: 'b', value: 25 },
    { id: 'c', value: 25 },
    { id: 'd', value: 10 },
  ];
  const rect = { x: 0, y: 0, w: 300, h: 200 };
  const first = squarify(items, rect);
  const second = squarify(items, rect);
  assert.deepEqual(first, second);
});

test('the verdict treemap keeps the bands in severity order', () => {
  const categories = [
    { id: 'never1', label: '凭据', value: 10, verdict: 'never', status: 'critical' },
    { id: 'safe1', label: '缓存', value: 30, verdict: 'safe', status: 'good' },
    { id: 'review1', label: '会话正文', value: 20, verdict: 'review', status: 'warning' },
    { id: 'junk1', label: '系统垃圾', value: 5, verdict: 'junk', status: 'good' },
  ];
  const out = verdictTreemap(categories, { x: 0, y: 0, w: 400, h: 400 });
  assert.equal(out.length, 4);

  // What you can clear first comes first.
  const verdicts = out.map((box) => box.verdict);
  assert.equal(verdicts[0], 'junk');
  assert.equal(verdicts[verdicts.length - 1], 'never');
});

test('the verdict treemap gives each band its share of the height', () => {
  const categories = [
    { id: 'safe1', label: '缓存', value: 75, verdict: 'safe', status: 'good' },
    { id: 'never1', label: '凭据', value: 25, verdict: 'never', status: 'critical' },
  ];
  const out = verdictTreemap(categories, { x: 0, y: 0, w: 400, h: 400 });
  const safe = out.find((box) => box.id === 'safe1');
  const never = out.find((box) => box.id === 'never1');
  // 75% of the disk sits in the safe band.
  assert.ok(safe.h > never.h * 2.5, `safe band ${safe.h} should dominate ${never.h}`);
});

test('the verdict treemap drops categories with no size', () => {
  const categories = [
    { id: 'a', label: '缓存', value: 10, verdict: 'safe', status: 'good' },
    { id: 'empty', label: '空的', value: 0, verdict: 'review', status: 'warning' },
  ];
  const out = verdictTreemap(categories, { x: 0, y: 0, w: 400, h: 400 });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a');
});

test('tiny categories retain their exact byte proportions across and within bands', () => {
  const categories = [
    { id: 'big', label: '大头', value: 9900, verdict: 'review', status: 'warning' },
    { id: 'tiny1', label: '小一', value: 40, verdict: 'safe', status: 'good' },
    { id: 'tiny2', label: '小二', value: 40, verdict: 'never', status: 'critical' },
    { id: 'tiny3', label: '小三', value: 20, verdict: 'safe', status: 'good' },
  ];
  const out = verdictTreemap(categories, { x: 0, y: 0, w: 400, h: 400 });
  const area = out.reduce((sum, box) => sum + box.w * box.h, 0);
  for (const box of out) {
    assert.ok(Math.abs(box.w * box.h / area - box.value / 10000) < 1e-10, `${box.id} area must represent its byte share`);
  }
});

test('the verdict treemap bands never overlap', () => {
  const categories = [
    { id: 'a', label: '甲', value: 500, verdict: 'review', status: 'warning' },
    { id: 'b', label: '乙', value: 300, verdict: 'safe', status: 'good' },
    { id: 'c', label: '丙', value: 200, verdict: 'never', status: 'critical' },
  ];
  const out = verdictTreemap(categories, { x: 0, y: 0, w: 400, h: 400 });
  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      const a = out[i];
      const b = out[j];
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(
        overlapX <= 0.5 || overlapY <= 0.5,
        `${a.id} and ${b.id} overlap`,
      );
    }
  }
});
