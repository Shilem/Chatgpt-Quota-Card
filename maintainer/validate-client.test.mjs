import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, mkdir, symlink, stat, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { reviewAmfi } from './review-amfi.mjs';
import { assertAmfiLog } from './validate-client.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWithin, parseOptions, summarize, assertStatus, OFFICIAL_REQUIREMENT, validateClient } from './validate-client.mjs';

test('拒绝指向源客户端的输出符号链接，拒绝前不得创建子目录', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quota-path-test-'));
  try {
    const source = join(directory, 'source.app'), alias = join(directory, 'alias');
    await mkdir(source);
    await symlink(source, alias);
    await assert.rejects(validateClient({ app: source, output: join(alias, 'unexpected'), launch: false }), /之外/);
    await assert.rejects(stat(join(source, 'unexpected')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('macOS codesign 正常解析官方要求并拒绝临时签名', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quota-signature-test-'));
  try {
    const fixture = join(directory, 'fixture');
    await cp('/usr/bin/true', fixture);
    const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', fixture], { encoding: 'utf8' });
    if (signed.error) throw signed.error;
    assert.equal(signed.status, 0, signed.stderr);
    const result = spawnSync('/usr/bin/codesign', ['--verify', '-R', OFFICIAL_REQUIREMENT, fixture], { encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /failed to satisfy/);
    assert.doesNotMatch(result.stderr, /invalid requirement specification/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('路径边界拒绝自身和后代，不误拒绝相似名称', () => {
  assert.equal(isWithin('/Applications', '/Applications/Test.app'), true);
  assert.equal(isWithin('/tmp/project', '/tmp/project'), true);
  assert.equal(isWithin('/tmp/project', '/tmp/project-other'), false);
  assert.equal(isWithin('/tmp/project', '/tmp/other'), false);
});
test('参数必须明确指定输入和报告目录，拒绝重复或未知开关', () => {
  assert.deepEqual(parseOptions(['--app', '/a.app', '--output', '/tmp/out', '--launch']), { launch: true, app: '/a.app', output: '/tmp/out' });
  for (const args of [[], ['--app', 'a'], ['--app', 'a', '--app', 'b'], ['--launch', '--launch'], ['--allow-updated-signature']]) assert.throws(() => parseOptions(args));
});
test('状态解析拒绝缺失、多个状态和 already-patched 冒充新应用', () => {
  assertStatus('版本: 1\n状态: applied\n备份: /tmp/x\n', 'applied');
  for (const value of ['状态: already-patched', '', '状态: ready\n状态: applied']) assert.throws(() => assertStatus(value, 'applied'));
});
const required = ['发行工具完整性', '官方身份', '隔离复制', '补丁前兼容', '应用补丁', '备份校验', '补丁后兼容与全部签名', '启动与 AMFI 观察', '恢复及恢复后签名', '源客户端未改变'];
test('AMFI拒绝库权限约束，不把普通adhoc信任提示当作失败', () => {
  assertAmfiLog('Code=-423 The file is adhoc signed');
  assert.throws(() => assertAmfiLog('constraint violation: has entitlements but is not a main binary'));
  assert.throws(() => assertAmfiLog('signature validation failed fatally'));
});
test('管理员补验限定日志权限失败，保留原报告并拒绝损坏证据和其他失败', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quota-amfi-review-test-'));
  try {
    const startup = 'Launching app\nready\n';
    const report = { schemaVersion: 1, app: '/tmp/original-validation/Client.app', launchRequested: true, startedAt: '2026-10-09T09:00:00Z', finishedAt: '2026-10-09T09:01:00Z', steps: required.map(name => ({ name, status: name === '启动与 AMFI 观察' ? 'failed' : 'passed', ...(name === '启动与 AMFI 观察' ? { error: 'amfi 失败：exit=77, signal=null; 详见 amfi.log' } : {}) })), launchObservation: { status: 'passed', survivedSeconds: 25, pid: 123, startedAt: '2026-10-09T09:00:10Z', finishedAt: '2026-10-09T09:00:35Z', startupBytes: Buffer.byteLength(startup), startupSha256: createHash('sha256').update(startup).digest('hex') } };
    const input = join(directory, 'report.json');
    const original = JSON.stringify(report);
    await writeFile(input, original);
    await writeFile(join(directory, 'startup.log'), startup + 'shutdown\n');
    await writeFile(join(directory, 'amfi.log'), 'log: Could not open local log store: Operation not permitted\n');
    const review = await reviewAmfi(input, join(directory, 'review.json'), args => { assert.match(args.at(-1), /original-validation/); assert.ok(args.includes('2026-10-09 09:00:10+0000')); return 'Code=-423 The file is adhoc signed'; });
    assert.equal(review.status, 'automated-passed');
    assert.equal(review.releaseEligible, false);
    assert.equal(await readFile(input, 'utf8'), original);
    await assert.rejects(reviewAmfi(input, join(directory, 'denied.json'), () => 'constraint violation'), /AMFI补验失败/);
    assert.equal(JSON.parse(await readFile(join(directory, 'denied.json'), 'utf8')).status, 'failed');
    for (const invalid of [ { ...report, launchObservation: { ...report.launchObservation, startupSha256: 'bad' } }, { ...report, launchObservation: { ...report.launchObservation, startedAt: 'invalid' } }, { ...report, steps: report.steps.map((s, i) => i === 0 ? { ...s, status: 'failed' } : s) } ]) {
      await writeFile(input, JSON.stringify(invalid));
      await assert.rejects(reviewAmfi(input, join(directory, 'invalid.json'), () => assert.fail('不得查询日志')));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('只有全部自动步骤完成才通过，且始终不能自动发布', () => {
  const report = { finishedAt: 'done', launchRequested: true, steps: required.map(name => ({ name, status: 'passed' })) };
  assert.deepEqual(summarize(report), { status: 'automated-passed', manualAcceptanceRequired: true, releaseEligible: false });
  assert.equal(summarize({ ...report, finishedAt: undefined }).status, 'running');
  for (const name of required) {
    assert.equal(summarize({ ...report, steps: report.steps.filter(step => step.name !== name) }).status, 'partial');
    assert.equal(summarize({ ...report, steps: report.steps.map(step => step.name === name ? { ...step, status: 'failed' } : step) }).status, 'failed');
  }
});
