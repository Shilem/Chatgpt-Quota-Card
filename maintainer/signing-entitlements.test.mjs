import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sanitizedEntitlements, signNativeModule } from '../bin/patch-codex-quota-card.mjs';

test('真实签名权限清理移除通信通知权限，保留JIT和网络权限', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quota-signing-test-'));
  try {
    const target = join(directory, 'fixture');
    const source = join(directory, 'source.plist');
    await copyFile('/usr/bin/true', target);
    await writeFile(source, '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.developer.usernotifications.communication</key><true/><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.network.client</key><true/></dict></plist>');
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', source, target]);
    const original = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', target], { encoding: 'utf8' });
    assert.match(original, /com\.apple\.developer\.usernotifications\.communication/);
    const sanitized = await sanitizedEntitlements(target, directory, 'fixture');
    const plist = await readFile(sanitized, 'utf8');
    assert.doesNotMatch(plist, /com\.apple\.developer\.usernotifications\.communication/);
    for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.network.client']) assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, sanitized], { encoding: 'utf8' }).trim(), 'true');
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', sanitized, target]);
    const signed = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', target], { encoding: 'utf8' });
    assert.doesNotMatch(signed, /com\.apple\.developer\.usernotifications\.communication/);
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', target]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('真实原生库重签移除主进程权限并通过严格签名检查', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quota-native-signing-test-'));
  try {
    const target = join(directory, 'fixture.node'), plist = join(directory, 'permissions.plist');
    execFileSync('/usr/bin/clang', ['-bundle', '-x', 'c', '-', '-o', target], { input: 'int quota_fixture(void) { return 1; }' });
    await writeFile(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.network.client</key><true/></dict></plist>');
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--force-library-entitlements', '--entitlements', plist, target]);
    assert.match(execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', target], { encoding: 'utf8' }), /<key>/);
    signNativeModule(target, '-');
    assert.doesNotMatch(execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', target], { encoding: 'utf8' }), /<key>/);
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', target]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
