#!/usr/bin/env node
import { createHash, randomUUID, createPublicKey, verify } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, realpath, stat, mkdtemp, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validateClient, OFFICIAL_REQUIREMENT, isWithin, canonicalFuturePath } from './validate-client.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FEED = 'https://updates.oaistatic.com/codex/app/appcast';
// 来自已验证原厂 26.1007.21159/build 20052 的 Info.plist。密钥轮换必须重新核验原厂身份。
const PUBLIC_KEY = 'mNfr1v9t63BfgDtlw4C8lRvSY6uMggIXABDOCi3tS6k=';
const SPARKLE_NS = 'http://www.andymatuschak.org/xml-namespaces/sparkle';
function run(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 失败：${result.stderr.trim()}`);
  return result.stdout.trim();
}
export function compareVersions(a, b) {
  if (![a, b].every(x => /^\d+(\.\d+)*$/.test(x))) throw new Error('版本必须为点分数字');
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0n, y = right[i] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
export function assertOfficialUrl(value, archive = false) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !['updates.oaistatic.com', 'persistent.oaistatic.com'].includes(url.hostname)) throw new Error('更新地址不是允许的官方 HTTPS 地址');
  if (archive && (url.hostname !== 'persistent.oaistatic.com' || !/^\/codex-app-prod\/ChatGPT-darwin-arm64-\d+(\.\d+)+\.zip$/.test(url.pathname) || url.search)) throw new Error('只允许官方 Apple Silicon 完整 ZIP');
  return url;
}
export function parseFeed(xml, osVersion) {
  if (Buffer.byteLength(xml) > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('更新 XML 过大或包含外部实体声明');
  const xpath = expression => run('/usr/bin/xmllint', ['--nonet', '--xpath', expression, '-'], xml);
  if (xpath('count(/rss/channel)') !== '1') throw new Error('更新 XML 必须包含唯一 RSS channel');
  const count = Number(xpath('count(/rss/channel/item)'));
  if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error('更新条目数量无效');
  const items = [];
  for (let i = 1; i <= count; i++) {
    const base = `/rss/channel/item[${i}]`;
    const node = name => `${base}/*[local-name()='${name}' and namespace-uri()='${SPARKLE_NS}']`;
    const text = name => xpath(`string(${node(name)})`);
    const channel = text('channel');
    if (channel && channel !== 'stable') continue;
    if (text('hardwareRequirements') !== 'arm64') continue;
    const minimumOS = text('minimumSystemVersion');
    if (compareVersions(osVersion, minimumOS) < 0) continue;
    const enclosure = `${base}/enclosure`;
    if (xpath(`count(${enclosure})`) !== '1' || xpath(`count(${enclosure}/@*[local-name()='deltaFrom'])`) !== '0') throw new Error('完整安装包必须唯一且不能是 delta');
    const version = text('shortVersionString'), build = text('version');
    for (const name of ['shortVersionString', 'version', 'hardwareRequirements', 'minimumSystemVersion']) if (xpath(`count(${node(name)})`) !== '1') throw new Error(`更新字段必须唯一：${name}`);
    compareVersions(version, version); compareVersions(build, build);
    const url = xpath(`string(${enclosure}/@url)`), length = Number(xpath(`string(${enclosure}/@length)`));
    const signature = xpath(`string(${enclosure}/@*[local-name()='edSignature' and namespace-uri()='${SPARKLE_NS}'])`);
    assertOfficialUrl(url, true);
    if (!Number.isSafeInteger(length) || length < 1 || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('安装包大小或 Ed25519 签名无效');
    if (!new URL(url).pathname.endsWith(`-${version}.zip`)) throw new Error('下载地址与版本不一致');
    items.push({ version, build, url, length, signature, minimumOS });
  }
  items.sort((a, b) => compareVersions(b.build, a.build));
  if (!items.length) throw new Error('没有适合当前系统的 Apple Silicon 稳定包');
  if (items.length > 1 && compareVersions(items[0].build, items[1].build) === 0) throw new Error('最高构建号重复，拒绝猜测');
  return items[0];
}
export function verifyArchive(bytes, signature, key = PUBLIC_KEY) {
  const rawKey = Buffer.from(key, 'base64');
  if (rawKey.length !== 32) throw new Error('更新公钥长度无效');
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), format: 'der', type: 'spki' });
  if (!verify(null, bytes, publicKey, Buffer.from(signature, 'base64'))) throw new Error('安装包 Ed25519 签名验证失败，禁止解压');
}
export function candidateKey(candidate, toolHash) {
  return createHash('sha256').update(JSON.stringify({ candidate, toolHash })).digest('hex');
}
export function shouldProcess(record, retry) {
  if (!record) return true;
  return retry && ['failed', 'running'].includes(record.status);
}
async function officialFetch(url, milliseconds) {
  const signal = AbortSignal.timeout(milliseconds);
  for (let i = 0; i < 6; i++) {
    assertOfficialUrl(url);
    const response = await fetch(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('官方响应重定向缺少地址');
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`官方更新请求失败：HTTP ${response.status}`); }
    return response;
  }
  throw new Error('官方更新重定向次数过多');
}
async function writeState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
export async function watchClient(options) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('当前监控只支持 macOS Apple Silicon');
  const source = await realpath(options.app), directory = await canonicalFuturePath(options.stateDir);
  for (const protectedPath of [ROOT, source, '/Applications', '/System', '/Library']) if (isWithin(protectedPath, directory)) throw new Error('监控状态目录必须在项目和客户端之外');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(directory);
  for (const protectedPath of [ROOT, source, '/Applications', '/System', '/Library']) if (isWithin(protectedPath, stateDir)) throw new Error('状态目录指向受保护位置');
  const lock = join(stateDir, '.lock');
  try { await mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`监控锁已存在：${lock}；确认旧任务结束后才能手动移除`); throw error; }
  const statePath = join(stateDir, 'state.json');
  let state, job, key, stateValidated = false;
  async function notify(message) {
    console.log(message);
    if (options.notify) {
      let notification;
      try {
        run('/usr/bin/osascript', ['-e', 'on run argv\ndisplay notification (item 1 of argv) with title "额度卡片维护"\nend run', message]);
        notification = { status: 'submitted', at: new Date().toISOString() };
      } catch (error) {
        console.error(`系统通知提交失败，结果已输出到终端：${error.message}`);
        notification = { status: 'failed', error: error.message, at: new Date().toISOString() };
      }
      if (stateValidated) { state.notification = notification; await writeState(statePath, state); }
    }
  }
  try {
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = { schemaVersion: 1, installationId: randomUUID(), records: {} }; }
    if (state.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(state.installationId) || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)) throw new Error('监控状态损坏，拒绝重置');
    stateValidated = true;
    const plist = join(source, 'Contents/Info.plist');
    if (run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]) !== 'com.openai.codex') throw new Error('仅支持 com.openai.codex');
    const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
    compareVersions(version, version);
    const url = new URL(FEED);
    for (const [name, value] of Object.entries({ installation_id: state.installationId, arch: 'arm64', app_version: version, beta: 'false', 'os-version': run('/usr/bin/sw_vers', ['-productVersion']) })) url.searchParams.set(name, value);
    const response = await officialFetch(url.href, 30000);
    let xml = '', size = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('更新清单过大'); xml += decoder.decode(chunk, { stream: true }); }
    xml += decoder.decode();
    const candidate = parseFeed(xml, run('/usr/bin/sw_vers', ['-productVersion']));
    if (state.latest && compareVersions(candidate.build, state.latest.build) < 0) throw new Error('官方清单最高构建号回退，停止处理');
    const hash = createHash('sha256');
    for (const path of ['bin/patch-codex-quota-card.mjs', 'maintainer/validate-client.mjs', 'maintainer/watch-client.mjs']) hash.update(await readFile(join(ROOT, path)));
    key = candidateKey(candidate, hash.digest('hex'));
    const changed = state.latestKey !== key;
    state.latestKey = key; state.latest = candidate; state.checkedAt = new Date().toISOString();
    delete state.lastError;
    await writeState(statePath, state);
    if (!options.process) {
      if (changed) await notify(`官方稳定清单：${candidate.version} / build ${candidate.build}。尚未下载或验证。`);
      return { status: changed ? 'discovered' : 'unchanged', candidate };
    }
    if (!shouldProcess(state.records[key], options.retry)) return { status: 'already-processed', record: state.records[key] };
    job = await mkdtemp(join(stateDir, 'job-'));
    state.records[key] = { status: 'running', candidate, job, startedAt: new Date().toISOString() };
    await writeState(statePath, state);
    await writeFile(join(job, 'appcast.xml'), xml, { mode: 0o600 });
    const archive = join(job, 'client.zip');
    const download = await officialFetch(candidate.url, 600000);
    await pipeline(Readable.fromWeb(download.body), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    if ((await stat(archive)).size !== candidate.length) throw new Error('安装包字节数与清单不一致');
    const bytes = await readFile(archive); verifyArchive(bytes, candidate.signature);
    const archiveHash = createHash('sha256').update(bytes).digest('hex');
    const extracted = join(job, 'official');
    run('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
    const apps = (await readdir(extracted, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
    if (apps.length !== 1) throw new Error('官方 ZIP 顶层应用必须唯一');
    const app = join(extracted, apps[0].name), appPlist = join(app, 'Contents/Info.plist');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', OFFICIAL_REQUIREMENT, app]);
    if (run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', appPlist]) !== candidate.version || run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', appPlist]) !== candidate.build) throw new Error('官方包内版本或构建号与清单不一致');
    const result = await validateClient({ app, output: join(job, 'validation'), launch: false });
    state.records[key] = { ...state.records[key], status: result.report.status, reportPath: result.reportPath, archiveHash, finishedAt: new Date().toISOString(), releaseEligible: false };
    await writeState(statePath, state);
    await notify(`稳定清单 ${candidate.version} / ${candidate.build} 隔离验证完成：${result.report.status}，仍需人工验收。报告：${result.reportPath}`);
    return state.records[key];
  } catch (error) {
    if (state && job && key) {
      state.records[key] = { ...state.records[key], status: 'failed', error: error.message, finishedAt: new Date().toISOString() };
      await writeState(statePath, state);
    }
    if (!stateValidated || state.lastError !== error.message) {
      if (stateValidated) { state.lastError = error.message; await writeState(statePath, state); }
      await notify(`维护检查失败：${error.message}`);
    }
    throw error;
  } finally { await rm(lock, { recursive: true }); }
}
export function parseWatchOptions(args) {
  const options = { process: false, retry: false, notify: false };
  for (let i = 0; i < args.length; i++) {
    const flag = new Map([['--process', 'process'], ['--retry', 'retry'], ['--notify', 'notify']]).get(args[i]);
    if (flag && !options[flag]) { options[flag] = true; continue; }
    const key = new Map([['--app', 'app'], ['--state-dir', 'stateDir']]).get(args[i]);
    if (!key || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`参数无效或重复：${args[i]}`);
    options[key] = args[++i];
  }
  if (!options.app || !options.stateDir || (options.retry && !options.process)) throw new Error('用法：node maintainer/watch-client.mjs --app <当前.app> --state-dir <项目外目录> [--process] [--retry] [--notify]');
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => watchClient(parseWatchOptions(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
