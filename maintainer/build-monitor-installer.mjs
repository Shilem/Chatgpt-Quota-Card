import { mkdir, mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stageRelease } from './build-release.mjs';
import { MONITOR_FILES, verifyMonitorInstaller } from './verify-monitor-installer.mjs';
import { canonicalFuturePath, isWithin } from './validate-client.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export async function buildMonitorInstaller(destination, purpose = 'developer') {
  if (process.platform !== 'darwin') throw new Error('图形安装器构建需要 macOS');
  if (!['developer', 'user'].includes(purpose)) throw new Error('未知安装器用途');
  const output = await canonicalFuturePath(destination);
  if (isWithin(ROOT, output)) throw new Error('安装器输出目录必须在项目之外');
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, '.monitor-installer-'));
  try {
    const appName = purpose === 'user' ? '额度卡片更新助手安装器.app' : '额度卡片监控安装器.app';
    const application = join(temporary, appName);
    execFileSync('/usr/bin/osacompile', ['-o', application, join(ROOT, purpose === 'user' ? 'maintainer/user-installer.applescript' : 'maintainer/installer.applescript')]);
    const resources = join(application, 'Contents/Resources');
    const payload = join(resources, 'payload');
    const release = await stageRelease(payload);
    await mkdir(join(payload, 'maintainer'));
    const tools = purpose === 'user' ? ['verify-monitor-installer.mjs'] : MONITOR_FILES;
    for (const file of tools) await cp(join(ROOT, 'maintainer', file), join(payload, 'maintainer', file));
    await cp(join(ROOT, 'maintainer/bootstrap-installer.zsh'), join(resources, 'bootstrap-installer.zsh'));
    const paths = [...release.files.map(f => f.path), 'release-manifest.json', ...tools.map(f => 'maintainer/' + f)];
    const files = [];
    for (const path of paths) { const bytes = await readFile(join(payload, path)); files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
    await writeFile(join(payload, 'monitor-manifest.json'), JSON.stringify({ schemaVersion: 1, purpose, files }, null, 2) + '\n');
    await verifyMonitorInstaller(payload);
    const plist = join(application, 'Contents/Info.plist');
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :CFBundleIdentifier string com.shilem.chatgpt-quota-card.${purpose}-installer`, plist]);
    const metadata = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    for (const [key, value] of Object.entries({ CFBundleShortVersionString: release.releaseVersion, CFBundleVersion: release.targetClient.build })) execFileSync('/usr/libexec/PlistBuddy', ['-c', `${metadata[key] ? 'Set :' + key : 'Add :' + key + ' string'} ${value}`, plist]);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', application]);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
    const name = `${purpose === 'user' ? 'quota-user-assistant' : 'quota-monitor'}-installer-${release.releaseVersion}-arm64.zip`;
    const archive = join(temporary, name);
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', '--noextattr', '--noqtn', application, archive]);
    const extracted = join(temporary, 'extracted');
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
    const extractedApp = join(extracted, appName);
    await verifyMonitorInstaller(join(extractedApp, 'Contents/Resources/payload'));
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', extractedApp]);
    const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
    await cp(archive, join(output, name), { force: false, errorOnExist: true });
    await writeFile(join(output, name + '.sha256'), `${hash}  ${name}\n`, { flag: 'wx' });
    console.log(`图形安装器候选包：${join(output, name)}\n仅本机临时签名，未公证，未发布。`);
    return join(output, name);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildMonitorInstaller(process.argv[2] ?? '', process.argv[3] ?? 'developer').catch(error => { console.error(error.message); process.exitCode = 1; });
