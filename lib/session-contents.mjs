/**
 * 「一条会话牵连了磁盘上的什么」—— 形状定义与汇总口径，一份，不是每家一份。
 *
 * 为什么要单独一个模块：
 * 1. 五种工具的级联范围差得极远（见 CONTENT_ROLES 的注释）。前端要按同一套
 *    形状分组展示，否则「所属内容」那块每个工具长得都不一样。
 * 2. dry-run 与真删必须读同一份计划。分开算的后果是"预览说 3 个文件、
 *    实际删 5 个"——那是这类工具里最伤人信任的一类 bug。
 * 3. 汇总（总字节、可删字节）的算法只该有一处，够测试钉住。
 *
 * 这个模块是叶子：只依赖 node:fs / node:path，不 import 任何适配器。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 空清单。各家的 sessionContents() 从这个形状出发往上加。
 *
 * files[].removable 是**这次会话级删除会不会带上它**，不是"这个文件在分类上
 * 是否受保护"。两者刻意分开：分页续段在文件清单里锁成「请勿删除」（单删会毁
 * 整条会话），但在"连整条会话一起删"的语境下它必须跟着走 —— 留一段残骸比
 * 全删更糟（恢复时会报 missing source rollout）。
 */
export function emptyContents() {
  return {
    dbRows: [],      // [{ db, table, count }]
    files: [],       // [{ rel, role, bytes, removable, count? }]
    blobs: null,     // { count, bytes } 仅 Cursor 这类内容寻址池
    notes: [],       // [{ text, tone }] tone ∈ info | warn
  };
}

/**
 * 加一条文件记录。**不同路径各占一条** —— 用户在「所属内容」里要能看见
 * 到底删哪些文件；把三个 rollout 段压成一行「3 段」虽然更短，但真出事时
 * 需要的是路径清单。
 *
 * 需要"同一角色的多条路径合并成一行展示"时用 mergeByRole()，
 * 那是**展示层**的压缩，不动数据。
 */
export function pushFile(contents, { rel, role, bytes = 0, removable = true, count = 1 }) {
  const entry = { rel, role, bytes, removable, count };
  contents.files.push(entry);
  return entry;
}

/**
 * 把一个目录下的所有文件算成**一条**（rel 是目录，count 是里面几个文件）。
 * 目录里散着几百个贴图时逐条列没有意义，一行「image-cache/ · 6 个 3.1 MB」
 * 才是有用的信息；而单个文件必须逐条，因为删错一个就是一个文件。
 */
export function addTree(contents, { root, rel, role, removable = true, problems = [] }) {
  const abs = path.join(root, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (st.isFile()) return pushFile(contents, { rel, role, bytes: st.size, removable });

  let bytes = 0;
  let count = 0;
  const stack = [abs];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch (err) { problems.push(`${rel}：${err.code || '读取失败'}`); continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      try { bytes += fs.statSync(p).size; count += 1; }
      catch (err) { problems.push(`${rel}：${err.code || '读取失败'}`); }
    }
  }
  if (!count) return null;
  return pushFile(contents, { rel, role, bytes, removable, count });
}

/** 可删的文件总量（会话级删除会带走的那些）。 */
export function removableBytes(contents) {
  if (!contents) return 0;
  const fromFiles = contents.files.filter((f) => f.removable).reduce((s, f) => s + (f.bytes || 0), 0);
  const fromBlobs = contents.blobs?.bytes || 0;
  return fromFiles + fromBlobs;
}

/** 库行总数 —— 抽屉里「数据库 N 张表 M 行」那个 M。 */
export function rowCount(contents) {
  if (!contents) return 0;
  return contents.dbRows.reduce((s, r) => s + (r.count || 0), 0);
}

/**
 * 有没有任何东西会被带走。空清单（例如只读工具算不出关联）不该让界面
 * 显示一个"0 项"的假清单 —— 那时应该整块不出现。
 */
export function hasAnything(contents) {
  if (!contents) return false;
  return contents.dbRows.length > 0
    || contents.files.some((f) => f.count > 0)
    || !!contents.blobs?.count;
}
