/**
 * 级联删除的编排纪律。
 *
 * 这一层的价值全在**顺序与失败面**上：删的东西对不对由各家适配器负责，
 * 而"先备份、再删库、最后删文件"以及"某一步失败时剩下的是什么状态"
 * 只能在这里证明。所以下面每条测试都用会记账的假实现，
 * 断言调用顺序与中途失败时的可恢复性 —— 不用真文件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runCascade, describeCascade, filesToRemove, cascadeSummary } from '../lib/cascade.mjs';

/** 记账用的替身：每次调用都往 log 里写一行，可指定某步抛错。 */
function harness({ failBackupAt = null, failRemoveAt = null, failDb = false } = {}) {
  const log = [];
  return {
    log,
    deps: {
      purgeDb: async (ids) => {
        log.push(['db', ids.length]);
        if (failDb) throw Object.assign(new Error('库删失败'), { statusCode: 500 });
        return { perDb: [{ table: 'message', deleted: 7 }], freed: 4096, backup: '/b/db' };
      },
      backupFile: async (rel) => {
        log.push(['backup', rel]);
        if (failBackupAt && rel === failBackupAt) throw new Error('磁盘满了');
        return `/b/${rel}`;
      },
      removeFile: async (rel) => {
        log.push(['remove', rel]);
        if (failRemoveAt && rel === failRemoveAt) throw new Error('权限不足');
        return { bytes: 10 };
      },
    },
  };
}

const FILES = [
  { rel: 'a/1.bin', role: 'media', bytes: 10 },
  { rel: 'a/2.bin', role: 'media', bytes: 20 },
];

test('顺序：先备份完全部文件，再删库，最后删文件', async () => {
  const h = harness();
  await runCascade({ dbIds: ['x'], files: FILES, ...h.deps });
  assert.deepEqual(h.log.map((e) => e[0]), ['backup', 'backup', 'db', 'remove', 'remove'],
    '顺序错了就有"库删了但文件没备份"的窗口');
});

test('备份失败时整批中止，数据库一行都不动', async () => {
  const h = harness({ failBackupAt: 'a/2.bin' });
  await assert.rejects(
    runCascade({ dbIds: ['x'], files: FILES, ...h.deps }),
    /备份失败，已放弃整批删除（数据库未改动）/);
  assert.ok(!h.log.some((e) => e[0] === 'db'), '备份没做完就绝不能碰库');
  assert.ok(!h.log.some((e) => e[0] === 'remove'), '更不能删文件');
});

test('库删失败时说清文件还在、且已备份 —— 不能让人以为删了', async () => {
  const h = harness({ failDb: true });
  await assert.rejects(
    runCascade({ dbIds: ['x'], files: FILES, ...h.deps }),
    (err) => {
      assert.match(err.message, /文件已备份到/);
      assert.match(err.message, /未删除/);
      return true;
    });
  assert.ok(!h.log.some((e) => e[0] === 'remove'), '库失败后不该继续删文件');
});

test('删文件逐项独立：一个失败不拖累其余，失败项带备份位置', async () => {
  const h = harness({ failRemoveAt: 'a/1.bin' });
  const r = await runCascade({ dbIds: ['x'], files: FILES, ...h.deps });
  assert.equal(r.files.length, 1, '成功的那个要报出来');
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].rel, 'a/1.bin');
  assert.match(r.failed[0].error, /权限不足/);
  assert.ok(r.failed[0].backup, '失败项必须能指到它的备份');
  assert.equal(h.log.filter((e) => e[0] === 'remove').length, 2, '两项都试过');
});

test('没有文件时不进入备份与删除阶段，只删库', async () => {
  const h = harness();
  const r = await runCascade({ dbIds: ['x'], files: [], ...h.deps });
  assert.deepEqual(h.log.map((e) => e[0]), ['db']);
  assert.equal(r.files.length, 0);
  assert.equal(r.failed.length, 0);
});

test('dry-run 不碰任何东西，但把将要删的清单交出来', async () => {
  const h = harness();
  const r = await runCascade({ dbIds: ['x'], files: FILES, dryRun: true, ...h.deps });
  assert.deepEqual(h.log, [], '空跑必须一个字都不能写');
  assert.equal(r.files.length, 2, '清单要给出来');
  assert.equal(r.dryRun, true);
});

test('只取可删的文件：不删的项不许进删除队列', () => {
  const contents = {
    files: [
      { rel: 'a.jsonl', role: 'body', bytes: 10, removable: true },
      { rel: 'conversation-search.db', role: 'index', bytes: 999, removable: false },
      { rel: '', role: 'projection', bytes: 5, removable: true },
    ],
  };
  const out = filesToRemove(contents);
  assert.equal(out.length, 1, '不可删的与空路径都要滤掉');
  assert.equal(out[0].rel, 'a.jsonl');
});

test('描述阶段用的数字与实际执行一致', () => {
  const stages = describeCascade({ dbIds: ['a', 'b'], files: FILES });
  assert.equal(stages.length, 3);
  assert.equal(stages.find((s) => s.stage === 'db').count, 2);
  assert.equal(stages.find((s) => s.stage === 'backup').bytes, 30);
});

test('结果摘要：全部成功与部分失败说不同的话', () => {
  const ok = cascadeSummary({ db: { perDb: [{ deleted: 7 }] }, files: [{ bytes: 1024 }], failed: [], backup: '/b' });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /7 行/);
  assert.match(ok.text, /1 个文件/);

  const partial = cascadeSummary({ db: { perDb: [{ deleted: 7 }] }, files: [], failed: [{ rel: 'x' }], backup: '/b' });
  assert.equal(partial.ok, false);
  assert.match(partial.text, /没删成/);
  assert.match(partial.text, /\/b/);
});
