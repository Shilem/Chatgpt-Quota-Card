import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertAmfiLog, amfiQueryArguments, AUTOMATED_STEP_NAMES } from './validate-client.mjs';

export async function reviewAmfi(reportPath, outputPath, query = args => execFileSync('/usr/bin/log', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) {
  const bytes = await readFile(reportPath);
  const report = JSON.parse(bytes);
  const observation = report.launchObservation;
  if (report.schemaVersion !== 1 || report.launchRequested !== true || !report.finishedAt || !isAbsolute(report.app ?? '') || basename(report.app) !== 'Client.app') throw new Error('报告缺少有效启动记录');
  const start = Date.parse(observation?.startedAt), end = Date.parse(observation?.finishedAt);
  if (observation?.status !== 'passed' || observation.survivedSeconds !== 25 || !Number.isSafeInteger(observation.pid) || observation.pid < 1 || !Number.isFinite(start) || !Number.isFinite(end) || end - start < 25000 || !(Date.parse(report.startedAt) <= start && end <= Date.parse(report.finishedAt))) throw new Error('缺少25秒存活证据，不能补验AMFI');
  const steps = report.steps;
  if (!Array.isArray(steps) || steps.length !== AUTOMATED_STEP_NAMES.length || AUTOMATED_STEP_NAMES.some(name => steps.filter(s => s.name === name).length !== 1)) throw new Error('自动验收步骤不完整或重复');
  const launch = steps.find(s => s.name === '启动与 AMFI 观察');
  if (steps.length !== 10 || steps.some(s => s !== launch && s.status !== 'passed') || launch?.status !== 'failed' || launch.error !== 'amfi 失败：exit=77, signal=null; 详见 amfi.log') throw new Error('只允许补验单独的AMFI日志权限失败，不得掩盖其他失败');
  const permissionLog = await readFile(join(dirname(reportPath), 'amfi.log'), 'utf8');
  if (!permissionLog.includes('Could not open local log store: Operation not permitted')) throw new Error('不是已识别的日志权限失败');
  const startup = await readFile(join(dirname(reportPath), 'startup.log'));
  const prefix = startup.subarray(0, observation.startupBytes);
  if (!Number.isSafeInteger(observation.startupBytes) || observation.startupBytes < 1 || prefix.length !== observation.startupBytes || createHash('sha256').update(prefix).digest('hex') !== observation.startupSha256) throw new Error('启动日志与报告证据不一致');
  const logs = query(amfiQueryArguments(dirname(report.app), observation.startedAt, observation.finishedAt));
  const review = { originalReportSha256: createHash('sha256').update(bytes).digest('hex'), app: report.app, launchObservation: observation, amfiLog: logs, manualAcceptanceRequired: true, releaseEligible: false, reviewedAt: new Date().toISOString(), status: 'automated-passed' };
  try { assertAmfiLog(logs); } catch (error) { review.status = 'failed'; review.error = error.message; }
  await writeFile(outputPath, JSON.stringify(review, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (review.status === 'failed') throw new Error(`AMFI补验失败；报告：${outputPath}`);
  return review;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) { console.error('用法：node maintainer/review-amfi.mjs <report.json> <新的补验报告.json>（由可读取系统日志的管理员执行）'); process.exitCode = 1; }
  else reviewAmfi(process.argv[2], process.argv[3]).then(() => console.log('AMFI补验通过；原报告未修改，仍需人工验收。')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
