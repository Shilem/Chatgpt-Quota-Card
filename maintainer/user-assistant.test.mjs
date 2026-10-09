import test from 'node:test';
import assert from 'node:assert/strict';
import { observeUpdate, applyWithConsent, parseStatus, compareReleaseVersions, inspectGithubRelease, checkGithubRelease, assertGithubReady, shouldCheckGithub, assertArchiveChecksum, validateRuntime, stageRuntimeUpdate, switchRuntime, DISPATCHER_SOURCE, assertRevisionProgress } from '../bin/user-assistant.mjs';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('基线不提醒，变化须稳定观察两次，去重且暂缓不冒充已应用', () => {
  const a = { key: 'a' }, b = { key: 'b' };
  let result = observeUpdate({ schemaVersion: 1 }, a, 0); assert.equal(result.notify, false);
  result = observeUpdate(result.state, b, 1000); assert.equal(result.notify, false);
  result = observeUpdate(result.state, b, 2000); assert.equal(result.notify, false);
  result = observeUpdate(result.state, b, 61000); assert.equal(result.notify, true);
  assert.equal(result.state.baseline.key, 'a');
  assert.equal(observeUpdate(result.state, b, 70000).notify, false);
  assert.equal(observeUpdate(result.state, { key: 'c' }, 80000).notify, false);
});
function fixture({ approve = true, apply = 'applied', post = 'already-patched', changed = false, quitError = false } = {}) {
  const calls = []; let checked = 0, snapshots = 0;
  return { calls, hooks: {
    snapshot: async () => ({ key: changed && ++snapshots > 1 ? 'changed' : 'a', version: '1', build: '2' }),
    check: async () => { calls.push('check'); return ++checked <= 2 ? 'ready' : post; },
    approve: async () => { calls.push('approve'); return approve; },
    quit: async () => { calls.push('quit'); if (quitError) throw new Error('没有退出'); },
    apply: async () => { calls.push('apply'); return apply; },
    start: async () => { calls.push('start'); },
  } };
}
test('用户取消不退出、不应用、不重启', async () => {
  const { hooks, calls } = fixture({ approve: false });
  assert.equal(await applyWithConsent(hooks), 'cancelled'); assert.deepEqual(calls, ['check', 'approve']);
});
test('变化、退出失败、应用失败和复查失败均不会启动', async () => {
  for (const options of [{ changed: true }, { quitError: true }, { apply: 'failed' }, { post: 'ready' }]) {
    const { hooks, calls } = fixture(options); await assert.rejects(applyWithConsent(hooks)); assert.equal(calls.includes('start'), false);
    if (options.changed || options.quitError) assert.equal(calls.includes('apply'), false);
  }
});
test('仅确认、正常退出、apply与复查通过后才启动', async () => {
  const { hooks, calls } = fixture(); assert.equal(await applyWithConsent(hooks), 'applied');
  assert.deepEqual(calls, ['check', 'approve', 'quit', 'check', 'apply', 'check', 'start']);
});
test('已经打补丁不退出，无法解析状态不猜测', async () => {
  const { hooks, calls } = fixture(); hooks.check = async () => 'already-patched';
  assert.equal(await applyWithConsent(hooks), 'already-patched'); assert.deepEqual(calls, []);
  assert.equal(parseStatus('状态: already-patched（结构、完整性哈希和签名均有效）'), 'already-patched');
  assert.throws(() => parseStatus('状态: ready\n状态: applied'));
  assert.throws(() => parseStatus('no status'));
});
function release(version = '26.1008.10000') {
  const name = `codex-quota-card-patcher-${version}.zip`, repository = 'https://github.com/Shilem/Chatgpt-Quota-Card';
  return { tag_name: version, draft: false, prerelease: false, html_url: `${repository}/releases/tag/${version}`, assets: [name, name + '.sha256'].map((name, i) => ({ name, id: i + 1, size: 100, browser_download_url: `${repository}/releases/download/${version}/${name}` })) };
}
test('稳定版数字比较和精确资产契约，拒绝预发布、外部地址、缺失和重复资产', () => {
  assert.equal(compareReleaseVersions('v8.2.10', 'v8.2.9'), 1);
  assert.equal(compareReleaseVersions('v8.2.3', '8.2.3'), 0);
  assert.throws(() => compareReleaseVersions('v8.3.0-beta', 'v8.2.3'));
  assert.equal(inspectGithubRelease(release(), 'v8.2.3').status, 'update-available');
  assert.equal(inspectGithubRelease(release('v8.2.3'), 'v8.2.3').status, 'up-to-date');
  for (const mutate of [r => { r.prerelease = true; }, r => { r.draft = true; }, r => { r.html_url = 'https://example.com'; }, r => { r.assets.pop(); }, r => { r.assets.push(r.assets[0]); }, r => { r.assets[0].browser_download_url = 'https://example.com/file'; }]) {
    const value = release(); mutate(value); assert.throws(() => inspectGithubRelease(value, 'v8.2.3'));
  }
});
test('先确认仓库可访问才判定无Release，权限/网络错误不冒充最新', async () => {
  const paths = [];
  const check = responses => checkGithubRelease('v8.2.3', async path => { paths.push(path); const response = responses.shift(); if (response instanceof Error) throw response; return response; });
  assert.equal((await check([{ status: 404 }])).status, 'unavailable');
  assert.equal(paths.length, 1);
  const repository = { status: 200, data: { full_name: 'Shilem/Chatgpt-Quota-Card' } };
  const absent = await check([repository, { status: 404 }]); assert.equal(absent.status, 'no-release'); assertGithubReady(absent);
  assert.deepEqual(paths.slice(-2), ['repos/Shilem/Chatgpt-Quota-Card', 'repos/Shilem/Chatgpt-Quota-Card/releases/latest']);
  for (const response of [{ status: 401 }, { status: 403 }, { status: 429 }, new Error('timeout')]) assert.equal((await check([response])).status, 'failed');
  for (const status of ['unavailable', 'failed', 'update-available']) assert.throws(() => assertGithubReady({ status, error: '未确认' }));
});
test('待处理客户端稳定后首次查询，再每小时复查；手动检查立即查询', () => {
  const state = { pending: { since: 0 } };
  assert.equal(shouldCheckGithub(state, 59999), false);
  assert.equal(shouldCheckGithub(state, 60000), true);
  state.github = { checkedAt: 60000 };
  assert.equal(shouldCheckGithub(state, 3599999), false);
  assert.equal(shouldCheckGithub(state, 3660000), true);
  assert.equal(shouldCheckGithub({}, 0, true), true);
  assert.equal(shouldCheckGithub({}, 9000000), false);
});
test('ZIP校验绑定哈希与精确文件名', () => {
  const bytes = Buffer.from('archive'), hash = createHash('sha256').update(bytes).digest('hex');
  assertArchiveChecksum(bytes, Buffer.from(`${hash}  release.zip\n`), 'release.zip');
  assert.throws(() => assertArchiveChecksum(Buffer.from('tampered'), `${hash}  release.zip`, 'release.zip'));
  assert.throws(() => assertArchiveChecksum(bytes, `${hash}  other.zip`, 'release.zip'));
});
async function runtimeFixture(base) {
  const root = join(base, 'source'); await mkdir(root);
  const manifest = JSON.parse(await readFile(new URL('../release-manifest.json', import.meta.url), 'utf8'));
  manifest.releaseVersion = '26.1008.10000';
  manifest.targetClient.version = manifest.releaseVersion;
  for (const entry of manifest.files) {
    const path = join(root, entry.path); await mkdir(join(path, '..'), { recursive: true });
    await cp(new URL('../' + entry.path, import.meta.url), path);
    const bytes = await readFile(path); entry.size = bytes.length; entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(join(root, 'release-manifest.json'), JSON.stringify(manifest));
  return root;
}
test('未来版本真实ZIP隔离校验后原子切换配置，旧runtime保留；竞态拒绝覆盖', async () => {
  const base = await mkdtemp(join(tmpdir(), 'user-hot-update-'));
  try {
    const root = await runtimeFixture(base), zip = join(base, 'source.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', root, zip]);
    const bytes = await readFile(zip), name = 'codex-quota-card-patcher-26.1008.10000.zip';
    const result = inspectGithubRelease(release(), 'v8.2.3');
    const runtime = await stageRuntimeUpdate(base, result, async asset => asset.name.endsWith('.sha256') ? Buffer.from(`${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`) : bytes);
    await validateRuntime(runtime, '26.1008.10000');
    const settings = { app: '/test/ChatGPT.app', runtime: root, githubAuth: 'gh' }, path = join(base, 'config.json');
    await writeFile(path, JSON.stringify(settings)); await switchRuntime(path, settings, runtime);
    assert.equal(JSON.parse(await readFile(path)).runtime, runtime); assert.equal((await stat(root)).isDirectory(), true);
    await assert.rejects(switchRuntime(path, settings, root), /配置已变化/);
    await writeFile(join(runtime, 'README.md'), 'tampered'); await assert.rejects(validateRuntime(runtime, '26.1008.10000'), /大小|哈希/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
test('恶意ZIP路径与符号链接在解压前拒绝；错误版本与额外内容拒绝', async () => {
  const base = await mkdtemp(join(tmpdir(), 'user-update-reject-'));
  try {
    const root = await runtimeFixture(base);
    await assert.rejects(validateRuntime(root, 'v9.0.0'), /版本/);
    await writeFile(join(root, 'unknown'), 'unknown'); await assert.rejects(validateRuntime(root, '26.1008.10000'), /额外内容/);
    const attempt = async () => {
      const zip = join(base, 'bad.zip'); execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', root, zip]);
      const bytes = await readFile(zip), hash = createHash('sha256').update(bytes).digest('hex');
      await assert.rejects(stageRuntimeUpdate(base, inspectGithubRelease(release(), 'v8.2.3'), async asset => asset.name.endsWith('.sha256') ? Buffer.from(`${hash}  codex-quota-card-patcher-26.1008.10000.zip\n`) : bytes), /不安全路径|符号链接/);
    };
    await attempt(); await rm(join(root, 'unknown')); await rm(join(root, 'README.md')); await symlink('/tmp/never-write-here', join(root, 'README.md')); await attempt();
  } finally { await rm(base, { recursive: true, force: true }); }
});
test('固定图形/后台分派入口自动使用新runtime，完整性失败不启动任务', async () => {
  const base = await mkdtemp(join(tmpdir(), 'user-dispatch-'));
  try {
    const dispatch = join(base, 'dispatch.mjs'); await writeFile(dispatch, DISPATCHER_SOURCE);
    for (const version of ['old', 'new']) {
      const runtime = join(base, version); await mkdir(join(runtime, 'bin'), { recursive: true });
      await writeFile(join(runtime, 'bin/verify-release.mjs'), 'console.log("verified");');
      await writeFile(join(runtime, 'bin/user-assistant.mjs'), `console.log(${JSON.stringify(version)} + ":" + process.argv[2]);`);
      await writeFile(join(base, 'config.json'), JSON.stringify({ runtime }));
      assert.equal(execFileSync(process.execPath, [dispatch, 'watch'], { encoding: 'utf8' }).trim(), `verified\n${version}:watch`);
    }
    await writeFile(join(base, 'new/bin/verify-release.mjs'), 'process.exit(7);');
    assert.throws(() => execFileSync(process.execPath, [dispatch, 'watch'], { stdio: 'pipe' }), error => error.status === 7 && error.stdout.length === 0);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('官方版号与内部修订独立，同官方版本拒绝修订回退和无递增替换', () => {
  const local = { releaseVersion: '26.1007.21159', releaseRevision: 2 };
  assertRevisionProgress(local, { ...local, releaseRevision: 3 }, true);
  assertRevisionProgress(local, local, false);
  assertRevisionProgress(local, { releaseVersion: '26.1008.10000', releaseRevision: 1 }, true);
  for (const revision of [0, 1, 2, 1.5]) assert.throws(() => assertRevisionProgress(local, { ...local, releaseRevision: revision }, true));
  assert.equal(inspectGithubRelease(release('26.1007.21159'), '26.1007.21159').downloads.length, 2);
  assert.equal(compareReleaseVersions('26.1007.21159', 'v8.2.3'), 1);
});
