import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = ['server.mjs'];
for (const base of ['lib', 'public', 'test', 'scripts']) {
  const pending = [base];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile() && /\.(mjs|js)$/.test(name)) files.push(name);
    }
  }
}
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const file of files.sort()) run(['--check', file]);
run(['--experimental-sqlite', '--test', ...files.filter(file => file.startsWith('test' + path.sep) && file.endsWith('.test.mjs')).sort()]);
