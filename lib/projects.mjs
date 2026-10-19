/**
 * 按项目横切：把五个工具的会话归并到"同一个项目"下面。
 *
 * 为什么需要它：每个工具的会话面板都是自己看自己 —— ZCode 的界面里看不到
 * Codex 在这个项目留下的线程，反过来也是。而这个工具要回答的是管理视角的
 * 问题："这个 repo 在所有 agent 里一共留了多少、哪些还能清"。
 *
 * 归并的难点是五个工具说的不是同一种"项目"：
 *   zcode   workspace_key / workspace_path —— 绝对路径
 *   codex   threads.cwd                      —— 绝对路径
 *   claude  .jsonl 首行的 cwd                —— 读不到时回落成 projects/<slug> 目录名
 *   cursor  composerHeaders.workspaceId      —— 不透明 UUID（调用方已尽量反查成路径）
 *
 * 所以归并规则是"能确定才归并"：只有以 / 开头的绝对路径才进入项目桶，
 * slug 和 UUID 单独成桶并说明原因 —— 猜出来的关联比没有关联更糟。
 */

/** realpath 缓存：同一路径在一次归并里只解析一次。 */
function realpathCache() {
  const cache = new Map();
  return (p) => {
    if (cache.has(p)) return cache.get(p);
    let real = p;
    try { real = fsRealpathNative(p); } catch { /* 目录已经没了：用原路径 */ }
    cache.set(p, real);
    return real;
  };
}

// 走 node:fs 的 native 版：macOS 的 /var ↔ /private/var 这种软链要按 FS 语义解
import fs from 'node:fs';
const fsRealpathNative = (p) => fs.realpathSync.native(p);

/** 这条会话能不能按项目归并，以及归并键是什么。 */
function projectKeyOf(task) {
  const raw = typeof task.workspace === 'string' ? task.workspace : '';
  // 绝对路径才可靠：ZCode / Codex / Claude（读得到 cwd 时）/ Cursor（反查成功时）都是它
  if (raw.startsWith('/')) return { resolvable: true, key: raw };
  // 其余：UUID、slug、空串 —— 各按各的形态单独成桶
  if (!raw) return { resolvable: false, key: 'none', raw: null };
  if (task.workspaceOpaque) return { resolvable: false, key: `opaque:${raw}`, raw };
  return { resolvable: false, key: `slug:${raw}`, raw };
}

/**
 * @param {Array<{appId:string, appLabel:string, tasks:Array}>} byApp 每个工具的会话列表
 * @returns {{projects:Array, unresolvable:Array, totals:object}}
 */
export function projectsFrom(byApp) {
  const toReal = realpathCache();
  const buckets = new Map();

  for (const { appId, appLabel, tasks } of byApp) {
    for (const t of tasks || []) {
      const { resolvable, key, raw } = projectKeyOf(t);
      let bucketKey = key;
      if (resolvable) bucketKey = toReal(key);
      let bucket = buckets.get(bucketKey);
      if (!bucket) buckets.set(bucketKey, bucket = {
        key: bucketKey,
        resolvable,
        raw: resolvable ? null : (raw || null),
        apps: new Map(),
        bytes: 0,
        sessions: 0,
        tasks: [],
      });
      bucket.bytes += t.bytes || 0;
      bucket.sessions += 1;
      bucket.tasks.push({ ...t, appId, appLabel });
      const perApp = bucket.apps.get(appId) || { appId, appLabel, sessions: 0, bytes: 0 };
      perApp.sessions += 1;
      perApp.bytes += t.bytes || 0;
      bucket.apps.set(appId, perApp);
    }
  }

  const all = [...buckets.values()];
  const projects = all.filter((b) => b.resolvable);
  const unresolvable = all.filter((b) => !b.resolvable);

  const finalize = (b) => ({
    ...b,
    path: b.resolvable ? b.key : null,
    label: b.resolvable ? b.key : (b.raw ? `无法归并：${b.raw}` : '无法归并：没有工作区信息'),
    apps: [...b.apps.values()].sort((a, b2) => b2.bytes - a.bytes),
    tasks: b.tasks.sort((a, b2) => b2.bytes - a.bytes),
  });

  projects.sort((a, b) => b.bytes - a.bytes);
  unresolvable.sort((a, b) => b.bytes - a.bytes);

  const finalized = projects.map(finalize);
  const finalUnres = unresolvable.map(finalize);

  return {
    projects: finalized,
    unresolvable: finalUnres,
    totals: {
      projects: finalized.length,
      sessions: finalized.concat(finalUnres).reduce((s, b) => s + b.sessions, 0),
      bytes: finalized.concat(finalUnres).reduce((s, b) => s + b.bytes, 0),
    },
  };
}
