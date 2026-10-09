#!/bin/zsh

set -u

project_dir="${0:A:h}"
backup_dir="$project_dir/backups"

cd "$project_dir"
source "$project_dir/bin/launcher-common.zsh"
initialize_launcher

print_banner "Codex 侧边栏额度卡片 · $release_version"
echo
printf "%s功能介绍%s\n" "$style_bold" "$style_reset"
printf "  %s✓%s 原生企业类别账户：展示 Monthly 剩余额度和本月用量，不限邮箱域名\n" "$style_green" "$style_reset"
printf "  %s✓%s 其他账户：展示 5h、Weekly 剩余额度及重置时间\n" "$style_green" "$style_reset"
printf "  %s✓%s 仅显示文字信息，不显示进度条\n" "$style_green" "$style_reset"
printf "  %s✓%s 执行前自动检查，写入前备份，失败时自动回滚\n" "$style_green" "$style_reset"
echo
printf "%s%s风险说明%s\n" "$style_bold" "$style_yellow" "$style_reset"
printf "  %s!%s 本工具会修改 /Applications/ChatGPT.app，不是官方扩展。\n" "$style_yellow" "$style_reset"
printf "  %s!%s 修改后使用本机签名，macOS 可能弹出钥匙串授权。\n" "$style_yellow" "$style_reset"
printf "  %s!%s 客户端更新可能覆盖补丁，需要重新检查和应用。\n" "$style_yellow" "$style_reset"
printf "  %s!%s 本工具补丁后的客户端自动升级时，旧签名链可能失效；只在挂载语义、完整性与签名结构均通过后重新签名。\n" "$style_yellow" "$style_reset"
printf "  %s!%s 备份不能恢复 OpenAI 官方签名；恢复官方状态需重新安装客户端。\n" "$style_yellow" "$style_reset"
printf "  %s!%s 执行前请先按 Command+Q 完全退出 Codex App。\n" "$style_yellow" "$style_reset"
echo
printf "%s备份位置：%s%s\n" "$style_dim" "$backup_dir" "$style_reset"
echo

printf "%s运行环境预检%s\n" "$style_bold" "$style_reset"
validate_runtime
verify_release_integrity
printf "  %s✓%s macOS 与 Node.js %s\n" "$style_green" "$style_reset" "$node_version"
printf "  %s✓%s 客户端：%s\n" "$style_green" "$style_reset" "$app_path"
print_backup_storage
echo
printf "%s客户端只读检查%s\n" "$style_bold" "$style_reset"
if ! "$node_path" bin/patch-codex-quota-card.mjs check --app "$app_path" --allow-updated-signature; then
  launcher_error "客户端未通过只读检查，补丁没有执行。只有精确匹配的补丁后自动升级状态可以重建签名；其他签名或哈希异常仍需重新安装官方客户端。"
fi
echo

while true; do
  if ! read -r "confirmation?确认已了解以上风险并继续执行？[y/N] "; then
    echo
    printf "%s未收到确认，已安全取消；客户端没有被修改。%s\n" "$style_yellow" "$style_reset"
    pause_before_close
    exit 1
  fi
  case "${(L)confirmation}" in
    y|yes)
      break
      ;;
    n|no|"")
      printf "%s已取消；客户端没有被修改。%s\n" "$style_yellow" "$style_reset"
      pause_before_close
      exit 0
      ;;
    *)
      printf "%s请输入 y 或 n。%s\n" "$style_red" "$style_reset"
      ;;
  esac
done

echo
printf "%s正在检查并应用补丁……%s\n" "$style_bold" "$style_reset"
sign_args=()
if [[ -n "${CODEX_PATCH_SIGN_IDENTITY:-}" ]]; then
  sign_args=(--sign-identity "$CODEX_PATCH_SIGN_IDENTITY")
fi

"$node_path" bin/patch-codex-quota-card.mjs apply --app "$app_path" --backup-root "$backup_dir" --allow-updated-signature "${sign_args[@]}"
exit_code=$?
echo
if [[ $exit_code -eq 0 ]]; then
  printf "%s应用完成。现在可以重新打开 Codex。%s\n" "$style_green" "$style_reset"
  if [[ ${#sign_args[@]} -eq 0 ]]; then
    printf "%s提示：临时签名改变了应用身份，首次启动可能出现 macOS 钥匙串重新授权弹窗。%s\n" "$style_yellow" "$style_reset"
  fi
else
  printf "%s应用失败（退出码 %s）。上方错误和自动回滚结果会保留在窗口中。%s\n" "$style_red" "$exit_code" "$style_reset"
fi
pause_before_close
exit $exit_code
