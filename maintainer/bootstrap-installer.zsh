#!/bin/zsh
set -eu
payload="$1"
node_candidates=(/usr/local/bin/node /opt/homebrew/bin/node "$HOME"/.nvm/versions/node/*/bin/node(N))
node_executable=""
for candidate in "${node_candidates[@]}"; do
  if [[ -x "$candidate" ]] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 && process.arch === "arm64" ? 0 : 1)' >/dev/null 2>&1; then
    node_executable="$candidate"
    break
  fi
done
if [[ -z "$node_executable" ]]; then
  choice=$(/usr/bin/osascript -e 'button returned of (display dialog "安装监控需要 Apple Silicon 版 Node.js 22 或更高版本。请从 Node.js 官网下载安装包，完成安装后重新打开本安装器。" with title "需要安装 Node.js" buttons {"关闭", "打开官网"} default button "打开官网")')
  if [[ "$choice" == "打开官网" ]]; then /usr/bin/open 'https://nodejs.org/en/download'; fi
  exit 0
fi
"$node_executable" "$payload/maintainer/verify-monitor-installer.mjs" "$payload"
if [[ "${2:-developer}" == "user" ]]; then
  "$node_executable" "$payload/bin/user-assistant.mjs" setup
else
  "$node_executable" "$payload/maintainer/manage-monitor.mjs" setup
fi
