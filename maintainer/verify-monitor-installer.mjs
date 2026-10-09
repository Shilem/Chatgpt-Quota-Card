import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export const MONITOR_FILES = ['watch-client.mjs', 'validate-client.mjs', 'manage-monitor.mjs', 'build-release.mjs', 'monitor-ui.mjs', 'verify-monitor-installer.mjs'];
export const RELEASE_FILES = ['AGENTS.md', 'CLAUDE.md', 'NOTICE.md', 'README.md', '应用企业月额度卡片.command', '恢复额度卡片备份.command', 'bin/launcher-common.zsh', 'bin/patch-codex-quota-card.mjs', 'bin/verify-release.mjs', 'bin/user-assistant.mjs'];
export async function verifyMonitorInstaller(root) {
  const release = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'monitor-manifest.json'), 'utf8'));
  if (!Array.isArray(release.files) || JSON.stringify(release.files.map(f => f.path).sort()) !== JSON.stringify([...RELEASE_FILES].sort())) throw new Error('发行运行白名单不一致');
  const purpose = manifest.purpose ?? 'developer';
  if (!['developer', 'user'].includes(purpose)) throw new Error('未知安装器用途');
  const tools = purpose === 'user' ? ['verify-monitor-installer.mjs'] : MONITOR_FILES;
  const expected = [...release.files.map(f => f.path), 'release-manifest.json', ...tools.map(f => 'maintainer/' + f)].sort();
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || JSON.stringify(manifest.files.map(f => f.path).sort()) !== JSON.stringify(expected)) throw new Error('监控安装清单与运行白名单不一致');
  const allowedFiles = new Set([...expected, 'monitor-manifest.json']);
  const allowedDirectories = new Set(['bin', 'maintainer']);
  async function inspect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory() && allowedDirectories.has(path)) await inspect(join(directory, entry.name), path + '/');
      else if (!entry.isFile() || !allowedFiles.has(path)) throw new Error(`安装器包含未知条目或符号链接：${path}`);
    }
  }
  await inspect(root);
  for (const entry of manifest.files) {
    const path = join(root, entry.path);
    if (!(await lstat(path)).isFile()) throw new Error(`安装文件类型不正确：${entry.path}`);
    const bytes = await readFile(path);
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`安装文件完整性校验失败：${entry.path}`);
  }
  return manifest;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) { console.error('用法：verify-monitor-installer.mjs <payload>'); process.exitCode = 1; }
  else verifyMonitorInstaller(resolve(process.argv[2])).then(() => console.log('监控安装文件完整性通过')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
