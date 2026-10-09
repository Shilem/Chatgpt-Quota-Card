import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function summarizeMonitor(service, disabled, state) {
  const active = service && /\n\s*pid = \d+/.test(service);
  const loaded = service ? '已启用' : disabled ? '已停用' : '未加载';
  const lines = [`后台监控：${active ? '正在检查' : loaded}`, '检查频率：每小时，登录后启动'];
  if (state) {
    if (state.schemaVersion !== 1 || !state.records || Array.isArray(state.records)) throw new Error('监控状态损坏，请查看日志');
    if (state.checkedAt) lines.push(`最近检查：${new Date(state.checkedAt).toLocaleString('zh-CN')}`);
    if (state.latest) lines.push(`稳定清单：${state.latest.version}（${state.latest.build}）`);
    const record = state.records[state.latestKey];
    const statuses = { partial: '静态验证通过，仍需运行和人工验收', 'automated-passed': '自动验证通过，仍需人工验收', failed: '验证失败', running: '验证进行中' };
    if (record) {
      if (!statuses[record.status]) throw new Error('验证记录包含未知状态');
      lines.push(`验证结果：${statuses[record.status]}`);
    }
    if (state.lastError) lines.push(`最近错误：${state.lastError}`);
  } else lines.push('尚无检查记录');
  lines.push('发现变化或新的失败会通知；本窗口不会安装新版客户端或发布补丁。');
  return lines.join('\n');
}
function appleScript(script, args = []) {
  const result = spawnSync('/usr/bin/osascript', ['-e', script, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
}
export async function monitorUI({ base, manager, getService, getDisabled }) {
  const message = (text, title = '额度卡片监控') => appleScript('on run argv\ndisplay dialog (item 1 of argv) with title (item 2 of argv) buttons {"确定"} default button "确定"\nend run', [text, title]);
  while (true) {
    let state;
    try { state = JSON.parse(await readFile(join(base, 'state/state.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') { message(error.message, '无法读取监控状态'); return; } }
    const prompt = summarizeMonitor(getService(), getDisabled(), state);
    const choice = appleScript('on run argv\nset selected to choose from list {"刷新状态", "启用监控", "停用监控", "测试通知", "查看验证报告", "打开日志目录"} with title "额度卡片监控" with prompt (item 1 of argv) default items {"刷新状态"} OK button name "执行" cancel button name "关闭"\nif selected is false then return "关闭"\nreturn item 1 of selected\nend run', [prompt]);
    if (choice === '关闭') return;
    if (choice === '刷新状态') continue;
    try {
      if (choice === '打开日志目录' || choice === '查看验证报告') {
        const record = state?.records[state.latestKey];
        const target = choice === '查看验证报告' ? record?.reportPath : base;
        if (!target) throw new Error('当前版本尚未生成验证报告');
        if (target !== base && !target.startsWith(base + '/state/')) throw new Error('报告路径不在维护状态目录内');
        const result = spawnSync('/usr/bin/open', [choice === '查看验证报告' ? '-R' : target, ...(choice === '查看验证报告' ? [target] : [])], { encoding: 'utf8' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(result.stderr.trim());
      } else {
        const action = { '启用监控': 'enable', '停用监控': 'disable', '测试通知': 'notify-test' }[choice];
        if (!action) throw new Error('未知操作');
        const result = spawnSync(process.execPath, [manager, action], { encoding: 'utf8' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(result.stderr.trim());
        message(result.stdout.trim());
      }
    } catch (error) { message(error.message, '操作未完成'); }
  }
}
