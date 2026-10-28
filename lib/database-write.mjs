import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { backupDatabases } from './backup.mjs';

export function hasTable(db, name) {
  // Node 22.5 的 get() 对空结果返回一个字段全为 null 的对象，不能只判真假
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name)?.found === 1;
}

function checkDatabase(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]).join('; ');
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  if (integrity !== 'ok' || fkViolations) throw new Error(`数据库自检失败：${integrity}，外键违规 ${fkViolations} 处`);
  return { integrity, fkViolations };
}

/**
 * 写入的统一闸门：先给每个库拿写锁，SQL 与自检全部通过后才提交。
 *
 * `root` 是必填的：每个要写入的库都必须落在它之内，且路径上不许有符号链接、
 * 必须是普通文件。这道检查不是可选的加固 —— 少了它，一次路径计算错误就能
 * 让写入落到目标目录之外。所以没有"不传 root 就跳过校验"这条路。
 *
 * 多个独立的 SQLite 文件做不到跨文件原子提交 —— 提交阶段断电可能出现
 * "一个库已提交、另一个没有"。所以出错时不谎称全局回滚：错误信息里
 * 保留已提交的文件清单与备份位置，恢复以备份为准。
 */
export async function writeDatabases(paths, { backupDir, label, vacuum = true, root }, work) {
  if (!backupDir) throw new Error('未指定备份目录');
  if (!root) throw new Error('未指定写入根目录');
  {
    const base = fs.realpathSync(root);
    paths = paths.map(file => {
      const relative = path.relative(path.resolve(root), path.resolve(file));
      if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
        throw new Error('数据库路径越出目标目录');
      }
      let current = base;
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`数据库写入路径不能包含符号链接：${current}`);
      }
      if (!fs.lstatSync(current).isFile()) throw new Error(`数据库必须是普通文件：${current}`);
      // SQLite 打开连接和拿写锁时就可能访问侧文件，不能等到备份才校验。
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          if (!fs.lstatSync(current + suffix).isFile()) {
            throw new Error(`数据库侧文件必须是普通文件：${current + suffix}`);
          }
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
      return current;
    });
  }
  const opened = [];
  let backup;
  const committed = [];
  try {
    for (const file of paths) {
      const db = new DatabaseSync(file);
      opened.push({ file, db });
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('BEGIN IMMEDIATE');
      checkDatabase(db);
    }
    backup = await backupDatabases(paths, backupDir, label);
    for (const { db } of opened) db.exec('PRAGMA defer_foreign_keys = ON');
    const result = await work(opened.map(x => x.db));
    for (const { db } of opened) checkDatabase(db);
    for (const { file, db } of opened) {
      db.exec('COMMIT');
      committed.push(path.basename(file));
    }
    const integrity = [];
    for (const { file, db } of opened) {
      const start = Date.now();
      if (vacuum) db.exec('VACUUM');
      integrity.push({ name: path.basename(file), ...checkDatabase(db), vacuumMs: vacuum ? Date.now() - start : 0 });
    }
    return { result, backup, integrity };
  } catch (err) {
    for (const { db } of opened) { try { db.exec('ROLLBACK'); } catch { /* 已提交或尚未开事务。 */ } }
    const state = committed.length ? `已提交：${committed.join('、')}。请退出应用后从备份恢复。` : '未提交的更改已回滚。';
    throw Object.assign(new Error(`${err.message}。${state}${backup ? `备份：${backup}` : ''}`, { cause: err }), {
      statusCode: err.statusCode || 500,
    });
  } finally {
    for (const { db } of opened) { try { db.close(); } catch { /* 保住原本的错误。 */ } }
  }
}
