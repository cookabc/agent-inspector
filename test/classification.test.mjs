/**
 * 分类学的跨 app 一致性。
 *
 * 这些规则不分 app —— 同一个路径在不同工具下落到同一个分类，是"分类是纯函数"
 * 这件事的前提。实测漂过两回：`backups/` 只在 Claude 有专门规则，Codex 与 ZCode
 * 于是把 44 MB 的项目副本归进了 unknown；同一个 pluginData 曾经四个名字。
 *
 * 所以这里不定逐条规则的细节，只锁两件事：
 *   1. 共享规则在四家给出同一个答案
 *   2. 每个 app 的 CATEGORIES 都覆盖自己 RULES 会输出的 id
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import claude from '../lib/apps/claude.mjs';
import codex from '../lib/apps/codex.mjs';
import cursor from '../lib/apps/cursor.mjs';
import zcode from '../lib/apps/zcode.mjs';
import { SHARED_RULES } from '../lib/apps/common.mjs';

const APPS = [claude, codex, cursor, zcode];

/** 每个 app 的第一个目标 key —— 规则里 ctx.t 用它区分多根目录。 */
const mainTarget = (app) => app.targets()[0].key;
const ctxOf = (app) => ({ app: app.id, t: mainTarget(app) });

test('共享规则在四家给出同一个答案', () => {
  // 只挑与目标无关、且四家语义确实相同的共享规则。
  // dataBackupDir 不在此列：Claude 的 backups/ 里就是 .claude.json 的配置副本，
  // 对它而言 configBackup 才是真话；Codex/ZCode/Cursor 的 backups/ 装的是数据副本。
  // 这里锁的是"同一个规则对象被四家引用"，不是"四家对 backups/ 下同一个结论"。
  const cases = [
    ['config.toml.bak-1792466836243', 'configBackup'],
    ['.claude.json.backup.1792466836243', 'configBackup'],
    ['settings.json.bak', 'configBackup'],
  ];
  for (const [rel, want] of cases) {
    for (const app of APPS) {
      const got = app.classify(rel, 1024, ctxOf(app));
      assert.equal(got, want, `${app.id} 把 ${rel} 归成了 ${got}，应为 ${want}`);
    }
  }
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
