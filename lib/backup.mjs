/** 每次备份占一个独立目录；复制校验不过，写入就不会被授权。 */
import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function createBackupDirectory(base, label) {
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return fs.mkdtemp(path.join(base, `${stamp}-${label}-`));
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * 校验式复制：空文件、字面软链接都保真；套接字与设备文件直接拒绝。
 * 复制前后各取一次源文件的 inode/size/mtime，变了就说明备份内容不可信。
 */
export async function copyVerified(source, destination) {
  const before = await fs.lstat(source);
  if (before.isDirectory()) {
    await fs.mkdir(destination, { mode: 0o700 });
    const names = (await fs.readdir(source)).sort();
    for (const name of names) await copyVerified(path.join(source, name), path.join(destination, name));
    if (JSON.stringify(names) !== JSON.stringify((await fs.readdir(source)).sort())) {
      throw new Error(`备份期间目录发生变化：${source}`);
    }
  } else if (before.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), destination);
    if (await fs.readlink(source) !== await fs.readlink(destination)) throw new Error(`链接校验失败：${source}`);
  } else if (before.isFile()) {
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    const handle = await fs.open(destination, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    if (await digest(source) !== await digest(destination)) throw new Error(`内容校验失败：${source}`);
  } else {
    throw new Error(`不支持备份套接字或设备文件：${source}`);
  }
  const after = await fs.lstat(source);
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`备份期间源文件发生变化：${source}`);
  }
}

/** 主库必须备份；-wal/-shm 侧文件只有"本来就不存在"才允许跳过。 */
export async function backupDatabases(paths, base, label) {
  const dir = await createBackupDirectory(base, label);
  try {
    for (const source of paths) {
      for (const suffix of ['', '-wal', '-shm']) {
        const file = source + suffix;
        try {
          const stat = await fs.lstat(file);
          if (!stat.isFile()) throw new Error(`数据库及侧文件必须是普通文件：${file}`);
        }
        catch (err) { if (suffix && err.code === 'ENOENT') continue; throw err; }
        await copyVerified(file, path.join(dir, path.basename(file)));
      }
    }
    return dir;
  } catch (err) {
    throw new Error(`备份失败，未执行写入（未完成副本：${dir}）：${err.message}`, { cause: err });
  }
}
