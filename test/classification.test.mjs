/**
 * 分类学的跨 app 一致性。
 *
 * 这些规则不分 app —— 同一个路径在不同工具下落到同一个分类，是"分类是纯函数"
 * 这件事的前提。实测漂过两回：`backups/` 只在 Claude 有专门规则，Codex 与 ZCode
 * 于是把 44 MB 的项目副本归进了 unknown；同一个 pluginData 有四个名字。
 *
 * 所以这里不定逐条规则的细节，只锁两件事：
 *   1. 共享规则在每家给出同一个答案
 *   2. 每个 app 的 CATEGORIES 都覆盖自己 RULES 会输出的 id
 *
 * app 列表从注册表读，不在这里手写 —— 手写的话，新加一个工具时这些测试
 * 会安静地跳过它，"所有 app 一致"就成了一句没人验证的话。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS } from '../lib/apps/index.mjs';
import { SHARED_RULES } from '../lib/apps/common.mjs';

/** 每个 app 的第一个目标 key —— 规则里 ctx.t 用它区分多根目录。 */
const mainTarget = (app) => app.targets()[0].key;
const ctxOf = (app) => ({ app: app.id, t: mainTarget(app) });

test('共享规则在每家给出同一个答案', () => {
  /* 这里锁的是"同一个路径在每家得到同一个分类"。
     dataBackupDir 容易被排除在外（理由是 Claude 的 backups/ 更像配置副本），
     结果各家对 backups/x.sqlite 给出三种答案：claude=configBackup、
     codex=database（扩展名规则抢在前面）、zcode/cursor=dataBackup。
     测试绕开不一致，等于把 bug 写进了契约 —— 现在每家都过同一条规则。 */
  const cases = [
    ['config.toml.bak-1792466836243', 'configBackup'],
    ['.claude.json.backup.1792466836243', 'configBackup'],
    ['settings.json.bak', 'configBackup'],
    // 备份目录里的 .sqlite 是**副本**，不该被 database 规则锁成"请勿删除"
    ['backups/2026/state_5.sqlite', 'dataBackup'],
    ['backups/run/originals.zip', 'dataBackup'],
    ['backup/cli-1792472417012/tables.sqlite', 'dataBackup'],
  ];
  for (const [rel, want] of cases) {
    for (const app of APPS) {
      const got = app.classify(rel, 1024, ctxOf(app));
      assert.equal(got, want, `${app.id} 把 ${rel} 归成了 ${got}，应为 ${want}`);
    }
  }
});

test('Cursor 的两个目标语义不同: cli 侧 backups/ 是数据副本, ide 侧是未保存内容', () => {
  const cursor = APPS.find((a) => a.id === 'cursor');
  // cli 侧（~/.cursor）跟其余各家一样
  assert.equal(cursor.classify('backups/run/x.zip', 1, { app: 'cursor', t: 'cli' }), 'dataBackup');
  // ide 侧（App Support）的 Backups/ 是编辑器崩溃备份，有自己的一档
  assert.equal(cursor.classify('Backups/abc', 1, { app: 'cursor', t: 'ide' }), 'backups');
  // 两侧都不能掉进 unknown
  assert.notEqual(cursor.classify('backup/x', 1, { app: 'cursor', t: 'cli' }), 'unknown');
});

test('共享规则本身是纯函数，不看体积与目标', () => {
  for (const [name, fn] of Object.entries(SHARED_RULES)) {
    assert.equal(fn.length, 1, `${name} 应当只接收路径参数`);
    for (const rel of ['backups/x', 'a/b.c', '.DS_Store']) {
      assert.equal(fn(rel), fn(rel), `${name} 对 ${rel} 不稳定`);
    }
  }
});

test('每个 app 的分类表覆盖它自己的规则会输出的 id', () => {
  // 拿每个 app 的真实文件路径去跑规则，凡是产出的 id 都必须能在 CATEGORIES 里查到。
  // 漏一条不会在扫描时崩（classify 只返回字符串），但界面上会出现 label 是个
  // 原始 id、状态色是兜底的那一行 —— 属于"看起来没坏、其实在骗人"。
  const samples = [
    'backups/run/originals.zip',
    'config.toml.bak',
    'state_5.sqlite',
    'auth.json',
    'a/b/c.log',
    'unknown-dir/x.bin',
    '.DS_Store',
    'sessions/2026/01/02/rollout-x.jsonl',
    'projects/-Users-x/abc.jsonl',
    'plans/a.plan.md',
  ];
  for (const app of APPS) {
    const ctx = ctxOf(app);
    for (const rel of samples) {
      const id = app.classify(rel, 1024, ctx);
      assert.ok(
        Object.hasOwn(app.CATEGORIES, id),
        `${app.id}: 规则产出了 ${id}，但 CATEGORIES 里没有 —— ${rel}`,
      );
    }
  }
});

test('顶层 backups/ 不会被当成配置文件或缓存', () => {
  // 这两类都是"可安全清理 / 可重拉"，而 backups/ 里是不可再生的完整副本。
  const safe = new Set(['cache', 'temp', 'junk', 'appLog', 'shellSnapshot', 'pluginMarket']);
  for (const app of APPS) {
    const id = app.classify('backups/x/originals.zip', 44 * 1024 * 1024, ctxOf(app));
    assert.ok(!safe.has(id), `${app.id} 把 backups/ 归进了 ${id} —— 那是不可再生的副本`);
    assert.notEqual(id, 'unknown', `${app.id} 把 backups/ 归进了 unknown`);
  }
});

test('SQLite 的 WAL、SHM、回滚日志与主库一样禁止按文件删除', () => {
  for (const app of APPS) {
    const target = app.id === 'cursor' ? 'ide' : 'root';
    const base = app.id === 'zcode' ? 'cli/db/db.sqlite' : app.id === 'cursor' ? 'User/workspaceStorage/ws/state.vscdb' : 'state.sqlite';
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const id = app.classify(base + suffix, 100, { app: app.id, t: target });
      assert.equal(app.CATEGORIES[id].locked, true, `${app.id} ${base + suffix}`);
    }
  }
});
