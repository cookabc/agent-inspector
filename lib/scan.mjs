/**
 * 扫描：把每个 app 的每个目标摊平成文件清单。
 *
 * 以文件元数据为主；Codex 分类钩子会读取 rollout 首行。
 * 孤儿判定读取会话索引；完整的会话列表由 lib/tasks*.mjs 提供。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanupCopies } from './sqlite-open.mjs';

/**
 * 扫一个 app 的一个目标目录（或单文件）。
 * @param {object} app    lib/apps/<id>.mjs 导出的 app
 * @param {object} target { key, kind, path }
 * @param {string[]} stalePrefixes 属于"历史版本"的路径前缀
 */
export async function scanTarget(app, target, stalePrefixes = []) {
  const startedAt = Date.now();
  const files = [];
  const problems = [];
  let dirs = 0;

  if (target.kind === 'file') {
    try {
      const st = await fs.lstat(target.path);
      const rel = path.basename(target.path);
      files.push(entry(app, target.key, rel, st, stalePrefixes, target.path));
    } catch (err) {
      problems.push({ path: target.short || target.path, error: err.code || String(err) });
    }
    return finish(app, target, files, dirs, problems, Date.now() - startedAt);
  }

  // 迭代式遍历，避免深目录爆栈
  const stack = [{ abs: target.path, rel: '' }];

  while (stack.length) {
    const { abs, rel } = stack.pop();

    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      problems.push({ path: rel || '.', error: err.code || String(err) });
      continue;
    }

    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childAbs = path.join(abs, ent.name);

      let st;
      try {
        // lstat：符号链接按链接本身记录，不跟随，避免绕出目录树
        st = await fs.lstat(childAbs);
      } catch (err) {
        problems.push({ path: childRel, error: err.code || String(err) });
        continue;
      }

      if (st.isDirectory()) {
        dirs += 1;
        stack.push({ abs: childAbs, rel: childRel });
      } else {
        files.push(entry(app, target.key, childRel, st, stalePrefixes, childAbs));
      }
    }
  }

  return finish(app, target, files, dirs, problems, Date.now() - startedAt);
}

function entry(app, tkey, rel, st, stalePrefixes, abs) {
  const size = st.size;
  const stale = stalePrefixes.some((p) => rel === p || rel.startsWith(p + '/'));
  // 历史版本运行时是一类特别明确的"可清"，直接覆盖分类，省得规则表要去解析软链接
  let cat = stale && app.CATEGORIES.oldRelease ? 'oldRelease' : app.classify(rel, size, { app: app.id, t: tkey });
  /* 有些分类光看路径判不出来，得读文件本身（Codex 的 rollout 首行带
     history_base 就说明它只是会话的一段）。规则表拿不到绝对路径，
     所以由 app 提供一个可选钩子在这里补判 —— 传 abs 进去，返回新分类或 undefined。 */
  if (app.refineCategory && abs && st.isFile()) {
    const refined = app.refineCategory(rel, abs, cat);
    if (refined) cat = refined;
  }
  const sid = app.sessionIdOf ? app.sessionIdOf(rel) : null;
  // 符号链接：按链接本身记录（不跟随，避免绕出目录树），但它删不掉 ——
  // 服务端的 safeResolve 会拒绝路径里任何一级软链接。这件事必须在这里标出来，
  // 否则界面上把它画成一个 9 字节的可勾条目，人勾了才发现删不动。
  const link = st.isSymbolicLink();
  return { t: tkey, p: rel, s: size, m: st.mtimeMs, c: cat, sid, stale: stale || undefined, link: link || undefined };
}

function finish(app, target, files, dirs, problems, durationMs) {
  const byCat = new Map();
  for (const f of files) {
    const agg = byCat.get(f.c) || { bytes: 0, count: 0 };
    agg.bytes += f.s;
    agg.count += 1;
    byCat.set(f.c, agg);
  }
  const catalog = Object.values(app.CATEGORIES).map((meta) => {
    const agg = byCat.get(meta.id) || { bytes: 0, count: 0 };
    return { ...meta, bytes: agg.bytes, count: agg.count };
  });
  return {
    target: { key: target.key, kind: target.kind, path: target.path, short: target.short, label: target.label },
    files,
    dirs,
    problems,
    durationMs,
    catalog,
    categories: catalog.filter((c) => c.count > 0).sort((a, b) => b.bytes - a.bytes),
    bytes: files.reduce((s, f) => s + f.s, 0),
    fileCount: files.length,
  };
}

/**
 * 扫一个 app 的全部目标，并做会话孤儿判定。
 * @param {{app:object, targets:object[]}} plan
 */
export async function scanApp(plan) {
  const { app } = plan;
  for (const target of plan.targets) {
    try {
      const st = await fs.stat(target.path);
      target.exists = target.kind === 'file' ? st.isFile() : st.isDirectory();
    } catch { target.exists = false; }
  }
  const startedAt = Date.now();

  // "历史版本"前缀只有在能解析 current 软链接时才成立；解析不到就一个都不标
  let stalePrefixes = [];
  if (app.staleDirs) {
    try { stalePrefixes = await app.staleDirs(plan.targets[0].path); } catch { stalePrefixes = []; }
  }

  const scans = [];
  for (const target of plan.targets) {
    if (!target.exists) { scans.push(null); continue; }
    // 单文件目标的"历史版本"判定不适用
    scans.push(await scanTarget(app, target, target.kind === 'dir' ? stalePrefixes : []));
  }

  const files = scans.filter(Boolean).flatMap((s) => s.files);
  // 孤儿判定读会话库：读不到就返回 null，此时**不判定**，而不是判定"全都是孤儿"
  const liveSessions = files.some((f) => f.sid) ? await app.liveSessions(plan.targets[0].path) : null;
  if (liveSessions) {
    for (const f of files) if (f.sid) f.orphan = !liveSessions.has(f.sid);
  }
  // WAL 库只读打不开时会复制一份到临时目录，用完就清掉
  await cleanupCopies();

  const byCat = new Map();
  for (const f of files) {
    const agg = byCat.get(f.c) || { bytes: 0, count: 0 };
    agg.bytes += f.s;
    agg.count += 1;
    byCat.set(f.c, agg);
  }
  const catalog = Object.values(app.CATEGORIES).map((meta) => {
    const agg = byCat.get(meta.id) || { bytes: 0, count: 0 };
    return { ...meta, bytes: agg.bytes, count: agg.count };
  });

  const present = scans.filter(Boolean);
  return {
    app: app.id,
    label: app.label,
    history: app.history,
    // 会话库能不能按行清理：cursor 只读。判定以 app.writable 为准，缺省视为可写
    writable: app.writable !== false,
    // 有没有受控的回灌写路径（目前只有 Cursor）—— 前端据此决定面板放不放
    canRecover: app.canRecover === true,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    targets: scans.map((s, i) => ({
      key: plan.targets[i].key,
      kind: plan.targets[i].kind,
      path: plan.targets[i].path,
      short: plan.targets[i].short,
      label: plan.targets[i].label,
      exists: plan.targets[i].exists,
      bytes: s ? s.bytes : 0,
      files: s ? s.fileCount : 0,
      dirs: s ? s.dirs : 0,
    })),
    totals: {
      bytes: files.reduce((s, f) => s + f.s, 0),
      files: files.length,
      dirs: present.reduce((s, x) => s + x.dirs, 0),
    },
    categories: catalog.filter((c) => c.count > 0).sort((a, b) => b.bytes - a.bytes),
    catalog,
    files,
    liveSessions: liveSessions ? liveSessions.size : null,
    problems: present.flatMap((s) => s.problems.map((p) => ({ ...p, app: app.id }))),
  };
}

/** 扫全部 app。 */
export async function scanApps(plans) {
  const startedAt = Date.now();
  const apps = [];
  for (const plan of plans) apps.push(await scanApp(plan));
  return {
    apps,
    grand: {
      bytes: apps.reduce((s, a) => s + a.totals.bytes, 0),
      files: apps.reduce((s, a) => s + a.totals.files, 0),
      dirs: apps.reduce((s, a) => s + a.totals.dirs, 0),
    },
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    // 分类字典按 app 给，前端反查文案要用 app + id
    catalogs: Object.fromEntries(apps.map((a) => [a.app, a.catalog])),
  };
}
