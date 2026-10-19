/**
 * App 注册表。
 *
 * 五个工具在同一台机器上的形态差别很大，所以"分类学"不属于工具本身，
 * 而属于每一个 app：谁带自己的规则表、自己的扫描目标、自己的历史会话读法。
 *
 * 加一个 app = 在 lib/apps/ 下加一个模块，并把它登记到下面的 APPS 数组。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zcode from './zcode.mjs';
import codex from './codex.mjs';
import claude from './claude.mjs';
import cursor from './cursor.mjs';
import gemini from './gemini.mjs';

/** 展示顺序：从本工具的起源开始。 */
export const APPS = [zcode, codex, claude, cursor, gemini];

const BY_ID = new Map(APPS.map((a) => [a.id, a]));

export function getApp(id) {
  return BY_ID.get(id) || null;
}

export function homeShort(abs) {
  const home = os.homedir();
  return abs.startsWith(home) ? '~' + abs.slice(home.length) : abs;
}

/**
 * 展开成"要扫什么"：每个 app 连同它的目标绝对路径与存在性。
 *
 * @param {string|null} onlyApp  只审计这一个 app
 * @param {string|null} rootOverride 覆盖主目标路径（--root，只在单 app 下有意义）
 */
export function planApps(onlyApp = null, rootOverride = null) {
  if (onlyApp && !getApp(onlyApp)) {
    throw new Error(`未知 app：${onlyApp}。可选：${APPS.map((a) => a.id).join('、')}`);
  }
  const list = onlyApp ? [getApp(onlyApp)] : APPS;

  return list.map((app) => {
    const targets = app.targets().map((t, i) => {
      const p = i === 0 && rootOverride ? path.resolve(rootOverride.replace(/^~/, os.homedir())) : t.path;
      return { ...t, path: p, short: homeShort(p), exists: targetExists(t.kind, p) };
    });
    return { app, targets };
  });
}

function targetExists(kind, p) {
  try {
    const st = fs.statSync(p);
    return kind === 'dir' ? st.isDirectory() : st.isFile();
  } catch { return false; }
}

/** 给界面用的 app 摘要（不含文件清单）。 */
export function appSummaries(plans) {
  return plans.map(({ app, targets }) => ({
    id: app.id,
    label: app.label,
    history: app.history,
    // cursor 的会话库由 IDE 独占写入、键值之间没有外键可依 —— 只读分析，不给写路径
    writable: app.writable !== false,
    targets: targets.map((t) => ({
      key: t.key, kind: t.kind, path: t.path, short: t.short, label: t.label, exists: t.exists,
    })),
  }));
}
