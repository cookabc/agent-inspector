/**
 * 以只读方式打开一个 SQLite 库。
 *
 * 坑：WAL 模式的库在 -shm / -wal 不存在时**无法**以 mode=ro 打开（SQLite 要建 shm），
 * 而 Codex 的几个库正是这种状态。直接放弃会漏掉一半历史。
 * 所以这里先把库（连同存在的侧文件）复制到一个临时目录，再打开副本 ——
 * 原始文件始终只被 read，不建 shm、不加锁。
 *
 * 复制只用于统计（体积来自原文件的 stat，不来自副本）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SIDECARS = ['-wal', '-shm'];

/*
 * 每个模块实例（主线程 / 每个 worker 线程各一份）拥有自己的临时目录前缀。
 * 只用 process.pid 不够：worker_threads 共享 pid，而各自的模块级计数器
 * 都从 0 开始 —— 四个 worker 会同时写到同一个 agent-inspector-<pid>-0，
 * 互相覆盖副本；cleanupCopies 更会把别人正在用的副本一起删掉。
 */
const TMP_PREFIX = `agent-inspector-${process.pid}-${randomUUID().slice(0, 8)}-`;

let tmpSeq = 0;

/**
 * @returns {DatabaseSync|null} 打不开就返回 null，由调用方决定"不判定"还是"报错"
 */
export function openReadonly(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    const copied = copyAside(dbPath);
    if (!copied) return null;
    try {
      return new DatabaseSync(copied, { readOnly: true });
    } catch {
      return null;
    }
  }
}

/**
 * 同样只读打开，但打不开就抛 —— 用在"确实需要一份库、拿不到就该报错"的地方，
 * 这样调用方的 try/finally { db.close() } 不会因为 null 崩掉。
 */
export function openReadonlyOrThrow(dbPath) {
  const db = openReadonly(dbPath);
  if (!db) {
    const err = new Error(`打不开（只读）：${dbPath}`);
    err.statusCode = 500;
    throw err;
  }
  return db;
}

/** 把库和它的侧文件复制到临时目录，返回副本路径。 */
function copyAside(dbPath) {
  try {
    const dir = path.join(os.tmpdir(), `${TMP_PREFIX}${tmpSeq++}`);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(dbPath));
    fs.copyFileSync(dbPath, dest);
    for (const s of SIDECARS) {
      if (fs.existsSync(dbPath + s)) fs.copyFileSync(dbPath + s, dest + s);
    }
    return dest;
  } catch {
    return null;
  }
}

/**
 * 清理本模块实例留下的临时副本；worker 结束前调用。
 *
 * 只认自己的前缀：并发场景下（总览一次读四个 app）别的 worker 可能
 * 正靠着自己那份副本在跑，删到它就是把别人的库抽走。
 */
export async function cleanupCopies() {
  const base = os.tmpdir();
  let names;
  try { names = await fsp.readdir(base); } catch { return; }
  for (const n of names) {
    if (n.startsWith(TMP_PREFIX)) await fsp.rm(path.join(base, n), { recursive: true, force: true });
  }
}
