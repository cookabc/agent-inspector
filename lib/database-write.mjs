import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { backupDatabases } from './backup.mjs';

export function hasTable(db, name) {
  // Node 22.5 get() returns a null-filled object for an empty result.
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name)?.found === 1;
}

function checkDatabase(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]).join('; ');
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  if (integrity !== 'ok' || fkViolations) throw new Error(`数据库自检失败：${integrity}，外键违规 ${fkViolations} 处`);
  return { integrity, fkViolations };
}

/**
 * Lock every database before planning or copying. Run all SQL and checks before any commit.
 * Separate SQLite files cannot guarantee atomic commits across a power failure; errors disclose
 * committed files and the backup location rather than claiming a global rollback.
 */
export async function writeDatabases(paths, { backupDir, label, vacuum = true, root }, work) {
  if (!backupDir) throw new Error('未指定备份目录');
  if (root) {
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
    for (const { db } of opened) { try { db.exec('ROLLBACK'); } catch { /* Already committed or not begun. */ } }
    const state = committed.length ? `已提交：${committed.join('、')}。请退出应用后从备份恢复。` : '未提交的更改已回滚。';
    throw Object.assign(new Error(`${err.message}。${state}${backup ? `备份：${backup}` : ''}`, { cause: err }), {
      statusCode: err.statusCode || 500,
    });
  } finally {
    for (const { db } of opened) { try { db.close(); } catch { /* Preserve the original error. */ } }
  }
}
