#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, writeFile, rename, realpath, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { stageRelease } from './build-release.mjs';
import { monitorUI } from './monitor-ui.mjs';
import { MONITOR_FILES } from './verify-monitor-installer.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = join(homedir(), 'Library/Application Support/Chatgpt-Quota-Card/maintenance');
const LABEL = 'com.shilem.chatgpt-quota-card.maintenance';
const PLIST = join(homedir(), 'Library/LaunchAgents', LABEL + '.plist');
const DOMAIN = `gui/${process.getuid()}`;
const SERVICE = `${DOMAIN}/${LABEL}`;
function command(path, args) {
  const result = spawnSync(path, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path} ${args[0]} 失败：${result.stderr.trim()}`);
  return result.stdout.trim();
}
function installedService() {
  const result = spawnSync('/bin/launchctl', ['print', SERVICE], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 113 && /Could not find service/.test(result.stderr)) return null;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout;
}
function xml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function agentPlist(runtime, app) {
  const args = [process.execPath, join(runtime, 'maintainer/watch-client.mjs'), '--app', app, '--state-dir', join(BASE, 'state'), '--process', '--notify'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>3600</integer>
<key>ProcessType</key><string>Background</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>StandardOutPath</key><string>${xml(join(BASE, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(BASE, 'stderr.log'))}</string>
</dict></plist>\n`;
}
async function install(appPath, migration) {
  const existing = installedService();
  if (existing && /\n\s*pid = \d+/.test(existing)) throw new Error('后台验证正在运行，完成后再更新安装；不会终止验证');
  const app = await realpath(appPath);
  if (command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')]) !== 'com.openai.codex') throw new Error('请选择 Bundle ID 为 com.openai.codex 的完整客户端');
  await mkdir(BASE, { recursive: true, mode: 0o700 });
  if (await realpath(BASE) !== BASE) throw new Error('维护目录不能通过符号链接重定向');
  const stateDir = join(BASE, 'state');
  if (migration) {
    const source = await realpath(migration);
    try { await lstat(join(source, '.lock')); throw new Error('迁移源存在监控锁，确认任务完成后再迁移'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await lstat(stateDir); throw new Error('目标状态目录已存在，拒绝覆盖'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const state = JSON.parse(await readFile(join(source, 'state.json'), 'utf8'));
    if (state.schemaVersion !== 1 || !state.records || Object.values(state.records).some(r => r.status === 'running')) throw new Error('迁移状态无效或存在未结束任务');
    const staging = await mkdtemp(join(BASE, '.migration-'));
    command('/usr/bin/ditto', [source, join(staging, 'state')]);
    for (const record of Object.values(state.records)) {
      for (const key of ['job', 'reportPath']) if (record[key]) {
        if (!record[key].startsWith(source + '/')) throw new Error('迁移记录引用源目录之外的文件');
        record[key] = stateDir + record[key].slice(source.length);
      }
    }
    await writeFile(join(staging, 'state/state.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(join(staging, 'state'), stateDir);
    // 历史报告中的原始路径保留，state.json 的可访问索引迁到新位置；不删除迁移源。
  }
  const runtime = await mkdtemp(join(BASE, 'runtime-'));
  await stageRelease(runtime);
  await mkdir(join(runtime, 'maintainer'));
  for (const file of MONITOR_FILES) await cp(join(ROOT, 'maintainer', file), join(runtime, 'maintainer', file));
  command(process.execPath, [join(runtime, 'bin/verify-release.mjs'), runtime, '--project']);
  await mkdir(dirname(PLIST), { recursive: true });
  const temporary = join(BASE, 'agent.plist');
  await writeFile(temporary, agentPlist(runtime, app), { mode: 0o600 });
  command('/usr/bin/plutil', ['-lint', temporary]);
  if (existing) command('/bin/launchctl', ['bootout', SERVICE]);
  await rename(temporary, PLIST);
  await writeFile(join(BASE, 'installation.json'), JSON.stringify({ runtime, app, node: process.execPath, installedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  command('/bin/launchctl', ['enable', SERVICE]);
  command('/bin/launchctl', ['bootstrap', DOMAIN, PLIST]);
  const application = join(homedir(), 'Applications/额度卡片监控.app');
  await mkdir(dirname(application), { recursive: true });
  // 编译成本机双击入口，不把维护者路径或本机二进制放入用户发行包。
  const literal = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  const appleScript = `on run\ntry\ndo shell script (quoted form of ${literal(process.execPath)} & " " & quoted form of ${literal(join(runtime, 'maintainer/manage-monitor.mjs'))} & " gui")\non error errorMessage\ndisplay dialog errorMessage with title "额度卡片监控启动失败" buttons {"确定"}\nend try\nend run\n`;
  const scriptPath = join(BASE, 'monitor-launcher.applescript');
  await writeFile(scriptPath, appleScript, { mode: 0o600 });
  command('/usr/bin/osacompile', ['-o', application, scriptPath]);
  const applicationPlist = join(application, 'Contents/Info.plist');
  const metadata = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', applicationPlist]));
  command('/usr/libexec/PlistBuddy', ['-c', metadata.CFBundleIdentifier ? 'Set :CFBundleIdentifier com.shilem.chatgpt-quota-card.monitor' : 'Add :CFBundleIdentifier string com.shilem.chatgpt-quota-card.monitor', applicationPlist]);
  command('/usr/bin/codesign', ['--force', '--sign', '-', application]);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
  console.log(`已安装每小时检查；登录时启动。状态与日志：${BASE}`);
  console.log(`图形入口：${application}`);
}
async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('仅支持 macOS Apple Silicon');
  const [action, ...args] = process.argv.slice(2);
  if (action === 'setup' && !args.length) {
    const selected = command('/usr/bin/osascript', ['-e', 'try\nreturn POSIX path of (choose file of type {"com.apple.application-bundle"} with prompt "请选择要监控的 ChatGPT/Codex 客户端" default location (POSIX file "/Applications/"))\non error number -128\nreturn ""\nend try']);
    if (!selected) return;
    const confirmation = command('/usr/bin/osascript', ['-e', 'on run argv\nreturn button returned of (display dialog "安装后会在本用户登录时及每小时检查官方稳定清单，并下载到隔离目录验证补丁。不会修改或退出正式客户端。首次验证需要数 GB 空间，默认保留三次完整材料。\\n\\n所选客户端：" & (item 1 of argv) with title "安装额度卡片监控" buttons {"取消", "安装"} default button "安装")\nend run', selected]);
    if (confirmation === '取消') return;
    await install(selected);
    command('/usr/bin/osascript', ['-e', 'display dialog "安装完成。可从用户 Applications 目录双击“额度卡片监控”查看状态和管理后台任务。" with title "额度卡片监控" buttons {"完成"} default button "完成"']);
  } else if (action === 'install') {
    if (args.length !== 2 && args.length !== 4 || args[0] !== '--app' || args.length === 4 && args[2] !== '--migrate') throw new Error('用法：install --app <客户端.app> [--migrate <旧状态目录>]');
    await install(args[1], args[3]);
  } else if (action === 'gui' && !args.length) {
    await monitorUI({ base: BASE, manager: fileURLToPath(import.meta.url), getService: installedService, getDisabled: () => command('/bin/launchctl', ['print-disabled', DOMAIN]).split('\n').some(line => line.includes(`"${LABEL}"`) && line.includes('disabled')) });
  } else if (['status', 'enable', 'disable', 'notify-test'].includes(action) && !args.length) {
    if (action === 'status') {
      console.log(installedService() ?? '后台任务未加载');
      const disabled = command('/bin/launchctl', ['print-disabled', DOMAIN]).split('\n').find(line => line.includes(`"${LABEL}"`));
      console.log(disabled?.trim() ?? '未设置停用标记');
      console.log(`状态与日志：${BASE}`);
      try { console.log(await readFile(join(BASE, 'state/state.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; console.log('尚未生成状态记录'); }
    } else if (action === 'notify-test') {
      command('/usr/bin/osascript', ['-e', 'display notification "后台监控测试通知：每小时检查已配置。" with title "额度卡片维护"']);
      console.log('测试通知已提交；实际显示需在系统通知设置中验收');
    } else {
      await lstat(PLIST);
      const existing = installedService();
      if (action === 'disable') {
        if (existing && /\n\s*pid = \d+/.test(existing)) throw new Error('后台验证正在运行，完成后再停用；不会终止验证');
        command('/bin/launchctl', ['disable', SERVICE]);
        if (existing) command('/bin/launchctl', ['bootout', SERVICE]);
        console.log('已停用并卸载后台任务，保留状态和日志');
      } else {
        command('/bin/launchctl', ['enable', SERVICE]);
        if (!existing) command('/bin/launchctl', ['bootstrap', DOMAIN, PLIST]);
        console.log('已启用每小时及登录检查；重新加载时立即检查');
      }
    }
  } else throw new Error('用法：node maintainer/manage-monitor.mjs <install|gui|status|enable|disable|notify-test>');
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
