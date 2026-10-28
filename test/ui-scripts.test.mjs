import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch } from '../scripts/cdp.mjs';
import { alphaOver, minimumContrast } from '../scripts/ui-colors.mjs';

test('contrast checks retain transparency until all background layers are composited', () => {
  const black = { r: 0, g: 0, b: 0, a: 0.5 };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const layers = alphaOver(black, black);
  assert.equal(layers.a, 0.75);
  assert.equal(alphaOver(layers, white).r, 63.75);
  assert.equal(minimumContrast('text', 20, '400'), 4.5);
  assert.equal(minimumContrast('text', 20, '700'), 3);
  assert.equal(minimumContrast('text', 24, '400'), 3);
});

test('missing Chrome executable rejects instead of emitting an uncaught process error', async () => {
  await assert.rejects(launch({ port: 1, executable: '/nonexistent-inspector-browser' }), /Chrome 启动失败.*ENOENT/);
});

test('baseline diff detects different DOM structures with equal serialized lengths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inspector-baseline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = path.join(root, 'before.json'), after = path.join(root, 'after.json');
  const snapshot = shapeHash => ({ tabs: ['zcode'], views: { zcode: { shape: 20, shapeHash, text: 'same', geo: {}, scrollW: 800 } } });
  await fs.writeFile(before, JSON.stringify(snapshot(123)));
  await fs.writeFile(after, JSON.stringify(snapshot(456)));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/ui-baseline.mjs', import.meta.url)), 'diff', before, after], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /结构/);
});
