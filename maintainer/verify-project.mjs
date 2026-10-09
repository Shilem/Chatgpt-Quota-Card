#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stageRelease } from './build-release.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'quota-release-test-'));
const staged = join(temporary, 'package');
function verify(expected, pattern, project = false) {
  const result = spawnSync(process.execPath, [join(ROOT, 'bin/verify-release.mjs'), staged, ...(project ? ['--project'] : [])], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, result.stdout + result.stderr);
  if (pattern) assert.match(result.stderr, pattern);
}
try {
  await stageRelease(staged);
  for (const name of ['.DS_Store', '.gitignore']) await writeFile(join(staged, name), 'local');
  for (const name of ['backups', '.codegraph', '.codex', '.projectmem']) await mkdir(join(staged, name));
  verify(0);
  await rm(join(staged, '.DS_Store'));
  await mkdir(join(staged, '.DS_Store'));
  verify(1, /必须是普通文件/);
  await rm(join(staged, '.DS_Store'), { recursive: true });
  await rm(join(staged, 'backups'), { recursive: true });
  await writeFile(join(staged, 'backups'), 'wrong type');
  verify(1, /必须是普通目录/);
  await rm(join(staged, 'backups'));
  await symlink(temporary, join(staged, 'backups'));
  verify(1, /符号链接/);
  await rm(join(staged, 'backups'));
  for (const name of ['bin/.DS_Store', 'unknown.txt']) {
    await writeFile(join(staged, name), 'unexpected');
    verify(1, /文件集合不匹配/);
    await rm(join(staged, name));
  }
  for (const name of ['.git', '.github', 'maintainer']) {
    await mkdir(join(staged, name));
    verify(1, /未知目录/);
    verify(0, null, true);
    await rm(join(staged, name), { recursive: true });
    await writeFile(join(staged, name), 'wrong type');
    verify(1, /必须是普通目录/, true);
    await rm(join(staged, name));
    await symlink(temporary, join(staged, name));
    verify(1, /符号链接/, true);
    await rm(join(staged, name));
  }
  await writeFile(join(staged, 'bin/verify-release.mjs'), 'tampered');
  verify(1, /哈希不一致/);
  console.log('发行回归通过：纯包、本地元数据、开发模式、类型、链接、嵌套、未知文件和篡改拒绝。');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
