/**
 * 扫描 ~/.zcode：只 stat，绝不读文件内容（既快，也不碰隐私）。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classify, CATEGORIES } from './rules.mjs';

/**
 * @param {string} root  绝对路径，通常 ~/.zcode
 * @returns {Promise<object>} 完整索引
 */
export async function scan(root) {
  const startedAt = Date.now();
  const files = [];       // { p, s, m, c }
  const dirSizes = new Map();
  const dirCounts = new Map();
  let dirs = 0;
  const problems = [];

  // 迭代式遍历，避免深目录爆栈
  const stack = [{ abs: root, rel: '' }];

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
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        dirs += 1;
        stack.push({ abs: childAbs, rel: childRel });
      } else {
        const size = st.size;
        const cat = classify(childRel, size);
        // 会话相关的文件：路径里带 sess_<id>，取出 id。其余为 null。
        const sid = sessionIdOf(childRel);
        files.push({ p: childRel, s: size, m: st.mtimeMs, c: cat, sid });

        // 把体积/数量累加到自身及其所有祖先目录
        let cursor = childRel;
        while (cursor.includes('/')) {
          cursor = cursor.slice(0, cursor.lastIndexOf('/'));
          dirSizes.set(cursor, (dirSizes.get(cursor) || 0) + size);
          dirCounts.set(cursor, (dirCounts.get(cursor) || 0) + 1);
        }
        dirSizes.set('', (dirSizes.get('') || 0) + size);
        dirCounts.set('', (dirCounts.get('') || 0) + 1);
      }
    }
  }

  // ── 按分类汇总 ─────────────────────────────────────────────
  const byCat = new Map();
  for (const f of files) {
    const agg = byCat.get(f.c) || { bytes: 0, count: 0 };
    agg.bytes += f.s;
    agg.count += 1;
    byCat.set(f.c, agg);
  }

  const catalog = Object.values(CATEGORIES).map((meta) => {
    const agg = byCat.get(meta.id) || { bytes: 0, count: 0 };
    return { ...meta, bytes: agg.bytes, count: agg.count };
  });

  // categories：只保留实际有内容的，供清单渲染
  // catalog：完整字典，供前端按 id 反查任意分类的文案
  const categories = catalog.filter((c) => c.count > 0).sort((a, b) => b.bytes - a.bytes);

  // 会话库里仍存在的会话 id。只读、约 1ms，放在这里不会阻塞事件循环。
  // 库不存在或读取失败时，集合为 null：此时不判定孤儿，避免把所有会话都误标成孤儿。
  const liveSessions = await readLiveSessions(root);
  if (liveSessions) {
    for (const f of files) {
      if (f.sid) f.orphan = !liveSessions.has(f.sid);
    }
  }

  const totals = {
    bytes: dirSizes.get('') || 0,
    files: files.length,
    dirs,
  };

  return {
    root,
    // 给人看的那一份：家目录换成 ~。在服务端算，是因为只有服务端知道这台机器的家目录在哪，
    // 前端不该靠 /Users/<名字> 这种 macOS 形状去猜。
    rootShort: root.startsWith(os.homedir()) ? '~' + root.slice(os.homedir().length) : root,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    totals,
    categories,
    catalog,
    files,
    liveSessions: liveSessions ? liveSessions.size : null,
    problems,
  };
}

/**
 * 读出会话库里所有会话的 id。失败返回 null，由调用方决定如何处理（这里是"不判定孤儿"）。
 */
async function readLiveSessions(root) {
  const main = path.join(root, 'cli', 'db', 'db.sqlite');
  try { await fs.stat(main); } catch { return null; }
  let db;
  try {
    db = new DatabaseSync(main, { readOnly: true });
    return new Set(db.prepare('SELECT id FROM session').all().map((r) => r.id));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

/** 从相对路径里取出 sess_<id> 的 id。只认 cli/agents 与 cli/artifacts 下的会话目录。 */
export function sessionIdOf(rel) {
  // 目录名就是完整的会话 id（带 sess_ 前缀），与会话库 session.id 原样对应，不能截掉前缀。
  const m = /^cli\/(?:agents|artifacts)\/(sess_[^/]+)\//.exec(rel);
  return m ? m[1] : null;
}
