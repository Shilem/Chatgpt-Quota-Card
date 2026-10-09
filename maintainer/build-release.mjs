#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifyMonitorInstaller } from './verify-monitor-installer.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export async function stageRelease(destination) {
  let installer = false;
  try { await lstat(join(ROOT, 'monitor-manifest.json')); installer = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (installer) await verifyMonitorInstaller(ROOT);
  else execFileSync(process.execPath, [join(ROOT, 'bin/verify-release.mjs'), ROOT, '--project'], { stdio: 'inherit' });
  const manifest = JSON.parse(await readFile(join(ROOT, 'release-manifest.json'), 'utf8'));
  await mkdir(destination, { recursive: true });
  for (const entry of [...manifest.files, { path: 'release-manifest.json' }]) {
    await mkdir(dirname(join(destination, entry.path)), { recursive: true });
    await cp(join(ROOT, entry.path), join(destination, entry.path));
  }
  execFileSync(process.execPath, [join(ROOT, 'bin/verify-release.mjs'), destination], { stdio: 'inherit' });
  return manifest;
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('发行打包和解压验证需要 macOS ditto');
  if (process.argv.length !== 3) throw new Error('用法：node maintainer/build-release.mjs <项目之外的输出目录>');
  const output = resolve(process.argv[2]);
  const pathFromRoot = relative(ROOT, output);
  if (!pathFromRoot || (!pathFromRoot.startsWith('..' + '/') && !isAbsolute(pathFromRoot))) throw new Error('输出目录必须在项目之外');
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, '.candidate-'));
  try {
    const staged = join(temporary, 'package');
    const manifest = await stageRelease(staged);
    const name = `codex-quota-card-patcher-${manifest.releaseVersion}.zip`;
    const archive = join(temporary, name);
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', staged, archive]);
    const extracted = join(temporary, 'extracted');
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
    execFileSync(process.execPath, [join(ROOT, 'bin/verify-release.mjs'), extracted], { stdio: 'inherit' });
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    await cp(archive, join(output, name), { errorOnExist: true, force: false });
    await writeFile(join(output, name + '.sha256'), `${digest}  ${name}\n`, { flag: 'wx' });
    console.log(`候选发行包：${join(output, name)}\n尚未证明客户端兼容，未发布。`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
