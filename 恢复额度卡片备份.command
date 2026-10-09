#!/bin/zsh

set -u

project_dir="${0:A:h}"
backup_dir="$project_dir/backups"

cd "$project_dir"
source "$project_dir/bin/launcher-common.zsh"
initialize_launcher

print_banner "Codex 额度卡片备份恢复 · $release_version"
echo
printf "%s恢复说明%s\n" "$style_bold" "$style_reset"
printf "  %s✓%s 仅接受本工具生成且完整校验通过的 v2 备份\n" "$style_green" "$style_reset"
printf "  %s✓%s 恢复过程采用原子写入，失败时回到恢复前状态\n" "$style_green" "$style_reset"
echo
printf "%s%s风险说明%s\n" "$style_bold" "$style_yellow" "$style_reset"
printf "  %s!%s 恢复会覆盖当前 app.asar 和 Info.plist。\n" "$style_yellow" "$style_reset"
printf "  %s!%s 恢复后仍使用本机签名，不能恢复 OpenAI 官方签名。\n" "$style_yellow" "$style_reset"
printf "  %s!%s 执行前请先按 Command+Q 完全退出 Codex App。\n" "$style_yellow" "$style_reset"
echo

validate_runtime
verify_release_integrity
printf "%s目标客户端：%s%s\n" "$style_dim" "$app_path" "$style_reset"
print_backup_storage

backup_paths=()
for candidate in "$backup_dir"/*(/N); do
  if [[ -f "$candidate/manifest.json" && -f "$candidate/app.asar" && -f "$candidate/Info.plist" ]]; then
    backup_paths+=("$candidate")
  else
    printf "%s跳过不完整备份目录：%s%s\n" "$style_yellow" "${candidate:t}" "$style_reset"
  fi
done
if [[ ${#backup_paths[@]} -eq 0 ]]; then
  launcher_error "没有找到可恢复的备份。备份目录：$backup_dir"
fi

echo
printf "%s可用备份%s\n" "$style_bold" "$style_reset"
for index in {1..${#backup_paths[@]}}; do
  printf "  %s%2d.%s %s\n" "$style_blue" "$index" "$style_reset" "${backup_paths[$index]:t}"
done
echo

while true; do
  if ! read -r "selection?请输入要恢复的序号，或输入 q 取消：[q] "; then
    echo
    printf "%s未收到选择，已安全取消。%s\n" "$style_yellow" "$style_reset"
    pause_before_close
    exit 1
  fi
  case "${(L)selection}" in
    q|quit|"")
      printf "%s已取消；客户端没有被修改。%s\n" "$style_yellow" "$style_reset"
      pause_before_close
      exit 0
      ;;
  esac
  if [[ "$selection" == <-> && "$selection" -ge 1 && "$selection" -le ${#backup_paths[@]} ]]; then
    selected_backup="${backup_paths[$selection]}"
    break
  fi
  printf "%s请输入列表中的有效序号或 q。%s\n" "$style_red" "$style_reset"
done

echo
printf "将恢复：%s%s%s\n" "$style_bold" "${selected_backup:t}" "$style_reset"
printf "%s正在执行只读备份校验……%s\n" "$style_bold" "$style_reset"
if ! "$node_path" bin/patch-codex-quota-card.mjs validate-backup --app "$app_path" --backup "$selected_backup"; then
  launcher_error "所选备份无效，恢复没有执行。"
fi
echo
if ! read -r "confirmation?确认覆盖当前客户端并恢复此备份？[y/N] "; then
  echo
  printf "%s未收到确认，已安全取消。%s\n" "$style_yellow" "$style_reset"
  pause_before_close
  exit 1
fi
case "${(L)confirmation}" in
  y|yes) ;;
  *)
    printf "%s已取消；客户端没有被修改。%s\n" "$style_yellow" "$style_reset"
    pause_before_close
    exit 0
    ;;
esac

sign_args=()
if [[ -n "${CODEX_PATCH_SIGN_IDENTITY:-}" ]]; then
  sign_args=(--sign-identity "$CODEX_PATCH_SIGN_IDENTITY")
fi

echo
printf "%s正在校验并恢复备份……%s\n" "$style_bold" "$style_reset"
"$node_path" bin/patch-codex-quota-card.mjs restore --app "$app_path" --backup "$selected_backup" "${sign_args[@]}"
exit_code=$?
echo
if [[ $exit_code -eq 0 ]]; then
  printf "%s恢复完成。现在可以重新打开 Codex。%s\n" "$style_green" "$style_reset"
else
  printf "%s恢复失败（退出码 %s）。请保留上方错误信息。%s\n" "$style_red" "$exit_code" "$style_reset"
fi
pause_before_close
exit $exit_code
