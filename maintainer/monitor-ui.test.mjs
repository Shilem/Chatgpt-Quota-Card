import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMonitor } from './monitor-ui.mjs';

test('静态通过仍明确需要人工验收；失败和运行状态不误报成功', () => {
  const state = { schemaVersion: 1, records: { a: { status: 'partial' } }, latestKey: 'a', latest: { version: '26.1', build: '10' } };
  assert.match(summarizeMonitor('loaded', false, state), /静态验证通过，仍需运行和人工验收/);
  state.records.a.status = 'failed'; state.lastError = '签名失败';
  assert.match(summarizeMonitor('loaded', false, state), /验证失败[\s\S]*签名失败/);
  state.records.a.status = 'running';
  assert.match(summarizeMonitor('\n pid = 123', false, state), /正在检查[\s\S]*验证进行中/);
});
test('停用、未加载和损坏状态有明确区分', () => {
  assert.match(summarizeMonitor(null, true), /已停用/);
  assert.match(summarizeMonitor(null, false), /未加载/);
  assert.throws(() => summarizeMonitor(null, false, { schemaVersion: 2 }), /损坏/);
  assert.throws(() => summarizeMonitor(null, false, { schemaVersion: 1, latestKey: 'x', records: { x: { status: 'whatever' } } }), /未知状态/);
});
