#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile, rename, rm, stat, lstat, readdir, realpath, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = join(homedir(), 'Library/Application Support/Chatgpt-Quota-Card/user-assistant');
const LABEL = 'com.shilem.chatgpt-quota-card.user-assistant';
const SERVICE = `gui/${process.getuid()}/${LABEL}`;
const PLIST = join(homedir(), 'Library/LaunchAgents', LABEL + '.plist');
const GITHUB_REPOSITORY = 'Shilem/Chatgpt-Quota-Card';
const RELEASES_PAGE = `https://github.com/${GITHUB_REPOSITORY}/releases`;
const RELEASE_FILES = ['AGENTS.md', 'CLAUDE.md', 'NOTICE.md', 'README.md', '应用企业月额度卡片.command', '恢复额度卡片备份.command', 'bin/launcher-common.zsh', 'bin/patch-codex-quota-card.mjs', 'bin/verify-release.mjs', 'bin/user-assistant.mjs'].sort();
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const DISPATCHER_SOURCE = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const configuration = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
for (const args of [[join(configuration.runtime, 'bin/verify-release.mjs'), configuration.runtime], [join(configuration.runtime, 'bin/user-assistant.mjs'), process.argv[2]]]) {
 const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
 if (result.error) throw result.error;
 if (result.status !== 0) process.exit(result.status ?? 1);
}
`;
export function compareReleaseVersions(left, right) {
  const parse = value => { const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value); if (!match) throw new Error('稳定补丁版本必须为官方客户端三段数字版本'); return match.slice(1).map(BigInt); };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export function inspectGithubRelease(release, localVersion) {
  if (release.draft !== false || release.prerelease !== false) throw new Error('GitHub 返回的不是已发布稳定 Release');
  const comparison = compareReleaseVersions(release.tag_name, localVersion);
  const url = `https://github.com/${GITHUB_REPOSITORY}/releases/tag/${encodeURIComponent(release.tag_name)}`;
  if (release.html_url !== url) throw new Error('Release 地址与项目及版本不一致');
  if (!Array.isArray(release.assets)) throw new Error('Release 缺少资产列表');
  let downloads;
  if (comparison >= 0) {
    const archive = `codex-quota-card-patcher-${release.tag_name}.zip`;
    downloads = [];
    for (const name of [archive, archive + '.sha256']) {
      const assets = release.assets.filter(asset => asset.name === name);
      if (assets.length !== 1 || !Number.isSafeInteger(assets[0].id) || assets[0].id <= 0 || !Number.isSafeInteger(assets[0].size) || assets[0].size <= 0 || assets[0].size > (name === archive ? MAX_ARCHIVE_BYTES : 4096) || assets[0].browser_download_url !== `https://github.com/${GITHUB_REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${name}`) throw new Error('稳定 Release 缺少唯一有效的纯发行 ZIP 或 SHA-256 资产');
      downloads.push({ id: assets[0].id, name, size: assets[0].size, url: assets[0].browser_download_url });
    }
  }
  return { status: comparison > 0 ? 'update-available' : 'up-to-date', localVersion, latestVersion: release.tag_name, url, ...(downloads ? { downloads } : {}) };
}
export async function checkGithubRelease(localVersion, request) {
  try {
    compareReleaseVersions(localVersion, localVersion);
    const repository = await request(`repos/${GITHUB_REPOSITORY}`);
    if (repository.status === 404) return { status: 'unavailable', localVersion, error: '仓库不可访问。私有仓库需要本机 GitHub 登录权限', url: RELEASES_PAGE };
    if (repository.status !== 200) throw new Error(`GitHub 仓库请求失败：HTTP ${repository.status}`);
    if (repository.data.full_name !== GITHUB_REPOSITORY) throw new Error('GitHub 仓库身份不一致');
    const response = await request(`repos/${GITHUB_REPOSITORY}/releases/latest`);
    if (response.status === 404) return { status: 'no-release', localVersion, url: RELEASES_PAGE };
    if (response.status !== 200) throw new Error(`GitHub 稳定发行请求失败：HTTP ${response.status}`);
    return inspectGithubRelease(response.data, localVersion);
  } catch (error) { return { status: 'failed', localVersion, error: error.message, url: RELEASES_PAGE }; }
}
export function githubMessage(result) {
  const statuses = {
    'update-available': `GitHub 有新版补丁 ${result.latestVersion}（本机 ${result.localVersion}），等待助手自动更新；此时不应用旧补丁。`,
    'up-to-date': `GitHub 检查通过，本机补丁 ${result.localVersion} 无需升级。客户端兼容性仍需单独检查。`,
    'no-release': `GitHub 仓库可访问，但尚无稳定 Release；可在明确确认后检查本机 ${result.localVersion} 补丁。`,
    unavailable: `GitHub 最新版未知：${result.error}`,
    failed: `GitHub 最新版检查失败：${result.error}`,
  };
  if (!statuses[result.status]) throw new Error('未知 GitHub 更新状态');
  return statuses[result.status];
}
export function assertGithubReady(result) {
  if (!['up-to-date', 'no-release'].includes(result.status)) throw new Error(githubMessage(result));
}
export async function githubRequest(endpoint, authentication, binary = false) {
  if (authentication === 'gh') {
    let executable;
    for (const candidate of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
      try { if ((await stat(candidate)).isFile()) { executable = candidate; break; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!executable) throw new Error('未找到 GitHub CLI；请安装并登录 gh，或改用匿名检查');
    const result = spawnSync(executable, ['api', '--hostname', 'github.com', ...(binary ? ['-H', 'Accept: application/octet-stream'] : []), endpoint], { encoding: binary ? undefined : 'utf8', timeout: binary ? 60000 : 30000, maxBuffer: binary ? MAX_ARCHIVE_BYTES : 2 * 1024 * 1024 });
    if (result.error) throw new Error('本机 GitHub CLI 请求失败或超时');
    if (result.status !== 0) {
      const match = /\(HTTP (\d{3})\)/.exec(result.stderr.toString());
      if (match) return { status: Number(match[1]) };
      throw new Error('本机 GitHub CLI 未登录或请求失败，请在终端完成 gh auth login');
    }
    return { status: 200, data: binary ? result.stdout : JSON.parse(result.stdout) };
  }
  if (authentication && authentication !== 'anonymous') throw new Error('未知 GitHub 访问方式');
  const response = await fetch(`https://api.github.com/${endpoint}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (response.status !== 200) { await response.body?.cancel(); return { status: response.status }; }
  let bytes = 0, text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('GitHub 更新响应过大'); text += decoder.decode(chunk, { stream: true }); }
  text += decoder.decode();
  return { status: 200, data: JSON.parse(text) };
}
async function downloadAsset(asset, authentication) {
  if (authentication === 'gh') {
    const response = await githubRequest(`repos/${GITHUB_REPOSITORY}/releases/assets/${asset.id}`, authentication, true);
    if (response.status !== 200) throw new Error(`GitHub 资产下载失败：HTTP ${response.status}`);
    if (response.data.length !== asset.size) throw new Error('GitHub 资产大小与 Release 不一致');
    return response.data;
  }
  let url = asset.url;
  const signal = AbortSignal.timeout(120000);
  for (let i = 0; i < 4; i++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error('GitHub 资产重定向地址不受支持');
    const response = await fetch(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get('location'); await response.body?.cancel(); if (!location) throw new Error('GitHub 下载重定向缺少地址'); url = new URL(location, url).href; continue; }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`GitHub 资产下载失败：HTTP ${response.status}`); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > asset.size) throw new Error('GitHub 资产超出声明大小'); chunks.push(chunk); }
    if (size !== asset.size) throw new Error('GitHub 资产下载不完整');
    return Buffer.concat(chunks);
  }
  throw new Error('GitHub 下载重定向次数过多');
}
export function parseArchiveChecksum(checksum, name) {
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\n?$/.exec(checksum.toString('utf8'));
  if (!match || match[2] !== name) throw new Error('更新 ZIP 的 SHA-256 文件名或格式无效');
  return match[1];
}
export function assertArchiveChecksum(archive, checksum, name) {
  if (createHash('sha256').update(archive).digest('hex') !== parseArchiveChecksum(checksum, name)) throw new Error('更新 ZIP 的 SHA-256 校验失败');
}
export function assertRevisionProgress(local, incoming, hasArchiveBaseline) {
  if (!Number.isSafeInteger(incoming.releaseRevision) || incoming.releaseRevision < 1) throw new Error('更新包内部修订号无效');
  if (compareReleaseVersions(incoming.releaseVersion, local.releaseVersion) === 0 && (incoming.releaseRevision < local.releaseRevision || (hasArchiveBaseline && incoming.releaseRevision === local.releaseRevision))) throw new Error('同一官方版本的更新包必须递增内部修订号，拒绝回退或无修订变更');
}
export async function validateRuntime(root, version) {
  const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'));
  if (manifest.releaseVersion !== version || !Array.isArray(manifest.files) || JSON.stringify(manifest.files.map(entry => entry.path).sort()) !== JSON.stringify(RELEASE_FILES)) throw new Error('更新运行包版本或文件白名单不匹配');
  const actual = [];
  const visit = async (directory, prefix = '') => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), relative = prefix + name, info = await lstat(path);
      if (info.isDirectory() && relative === 'bin') await visit(path, 'bin/');
      else if (info.isFile()) actual.push(relative);
      else throw new Error('更新运行包包含非普通文件或未知目录');
    }
  };
  await visit(root);
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...RELEASE_FILES, 'release-manifest.json'].sort())) throw new Error('更新运行包包含额外内容或缺少文件');
  let total = 0;
  for (const entry of manifest.files) {
    const path = join(root, entry.path), info = await lstat(path);
    total += info.size;
    if (total > MAX_ARCHIVE_BYTES || !Number.isSafeInteger(entry.size) || entry.size !== info.size) throw new Error('更新运行包文件大小无效');
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`更新运行包哈希不匹配：${entry.path}`);
    if (entry.path.endsWith('.command') && !(info.mode & 0o111)) throw new Error('更新双击入口缺少执行权限');
  }
}
export async function stageRuntimeUpdate(base, release, download) {
  const directory = await mkdtemp(join(base, 'update-'));
  try {
    const [asset, checksumAsset] = release.downloads;
    const checksum = await download(checksumAsset), archive = await download(asset);
    assertArchiveChecksum(archive, checksum, asset.name);
    const zip = join(directory, 'release.zip'); await writeFile(zip, archive, { mode: 0o600 });
    // 使用同一个libarchive读取及解压，避免Info-ZIP对UTF-8中文文件名的有损显示。
    const entries = run('/usr/bin/tar', ['-tf', zip]).split('\n');
    const allowed = new Set([...RELEASE_FILES, 'release-manifest.json', 'bin/']);
    if (new Set(entries).size !== entries.length || entries.some(entry => !allowed.has(entry))) throw new Error('更新 ZIP 包含重复、未知或不安全路径');
    const types = run('/usr/bin/tar', ['-tvf', zip]).split('\n').map(line => /^([d-])[rwxstST-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s/.exec(line));
    if (types.length !== entries.length || types.some((match, i) => !match || (match[1] === 'd' && entries[i] !== 'bin/'))) throw new Error('更新 ZIP 包含符号链接或不受支持的条目类型');
    if (types.reduce((total, match) => total + Number(match[2]), 0) > MAX_ARCHIVE_BYTES) throw new Error('更新 ZIP 解压大小无效');
    const runtime = join(directory, 'runtime');
    await mkdir(runtime); run('/usr/bin/tar', ['-xf', zip, '-C', runtime]);
    await validateRuntime(runtime, release.latestVersion);
    run(process.execPath, [join(runtime, 'bin/verify-release.mjs'), runtime]);
    run(process.execPath, ['--check', join(runtime, 'bin/user-assistant.mjs')]);
    run(process.execPath, ['--input-type=module', '-e', 'const path = process.argv.pop(); process.argv = [process.execPath]; await import(path);', join(runtime, 'bin/user-assistant.mjs')]);
    const installed = join(base, 'runtime-' + randomUUID()); await rename(runtime, installed);
    return installed;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function switchRuntime(configurationPath, settings, runtime, archiveHash) {
  const current = JSON.parse(await readFile(configurationPath, 'utf8'));
  if (JSON.stringify(current) !== JSON.stringify(settings)) throw new Error('助手配置已变化，拒绝覆盖');
  await save(configurationPath, { ...settings, runtime, ...(archiveHash ? { runtimeArchiveSha256: archiveHash } : {}) });
}
async function ensureGithubCurrent(state, settings) {
  const release = await refreshGithub(state, settings);
  if (!release.downloads) return release;
  let runtime, archiveHash;
  try {
    const checksum = await downloadAsset(release.downloads[1], settings.githubAuth);
    archiveHash = parseArchiveChecksum(checksum, release.downloads[0].name);
    if (release.status === 'up-to-date' && settings.runtimeArchiveSha256 === archiveHash) return release;
    runtime = await stageRuntimeUpdate(BASE, release, asset => asset === release.downloads[1] ? checksum : downloadAsset(asset, settings.githubAuth));
    const local = JSON.parse(await readFile(join(ROOT, 'release-manifest.json'), 'utf8'));
    const incoming = JSON.parse(await readFile(join(runtime, 'release-manifest.json'), 'utf8'));
    assertRevisionProgress(local, incoming, Boolean(settings.runtimeArchiveSha256));
    await switchRuntime(join(BASE, 'config.json'), settings, runtime, archiveHash);
    state.lastAssistantUpdate = { from: release.localVersion, to: release.latestVersion, revision: incoming.releaseRevision, at: Date.now() };
  } catch (error) {
    if (runtime) await rm(runtime, { recursive: true, force: true });
    state.github = { ...release, status: 'failed', error: `助手热更新失败，仍保留旧版：${error.message}` };
    await save(join(BASE, 'state.json'), state);
    return state.github;
  }
  state.github = { ...release, status: 'up-to-date', localVersion: release.latestVersion, checkedAt: Date.now() };
  delete state.github.downloads;
  await save(join(BASE, 'state.json'), state);
  console.log(`助手已自动更新：${release.localVersion} → ${release.latestVersion}；未修改客户端`);
  return state.github;
}
async function refreshGithub(state, settings) {
  const manifest = JSON.parse(await readFile(join(ROOT, 'release-manifest.json'), 'utf8'));
  const result = await checkGithubRelease(manifest.releaseVersion, endpoint => githubRequest(endpoint, settings.githubAuth));
  state.github = { ...result, checkedAt: Date.now() };
  await save(join(BASE, 'state.json'), state);
  return state.github;
}
function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${file} 退出 ${result.status}`);
  return result.stdout.trim();
}
function script(source, args = []) { return run('/usr/bin/osascript', ['-e', source, ...args]); }
function dialog(text) { return script('on run argv\ndisplay dialog (item 1 of argv) with title "额度卡片更新助手" buttons {"确定"} default button "确定"\nend run', [text]); }
async function save(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
async function loadState() {
  try {
    const state = JSON.parse(await readFile(join(BASE, 'state.json'), 'utf8'));
    if (state.schemaVersion !== 1) throw new Error('用户助手状态损坏，拒绝重置');
    return state;
  } catch (error) { if (error.code !== 'ENOENT') throw error; return { schemaVersion: 1 }; }
}
export function observeUpdate(state, snapshot, now) {
  const next = { ...state, checkedAt: now };
  if (!state.baseline) { next.baseline = snapshot; return { state: next, notify: false }; }
  if (snapshot.key === state.baseline.key) { delete next.pending; return { state: next, notify: false }; }
  if (state.pending?.snapshot.key !== snapshot.key) { next.pending = { snapshot, since: now }; return { state: next, notify: false }; }
  const notify = now - state.pending.since >= 60000 && state.reminded !== snapshot.key;
  if (notify) next.reminded = snapshot.key;
  return { state: next, notify };
}
export function parseStatus(text) {
  const matches = [...text.matchAll(/^状态: ([a-z-]+)(?:（[^\n]*）)?$/gm)];
  if (matches.length !== 1) throw new Error('补丁工具没有返回唯一状态');
  return matches[0][1];
}
export async function applyWithConsent(hooks) {
  const before = await hooks.snapshot();
  const status = await hooks.check();
  if (status === 'already-patched') return 'already-patched';
  if (!['ready', 'upgrade-ready'].includes(status)) throw new Error('当前客户端不能安全应用补丁');
  if (!await hooks.approve(before)) return 'cancelled';
  const assertSame = async () => { if ((await hooks.snapshot()).key !== before.key) throw new Error('客户端正在更新或内容已变化，请稍后重试'); };
  await assertSame();
  await hooks.quit();
  await assertSame();
  if (!['ready', 'upgrade-ready'].includes(await hooks.check())) throw new Error('退出后的兼容检查未通过');
  if (await hooks.apply() !== 'applied') throw new Error('补丁没有返回 applied，不会自动启动');
  if (await hooks.check() !== 'already-patched') throw new Error('补丁后复查未通过，不会自动启动');
  const after = await hooks.snapshot();
  if (after.version !== before.version || after.build !== before.build) throw new Error('操作期间客户端版本变化，不会自动启动');
  await hooks.start();
  return 'applied';
}
async function snapshot(app) {
  const plist = join(app, 'Contents/Info.plist');
  if (run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]) !== 'com.openai.codex') throw new Error('所选客户端身份不正确');
  const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
  const build = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', plist]);
  const asar = await stat(join(app, 'Contents/Resources/app.asar'), { bigint: true });
  const key = createHash('sha256').update(await readFile(plist)).update([asar.dev, asar.ino, asar.size, asar.mtimeNs].join(':')).digest('hex');
  return { version, build, key };
}
async function config() { return JSON.parse(await readFile(join(BASE, 'config.json'), 'utf8')); }
async function locked(operation) {
  await mkdir(BASE, { recursive: true, mode: 0o700 });
  if (await realpath(BASE) !== BASE) throw new Error('助手目录不能通过符号链接重定向');
  const lock = join(BASE, '.lock');
  try { await mkdir(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('已有检查或补丁任务运行；如异常退出，请确认旧进程结束后再清理锁'); throw error; }
  try { await save(join(lock, 'owner.json'), { pid: process.pid, startedAt: Date.now() }); return await operation(); }
  finally { await rm(lock, { recursive: true }); }
}
export function shouldCheckGithub(state, now, force = false) {
  return force || Boolean(state.pending && now - state.pending.since >= 60000 && (!state.github || now - state.github.checkedAt >= 3600000));
}
async function checkUpdate(forceGithub = false) {
  return locked(async () => {
    const settings = await config(); const { app, runtime } = settings;
    if (runtime !== ROOT) throw new Error('助手已升级，请关闭旧窗口并重新打开');
    const observation = observeUpdate(await loadState(), await snapshot(app), Date.now());
    await save(join(BASE, 'state.json'), observation.state);
    const previous = observation.state.github;
    let changed = false;
    if (observation.notify || shouldCheckGithub(observation.state, Date.now(), forceGithub)) {
      const github = await ensureGithubCurrent(observation.state, settings);
      changed = Boolean(previous && (previous.status !== github.status || previous.latestVersion !== github.latestVersion));
    }
    if (observation.notify || (changed && observation.state.pending && Date.now() - observation.state.pending.since >= 60000)) {
      // 先查询GitHub，再提醒；访问失败不伪装成“已是最新版”。
      const github = observation.state.github;
      const result = spawnSync('/usr/bin/osascript', ['-e', 'on run argv\ndisplay notification (item 1 of argv) with title "额度卡片更新助手"\nend run', `检测到本机客户端 ${observation.state.pending.snapshot.version} 更新。${githubMessage(github)} 请打开更新助手。`], { encoding: 'utf8' });
      if (result.error || result.status !== 0) {
        observation.state.notificationError = result.error?.message ?? result.stderr.trim();
        delete observation.state.reminded;
        await save(join(BASE, 'state.json'), observation.state);
        throw new Error(`更新提醒提交失败：${observation.state.notificationError}`);
      }
      console.log('已提醒本机客户端内容变化；未退出或修改客户端');
    }
    return observation.state;
  });
}
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const appleLiteral = text => '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
async function install(app) {
  app = await realpath(app);
  const baseline = await snapshot(app);
  await locked(async () => {
    // 项目目录或安装器payload均先通过所属完整性门，再复制成严格的纯发行运行副本。
    try { await stat(join(ROOT, 'monitor-manifest.json')); run(process.execPath, [join(ROOT, 'maintainer/verify-monitor-installer.mjs'), ROOT]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; run(process.execPath, [join(ROOT, 'bin/verify-release.mjs'), ROOT, '--project']); }
    const runtime = await mkdtemp(join(BASE, 'runtime-'));
    const manifest = JSON.parse(await readFile(join(ROOT, 'release-manifest.json'), 'utf8'));
    for (const entry of [...manifest.files, { path: 'release-manifest.json' }]) {
      await mkdir(dirname(join(runtime, entry.path)), { recursive: true });
      await cp(join(ROOT, entry.path), join(runtime, entry.path));
    }
    run(process.execPath, [join(runtime, 'bin/verify-release.mjs'), runtime]);
    const application = join(homedir(), 'Applications/额度卡片更新助手.app');
    await mkdir(dirname(application), { recursive: true });
    // 图形入口与后台服务始终从原子配置读取当前runtime，热更新无需重装.app或服务。
    const dispatcher = join(BASE, 'dispatch.mjs');
    await writeFile(dispatcher, DISPATCHER_SOURCE, { mode: 0o600 });
    const launcher = join(BASE, 'launcher.applescript');
    await writeFile(launcher, `on run\ntry\ndo shell script (quoted form of ${appleLiteral(process.execPath)} & " " & quoted form of ${appleLiteral(dispatcher)} & " ui")\non error errorMessage\ndisplay dialog errorMessage with title "额度卡片更新助手" buttons {"确定"}\nend try\nend run\n`, { mode: 0o600 });
    run('/usr/bin/osacompile', ['-o', application, launcher]);
    const applicationPlist = join(application, 'Contents/Info.plist');
    const metadata = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', applicationPlist]));
    run('/usr/libexec/PlistBuddy', ['-c', `${metadata.CFBundleIdentifier ? 'Set :CFBundleIdentifier' : 'Add :CFBundleIdentifier string'} com.shilem.chatgpt-quota-card.user-ui`, applicationPlist]);
    for (const [key, value] of Object.entries({ CFBundleShortVersionString: manifest.releaseVersion, CFBundleVersion: manifest.targetClient.build })) run('/usr/libexec/PlistBuddy', ['-c', `${metadata[key] ? 'Set :' + key : 'Add :' + key + ' string'} ${value}`, applicationPlist]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
    const args = [process.execPath, dispatcher, 'watch'];
    const agent = `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${args.map(x => `<string>${xml(x)}</string>`).join('')}</array><key>StartInterval</key><integer>300</integer><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${xml(join(BASE, 'stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(join(BASE, 'stderr.log'))}</string></dict></plist>`;
    const temporary = join(BASE, 'agent.plist'); await writeFile(temporary, agent, { mode: 0o600 });
    run('/usr/bin/plutil', ['-lint', temporary]);
    const existing = spawnSync('/bin/launchctl', ['print', SERVICE], { encoding: 'utf8' });
    if (existing.error) throw existing.error;
    if (existing.status === 0) run('/bin/launchctl', ['bootout', SERVICE]);
    else if (existing.status !== 113) throw new Error(existing.stderr.trim());
    await mkdir(dirname(PLIST), { recursive: true }); await rename(temporary, PLIST);
    let authentication = 'anonymous';
    try { authentication = (await config()).githubAuth ?? 'anonymous'; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await save(join(BASE, 'config.json'), { app, runtime, githubAuth: authentication });
    const state = await loadState();
    if (!state.baseline) state.baseline = baseline;
    await save(join(BASE, 'state.json'), state);
    run('/bin/launchctl', ['enable', SERVICE]);
    // bootstrap 在释放锁后执行，避免登录立即检查与安装互斥锁冲突。
  });
  run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST]);
  dialog('用户助手安装完成。每5分钟检查本机客户端变化。\n请从用户 Applications 打开“额度卡片更新助手”。\n首次未应用卡片时可选择“应用补丁”。');
}
async function worker() {
  const handoff = await locked(async () => {
    run(process.execPath, [join(ROOT, 'bin/verify-release.mjs'), ROOT]);
    const settings = await config(); const { app, runtime } = settings;
    if (runtime !== ROOT) throw new Error('助手已升级，请关闭旧窗口并重新打开');
    const github = await ensureGithubCurrent(await loadState(), settings);
    console.log(githubMessage(github));
    assertGithubReady(github);
    const updated = await config();
    if (updated.runtime !== ROOT) return updated.runtime;
    const core = async action => {
      await appendFile(join(BASE, 'operations.log'), `\n${new Date().toISOString()} ${action}\n`, { mode: 0o600 });
      const result = run(process.execPath, [join(ROOT, 'bin/patch-codex-quota-card.mjs'), action, '--app', app, ...(action === 'check' || action === 'apply' ? ['--allow-updated-signature'] : []), ...(action === 'apply' ? ['--backup-root', join(BASE, 'backups')] : [])]);
      console.log(result);
      await appendFile(join(BASE, 'operations.log'), result + '\n', { mode: 0o600 });
      return parseStatus(result);
    };
    const executable = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents/Info.plist')]);
    const path = join(app, 'Contents/MacOS', executable);
    const running = () => run('/bin/ps', ['-axo', 'comm=']).split('\n').some(x => x.trim() === path);
    const outcome = await applyWithConsent({
      snapshot: () => snapshot(app), check: () => core('check'), apply: () => core('apply'),
      approve: before => script('on run argv\nreturn button returned of (display dialog (item 1 of argv) with title "应用额度卡片补丁" buttons {"取消", "退出并应用"} default button "取消")\nend run', [`${githubMessage(github)}\n客户端 ${before.version} / ${before.build} 已通过兼容检查。\n继续会正常退出此客户端、创建备份、修改签名并应用补丁，成功复查后重启。请先保存当前工作。\n登录或钥匙串可能要求重新授权；备份不能恢复官方签名。`]) === '退出并应用',
      quit: async () => {
        if (!running()) return;
        script('on run argv\nwith timeout of 30 seconds\ntell application (POSIX file (item 1 of argv) as text) to quit\nend timeout\nend run', [app]);
        for (let i = 0; i < 30; i++) { if (!running()) return; await setTimeout(1000); }
        throw new Error('客户端没有正常退出；未强制终止，也未应用补丁');
      },
      start: () => run('/usr/bin/open', [app]),
    });
    if (outcome === 'cancelled') { console.log('用户取消；客户端未修改'); return; }
    const state = await loadState(); state.baseline = await snapshot(app); delete state.pending; delete state.reminded;
    state.lastResult = { status: outcome, at: Date.now() }; await save(join(BASE, 'state.json'), state);
    console.log(outcome === 'applied' ? '补丁和复查通过，已提交客户端启动请求；实际启动及卡片显示仍需确认。' : '卡片已安装，无需退出或重启。');
  });
  if (handoff) {
    const result = spawnSync(process.execPath, [join(handoff, 'bin/user-assistant.mjs'), 'worker'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`新版助手任务退出 ${result.status ?? '异常'}`);
  }
}
async function ui() {
  while (true) {
    const { app, runtime } = await config(); const state = await loadState();
    if (runtime !== ROOT) { run(process.execPath, [join(runtime, 'bin/user-assistant.mjs'), 'ui']); return; }
    const current = await snapshot(app);
    const service = spawnSync('/bin/launchctl', ['print', SERVICE], { encoding: 'utf8' });
    if (service.error) throw service.error;
    if (![0, 113].includes(service.status)) throw new Error(service.stderr.trim());
    const prompt = `提醒：${service.status === 0 ? '已启用' : '已停用'}（每5分钟）\n客户端：${current.version} / ${current.build}\n${current.key !== state.baseline?.key ? '检测到内容变化，可检查是否需要重新应用卡片。' : '与已记录客户端一致；这不代表卡片已经安装。'}\n${state.github ? githubMessage(state.github) : '尚未检查 GitHub 稳定版。'}\n只在你确认后退出并应用；不会自动下载新版客户端。`;
    const choice = script('on run argv\nset selected to choose from list {"检查更新", "检查 GitHub 稳定版", "打开 GitHub 下载新版", "使用本机 GitHub 登录检查", "改用匿名 GitHub 检查", "应用补丁", "启用提醒", "停用提醒", "打开日志和备份"} with title "额度卡片更新助手" with prompt (item 1 of argv) OK button name "执行" cancel button name "关闭"\nif selected is false then return "关闭"\nreturn item 1 of selected\nend run', [prompt]);
    if (choice === '关闭') return;
    try {
      if (choice === '检查更新' || choice === '检查 GitHub 稳定版') {
        const result = choice === '检查更新' ? (await checkUpdate(true)).github : await locked(async () => ensureGithubCurrent(await loadState(), await config()));
        dialog(githubMessage(result));
      } else if (choice === '打开 GitHub 下载新版') {
        run('/usr/bin/open', [RELEASES_PAGE]);
      } else if (choice === '使用本机 GitHub 登录检查' || choice === '改用匿名 GitHub 检查') {
        await locked(async () => {
          const settings = await config(); settings.githubAuth = choice === '使用本机 GitHub 登录检查' ? 'gh' : 'anonymous';
          await save(join(BASE, 'config.json'), settings);
          const result = await ensureGithubCurrent(await loadState(), settings); dialog(githubMessage(result));
        });
      }
      else if (choice === '应用补丁') {
        const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
        const command = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} worker`;
        script('on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run', [command]);
        dialog('已打开补丁终端。兼容检查完成后会弹出风险确认；取消不会退出客户端。请在终端查看结果。');
      } else if (choice === '打开日志和备份') run('/usr/bin/open', [BASE]);
      else if (choice === '停用提醒') await locked(async () => { run('/bin/launchctl', ['disable', SERVICE]); if (service.status === 0) run('/bin/launchctl', ['bootout', SERVICE]); });
      else if (choice === '启用提醒') { run('/bin/launchctl', ['enable', SERVICE]); if (service.status !== 0) run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST]); }
    } catch (error) { dialog(error.message); }
  }
}
async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('用户助手只支持 macOS Apple Silicon');
  const [action, ...args] = process.argv.slice(2);
  if (action === 'setup' && !args.length) {
    const selected = script('try\nreturn POSIX path of (choose file of type {"com.apple.application-bundle"} with prompt "请选择安装卡片的 ChatGPT/Codex 客户端" default location (POSIX file "/Applications/"))\non error number -128\nreturn ""\nend try');
    if (!selected) return;
    if (script('button returned of (display dialog "安装本机更新提醒助手，每5分钟检查客户端变化。不会自动退出客户端或修改补丁，只有你明确同意才执行。" with title "安装用户助手" buttons {"取消", "安装"} default button "安装")') !== '安装') return;
    await install(selected);
  } else if (action === 'install' && args.length === 2 && args[0] === '--app') await install(args[1]);
  else if (action === 'watch' && !args.length) await checkUpdate();
  else if (action === 'ui' && !args.length) await ui();
  else if (action === 'worker' && !args.length) await worker();
  else throw new Error('用法：user-assistant.mjs <setup|ui|watch|worker|install --app 客户端>');
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(async error => {
  console.error(error.message);
  if (process.argv[2] === 'worker') {
    try { await appendFile(join(BASE, 'operations.log'), `${new Date().toISOString()} 失败：${error.message}\n`, { mode: 0o600 }); }
    catch (logError) { console.error(`操作日志写入失败：${logError.message}`); }
  }
  process.exitCode = 1;
});
