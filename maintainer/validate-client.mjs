#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, readdir, writeFile, open } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PATCHER = join(ROOT, 'bin/patch-codex-quota-card.mjs');
const FRAMEWORK = 'Contents/Frameworks/Codex Framework.framework/Versions/Current/Codex Framework';
export const OFFICIAL_REQUIREMENT = '=anchor apple generic and identifier "com.openai.codex" and certificate leaf[subject.OU] = "2DC432GLL2"';
export function assertAmfiLog(log) {
  if (/denied|disallow|restricted entitlement|invalid signature|constraint violation|failed fatally/i.test(log)) throw new Error('路径关联的 AMFI 日志包含拒绝或权限约束记录');
}
export function amfiQueryArguments(workspace, start, end) {
  const format = value => new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+0000');
  const predicate = `(process == "amfid" OR process == "kernel" OR process == "taskgated-helper") AND eventMessage CONTAINS ${JSON.stringify(workspace)}`;
  return ['show', '--style', 'json', '--start', format(start), '--end', format(end), '--predicate', predicate];
}
export function isWithin(parent, path) {
  const part = relative(parent, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../'));
}
export async function canonicalFuturePath(path) {
  let ancestor = resolve(path);
  const missing = [];
  for (;;) {
    try { return join(await realpath(ancestor), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}
export function parseOptions(args) {
  const options = { launch: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--launch' && !options.launch) { options.launch = true; continue; }
    const key = new Map([['--app', 'app'], ['--output', 'output']]).get(arg);
    if (!key || options[key] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`无效或重复参数：${arg}`);
    options[key] = args[++index];
  }
  if (!options.app || !options.output) throw new Error('用法：node maintainer/validate-client.mjs --app <官方.app> --output <项目外报告目录> [--launch]');
  return options;
}
export const AUTOMATED_STEP_NAMES = ['发行工具完整性', '官方身份', '隔离复制', '补丁前兼容', '应用补丁', '备份校验', '补丁后兼容与全部签名', '启动与 AMFI 观察', '恢复及恢复后签名', '源客户端未改变'];
export function summarize(report) {
  const failed = report.steps.some(step => step.status === 'failed');
  const complete = AUTOMATED_STEP_NAMES
    .every(name => report.steps.some(step => step.name === name && step.status === 'passed'));
  return {
    status: failed ? 'failed' : !report.finishedAt ? 'running' : complete ? 'automated-passed' : 'partial',
    manualAcceptanceRequired: true,
    releaseEligible: false,
  };
}
export function assertStatus(output, expected) {
  const statuses = [...output.matchAll(/^状态: (\S+)/gm)].map(match => match[1]);
  if (statuses.length !== 1 || statuses[0] !== expected) throw new Error(`状态应为 ${expected}，实际 ${statuses.join(', ') || '缺失'}`);
}
async function snapshot(app) {
  const result = {};
  for (const path of ['Contents/Resources/app.asar', 'Contents/Info.plist', FRAMEWORK]) {
    result[path] = createHash('sha256').update(await readFile(join(app, path))).digest('hex');
  }
  return result;
}

export async function validateClient(options) {
  if (process.platform !== 'darwin') throw new Error('隔离客户端验证仅支持 macOS');
  const source = await realpath(options.app);
  const destination = await canonicalFuturePath(options.output);
  for (const protectedPath of [ROOT, source, '/Applications', '/System', '/Library']) {
    if (isWithin(protectedPath, destination)) throw new Error('报告目录必须在项目、源客户端及系统应用目录之外');
  }
  await mkdir(destination, { recursive: true });
  const output = await realpath(destination);
  for (const protectedPath of [ROOT, source, '/Applications', '/System', '/Library']) {
    if (isWithin(protectedPath, output)) throw new Error('报告目录必须在项目、源客户端及系统应用目录之外');
  }
  const workspace = await mkdtemp(join(output, 'validation-'));
  const app = join(workspace, 'Client.app');
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), source, app,
    launchRequested: options.launch, steps: [],
    manualChecks: ['卡片位置与收起态', '真实账户额度、单位及刷新', '钥匙串与登录交互'],
  };
  const reportPath = join(workspace, 'report.json');
  async function save() {
    Object.assign(report, summarize(report));
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  async function step(name, operation) {
    const entry = { name, status: 'running' };
    report.steps.push(entry);
    try { entry.details = await operation(); entry.status = 'passed'; }
    catch (error) { entry.status = 'failed'; entry.error = error.message; throw error; }
    finally { await save(); }
  }
  async function command(label, executable, args) {
    const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    await writeFile(join(workspace, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''), { mode: 0o600 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label} 失败：exit=${result.status}, signal=${result.signal}; 详见 ${label}.log`);
    return (result.stdout ?? '') + (result.stderr ?? '');
  }
  const patch = (label, action, args = []) => command(label, process.execPath, [PATCHER, action, '--app', app, ...args]);
  let original;
  let copied = false;
  let backup;
  let failure;
  try {
    await step('发行工具完整性', () => command('release', process.execPath, [join(ROOT, 'bin/verify-release.mjs'), ROOT, '--project']));
    await step('官方身份', async () => {
      await command('official-signature', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', OFFICIAL_REQUIREMENT, source]);
      const plist = join(source, 'Contents/Info.plist');
      const bundle = (await command('bundle', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).trim();
      if (bundle !== 'com.openai.codex') throw new Error('Bundle ID 必须为 com.openai.codex');
      report.version = (await command('version', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).trim();
      report.build = (await command('build', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', plist])).trim();
      original = await snapshot(source);
      return { bundle, version: report.version, build: report.build, hashes: original };
    });
    await step('隔离复制', async () => {
      await command('copy', '/usr/bin/ditto', [source, app]);
      if (JSON.stringify(await snapshot(app)) !== JSON.stringify(original) || JSON.stringify(await snapshot(source)) !== JSON.stringify(original)) throw new Error('复制期间源客户端或副本发生变化');
      await command('copy-signature', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', OFFICIAL_REQUIREMENT, app]);
      copied = true;
    });
    await step('补丁前兼容', async () => assertStatus(await patch('before', 'check'), 'ready'));
    await step('应用补丁', async () => {
      assertStatus(await patch('apply', 'apply', ['--backup-root', join(workspace, 'backups')]), 'applied');
    });
    await step('备份校验', async () => {
      const entries = await readdir(join(workspace, 'backups'), { withFileTypes: true });
      if (entries.length !== 1 || !entries[0].isDirectory()) throw new Error('应用后必须恰好生成一份备份');
      backup = join(workspace, 'backups', entries[0].name);
      await patch('backup', 'validate-backup', ['--backup', backup]);
      return { backup };
    });
    await step('补丁后兼容与全部签名', async () => assertStatus(await patch('after', 'check'), 'already-patched'));
    if (options.launch) {
      await step('启动与 AMFI 观察', async () => {
        const name = (await command('executable', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents/Info.plist')])).trim();
        if (!name || basename(name) !== name || name === '..') throw new Error('主程序名称无效');
        const profile = join(workspace, 'profile');
        await mkdir(profile);
        const log = await open(join(workspace, 'startup.log'), 'w', 0o600);
        const started = new Date();
        const child = spawn(join(app, 'Contents/MacOS', name), [`--user-data-dir=${profile}`], { detached: true, stdio: ['ignore', log.fd, log.fd] });
        let launchError;
        let closed = false;
        const exited = new Promise(resolveExit => {
          child.once('error', error => { launchError = error; closed = true; resolveExit(); });
          child.once('close', () => { closed = true; resolveExit(); });
        });
        await log.close();
        try {
          await Promise.race([delay(25000), exited]);
          if (launchError) throw launchError;
          const logs = await readFile(join(workspace, 'startup.log'), 'utf8');
          report.launchObservation = { status: !closed && !/FATAL[:\s]/.test(logs) && logs.includes('Launching app') ? 'passed' : 'failed', pid: child.pid, startedAt: started.toISOString(), finishedAt: new Date().toISOString(), survivedSeconds: closed ? 0 : 25, startupSha256: createHash('sha256').update(logs).digest('hex'), startupBytes: Buffer.byteLength(logs) };
          await save();
          const amfi = await command('amfi', '/usr/bin/log', amfiQueryArguments(workspace, started, report.launchObservation.finishedAt));
          assertAmfiLog(amfi);
          if (closed) throw new Error(`隔离客户端提前退出：${child.exitCode}/${child.signalCode}`);
          if (/FATAL[:\s]/.test(logs) || !logs.includes('Launching app')) throw new Error('启动日志出现 FATAL 或缺少初始化标记');
          return { pid: child.pid, survivedSeconds: 25, profile, amfiObservation: '观察窗口内未发现路径关联拒绝，不代表完整运行验收' };
        } finally {
          if (child.pid) {
            try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            await Promise.race([exited, delay(5000)]);
            if (!closed) {
              try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
              await Promise.race([exited, delay(5000)]);
              if (!closed) throw new Error('隔离进程未结束，停止恢复');
            }
          }
        }
      });
    } else report.steps.push({ name: '启动与 AMFI 观察', status: 'skipped', reason: '未指定 --launch' });
  } catch (error) { failure = error; }
  finally {
    if (backup) {
      try {
        await step('恢复及恢复后签名', async () => {
          await patch('restore', 'restore', ['--backup', backup]);
          assertStatus(await patch('restored', 'check'), 'ready');
          const restored = await snapshot(app);
          if (restored['Contents/Resources/app.asar'] !== original['Contents/Resources/app.asar'] || restored['Contents/Info.plist'] !== original['Contents/Info.plist']) throw new Error('恢复内容与原始快照不一致');
          return { contentRestored: true, officialSignatureRestored: false };
        });
      } catch (error) { failure ??= error; }
    }
    if (copied) {
      try { await step('源客户端未改变', async () => {
        if (JSON.stringify(await snapshot(source)) !== JSON.stringify(original)) throw new Error('源客户端在验证期间发生变化，结果不可用于验收');
      }); } catch (error) { failure ??= error; }
    }
    report.finishedAt = new Date().toISOString();
    await save();
  }
  console.log(`验证报告：${reportPath}\n状态：${report.status}；仍需人工验收，禁止自动发布。`);
  if (failure) throw new Error(`${failure.message}\n报告：${reportPath}`);
  return { report, reportPath };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => validateClient(parseOptions(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
