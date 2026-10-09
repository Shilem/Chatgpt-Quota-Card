import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, symlink, stat, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, assertOfficialUrl, parseFeed, verifyArchive, candidateKey, shouldProcess, parseWatchOptions, watchClient, pruneArtifacts } from './watch-client.mjs';

test('保留最近三次完整材料，旧任务保留报告日志，不删除运行中任务', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'quota-retention-')));
  try {
    const records = {};
    for (let i = 0; i < 5; i++) {
      const job = join(directory, `job-test${i}`), validation = join(job, 'validation/validation-test');
      await mkdir(join(validation, 'Client.app'), { recursive: true });
      await mkdir(join(job, 'official'));
      await writeFile(join(job, 'client.zip'), 'archive');
      await writeFile(join(validation, 'report.json'), 'report');
      await writeFile(join(validation, 'steps.log'), 'log');
      records[i] = { job, status: i === 4 ? 'running' : 'partial', finishedAt: `2026-10-0${i + 1}` };
    }
    await pruneArtifacts(directory, { records });
    await assert.rejects(stat(join(records[0].job, 'client.zip')), { code: 'ENOENT' });
    assert.equal(await readFile(join(records[0].job, 'validation/validation-test/report.json'), 'utf8'), 'report');
    assert.equal(await readFile(join(records[0].job, 'validation/validation-test/steps.log'), 'utf8'), 'log');
    for (let i = 1; i < 5; i++) assert.ok((await stat(join(records[i].job, 'client.zip'))).isFile());
    await pruneArtifacts(directory, { records });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('清理拒绝外部路径和符号链接任务，外部文件不变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quota-retention-boundary-'));
  try {
    const external = join(directory, 'outside'), stateDir = join(directory, 'state');
    await mkdir(external); await mkdir(stateDir); await writeFile(join(external, 'client.zip'), 'keep');
    const alias = join(stateDir, 'job-alias'); await symlink(external, alias);
    for (const job of [external, alias]) await assert.rejects(pruneArtifacts(stateDir, { records: { old: { job, status: 'partial', finishedAt: '2026-01-01' } } }, 0), /任务路径/);
    assert.equal(await readFile(join(external, 'client.zip'), 'utf8'), 'keep');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('监控通过符号链接指向源目录时拒绝且不创建状态目录', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quota-watch-path-test-'));
  try {
    const source = join(directory, 'source.app'), alias = join(directory, 'alias');
    await mkdir(source); await symlink(source, alias);
    await assert.rejects(watchClient({ app: source, stateDir: join(alias, 'state') }), /之外/);
    await assert.rejects(stat(join(source, 'state')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const signature = Buffer.alloc(64).toString('base64');
const item = (version, build, extra = '', url = `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-${version}.zip`) => `<item><sparkle:version>${build}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString><sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion><sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>${extra}<enclosure url="${url}" length="100" sparkle:edSignature="${signature}"/><sparkle:deltas><enclosure url="https://evil.test/delta"/></sparkle:deltas></item>`;
const feed = (...items) => `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>${items.join('')}</channel></rss>`;
test('比较版本按数字，支持大构建号及尾部零，拒绝非法版本', () => {
  assert.equal(compareVersions('26.1007.2', '26.930.99'), 1);
  assert.equal(compareVersions('9007199254740993', '9007199254740992'), 1);
  assert.equal(compareVersions('1.0', '1'), 0);
  assert.throws(() => compareVersions('1-beta', '1'));
});
test('仅允许精确官方 HTTPS 域名与完整 ZIP', () => {
  assertOfficialUrl('https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.1007.2.zip', true);
  for (const url of ['http://persistent.oaistatic.com/a.zip', 'https://persistent.oaistatic.com.evil.test/a.zip', 'https://user@persistent.oaistatic.com/a.zip', 'https://persistent.oaistatic.com/codex-app-prod/x.delta']) assert.throws(() => assertOfficialUrl(url, true));
});
test('清单选择最高稳定构建，排除 beta/delta，不依赖条目顺序', () => {
  const result = parseFeed(feed(item('26.930.1', '13232'), item('26.1007.2', '20052', '<sparkle:channel>beta</sparkle:channel>'), item('26.1002.1', '13536')), '15.0');
  assert.equal(result.build, '13536');
  assert.equal(result.version, '26.1002.1');
});
test('拒绝恶意 XML、重复构建、未知下载域名和系统不兼容', () => {
  for (const xml of ['<!DOCTYPE rss><rss/>', feed(item('26.1.1', '1'), item('26.1.2', '1')), feed(item('26.1.1', '1', '', 'https://evil.test/app.zip')), '<rss><channel>']) assert.throws(() => parseFeed(xml, '15.0'));
  assert.throws(() => parseFeed(feed(item('26.1.1', '1')), '12.0'));
});
test('解压前验签接受真实签名，拒绝篡改或错误公钥', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const data = Buffer.from('signed archive'), signed = sign(null, data, privateKey).toString('base64');
  verifyArchive(data, signed, key);
  assert.throws(() => verifyArchive(Buffer.from('tampered'), signed, key));
  assert.throws(() => verifyArchive(data, signed, Buffer.alloc(32).toString('base64')));
});
test('去重包含工具版本，已处理不重跑，失败必须显式 retry', () => {
  const candidate = { version: '1', build: '2' };
  assert.notEqual(candidateKey(candidate, 'a'), candidateKey(candidate, 'b'));
  assert.equal(shouldProcess(undefined, false), true);
  for (const status of ['partial', 'automated-passed']) assert.equal(shouldProcess({ status }, true), false);
  for (const status of ['failed', 'running']) { assert.equal(shouldProcess({ status }, false), false); assert.equal(shouldProcess({ status }, true), true); }
});
test('CLI 默认只查询，重试必须配合 process，拒绝未知参数', () => {
  assert.deepEqual(parseWatchOptions(['--app', 'a', '--state-dir', 'b']), { app: 'a', stateDir: 'b', process: false, retry: false, notify: false });
  for (const args of [[], ['--app', 'a', '--state-dir', 'b', '--retry'], ['--unknown'], ['--notify', '--notify']]) assert.throws(() => parseWatchOptions(args));
});
