#!/bin/zsh

initialize_launcher() {
  if [[ -t 1 ]]; then
    style_bold=$'\033[1m'
    style_blue=$'\033[36m'
    style_green=$'\033[32m'
    style_yellow=$'\033[33m'
    style_red=$'\033[31m'
    style_dim=$'\033[2m'
    style_reset=$'\033[0m'
  else
    style_bold=""
    style_blue=""
    style_green=""
    style_yellow=""
    style_red=""
    style_dim=""
    style_reset=""
  fi
  if ! release_version="$(/usr/bin/plutil -extract releaseVersion raw -o - "$project_dir/release-manifest.json")"; then
    launcher_error "无法读取发行版本。请重新获取完整发行包。"
  fi
}

pause_before_close() {
  echo
  if [[ -t 0 ]]; then
    printf "%s按任意键关闭窗口。%s" "$style_dim" "$style_reset"
    read -k 1 || true
    echo
  fi
}

launcher_error() {
  printf "%s错误：%s%s\n" "$style_red" "$1" "$style_reset"
  pause_before_close
  exit "${2:-1}"
}

resolve_app_path() {
  if [[ -n "${CODEX_PATCH_APP:-}" ]]; then
    app_path="${CODEX_PATCH_APP:A}"
  elif [[ -d "/Applications/ChatGPT.app" ]]; then
    app_path="/Applications/ChatGPT.app"
  elif [[ -d "/Applications/Codex.app" ]]; then
    app_path="/Applications/Codex.app"
  else
    launcher_error "未找到 /Applications/ChatGPT.app 或 /Applications/Codex.app。可通过 CODEX_PATCH_APP 指定客户端路径。"
  fi

  if [[ ! -f "$app_path/Contents/Info.plist" || ! -f "$app_path/Contents/Resources/app.asar" ]]; then
    launcher_error "目标不是完整的 Codex/ChatGPT macOS 客户端：$app_path"
  fi
}

validate_runtime() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    launcher_error "此补丁只支持 macOS。"
  fi
  if ! node_path="$(command -v node 2>/dev/null)"; then
    launcher_error "未找到 Node.js。请安装 Node.js 18 或更高版本后重试。"
  fi
  if ! node_version="$($node_path -p 'process.versions.node')"; then
    launcher_error "无法读取 Node.js 版本。"
  fi
  node_major="${node_version%%.*}"
  node_remainder="${node_version#*.}"
  node_minor="${node_remainder%%.*}"
  if [[ "$node_major" -lt 18 || ( "$node_major" -eq 18 && "$node_minor" -lt 15 ) ]]; then
    launcher_error "Node.js 版本过低（当前 $node_version），需要 18.15 或更高版本。"
  fi
  resolve_app_path
}

verify_release_integrity() {
  if [[ -f "$project_dir/release-manifest.json" ]]; then
    local verify_args=()
    if [[ -d "$project_dir/maintainer" ]]; then
      verify_args=(--project)
    fi
    "$node_path" "$project_dir/bin/verify-release.mjs" "$project_dir" "${verify_args[@]}" || launcher_error "发行文件完整性校验失败。请重新获取可信 ZIP。"
  elif [[ ! -f "$project_dir/package.json" || ! -f "$project_dir/scripts/build-release.mjs" ]]; then
    launcher_error "发行包缺少 release-manifest.json，无法确认文件完整性。"
  fi
}

print_backup_storage() {
  local backup_count=0
  local backup_size="0B"
  if [[ -d "$backup_dir" ]]; then
    local backup_manifests=("$backup_dir"/*/manifest.json(N))
    backup_count=${#backup_manifests[@]}
    backup_size="$(du -sh "$backup_dir" 2>/dev/null | awk '{print $1}')"
    [[ -n "$backup_size" ]] || backup_size="未知"
  fi
  printf "  %sℹ%s 已有备份：%s 份，占用 %s\n" "$style_blue" "$style_reset" "$backup_count" "$backup_size"
}

print_banner() {
  local title="$1"
  printf "%s%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n" "$style_bold" "$style_blue" "$style_reset"
  printf "%s%s  %s%s\n" "$style_bold" "$style_blue" "$title" "$style_reset"
  printf "%s%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n" "$style_bold" "$style_blue" "$style_reset"
}
