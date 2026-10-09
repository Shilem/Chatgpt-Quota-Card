import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MONITOR_FILES, RELEASE_FILES, verifyMonitorInstaller } from './verify-monitor-installer.mjs';

test('安装清单校验正常文件，拒绝维护程序篡改、未知内容、链接和发行路径注入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-installer-test-'));
  try {
    const paths = [...RELEASE_FILES, 'release-manifest.json', ...MONITOR_FILES.map(f => 'maintainer/' + f)], files = [];
    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      const bytes = Buffer.from(path === 'release-manifest.json' ? JSON.stringify({ files: RELEASE_FILES.map(path => ({ path })) }) : path);
      await writeFile(join(root, path), bytes);
      files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    await writeFile(join(root, 'monitor-manifest.json'), JSON.stringify({ schemaVersion: 1, files }));
    await verifyMonitorInstaller(root);
    await writeFile(join(root, 'maintainer/watch-client.mjs'), 'tampered');
    await assert.rejects(verifyMonitorInstaller(root), /完整性校验失败/);
    await writeFile(join(root, 'maintainer/watch-client.mjs'), 'maintainer/watch-client.mjs');
    await writeFile(join(root, 'extra'), 'unknown');
    await assert.rejects(verifyMonitorInstaller(root), /未知条目/);
    await rm(join(root, 'extra')); await symlink(join(root, 'README.md'), join(root, 'extra'));
    await assert.rejects(verifyMonitorInstaller(root), /符号链接/);
    await rm(join(root, 'extra'));
    await writeFile(join(root, 'release-manifest.json'), JSON.stringify({ files: [{ path: '../../outside' }] }));
    await assert.rejects(verifyMonitorInstaller(root), /白名单不一致/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('通过目录别名执行安装校验CLI必须实际执行，缺少清单退出失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-installer-cli-'));
  try {
    await symlink(dirname(fileURLToPath(import.meta.url)), join(root, 'alias'));
    const result = spawnSync(process.execPath, [join(root, 'alias/verify-monitor-installer.mjs'), root], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release-manifest.json/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
