# Codex / Claude Code 项目指南

## 开始工作

开发目录包含 `maintainer/`、`.github/` 和 `.git/` 时使用 `node bin/verify-release.mjs . --project`。开发模式只额外允许这些精确根目录为普通目录；发行包继续使用默认严格白名单。`maintainer/build-release.mjs` 只按发行清单提取文件，不分发维护脚本、CI、Git、备份或 Projectmem。`maintainer/verify-project.mjs` 验证两种模式和拒绝边界。CI 产物仅为候选包，不能替代隔离客户端的应用、恢复、签名、AMFI、视觉和数据验收，也不得据此自动发布稳定版。

本项目使用 Projectmem 作为问题、尝试、修复和决策记录的权威来源。开始任务时先读取 Projectmem 当前指令、摘要、项目地图和计划；修改文件前执行 `precheck_file`。不得直接修改 `.projectmem/summary.md` 或 `.projectmem/events.jsonl`。

随后读取 `README.md`。本目录是可直接运行的发行包，不是普通源码仓库；受发行清单保护的文件发生变化时，必须同步更新 `release-manifest.json`。

定位问题时先运行与任务相关的只读检查：

```bash
node bin/verify-release.mjs .
node bin/patch-codex-quota-card.mjs check --app /Applications/ChatGPT.app
node bin/patch-codex-quota-card.mjs check --app /Applications/ChatGPT.app --allow-updated-signature
node bin/patch-codex-quota-card.mjs validate-backup --app /Applications/ChatGPT.app --backup <备份目录>
codesign --verify --deep --strict --verbose=4 /Applications/ChatGPT.app
```

## 架构与命名

- 双击入口只负责交互与环境预检；补丁、备份、恢复和签名事务统一放在 `bin/patch-codex-quota-card.mjs`。
- `check`、`apply`、`restore`、`validate-backup` 的状态名和中文错误信息属于稳定接口，不得静默改变语义。
- 文件路径常量使用全大写名称；纯检查函数使用 `assert`、`inspect`、`validate` 前缀；产生写入的函数使用 `create`、`patch`、`sign`、`restore` 前缀。

## 操作与安全

- 修改客户端前必须记录版本，并验证 Bundle ID、唯一语义能力契约、ASAR 头部与目标分包内容完整性、Electron fuse、客户端未运行和签名状态。版本仅作为已验证记录，不得替代结构与依赖验证，也不得单独阻止通过完整语义预演的新版本。
- 未知版本必须在内存中完成补丁生成、等长断言和补丁后再次解析。Monthly Hook 可来自跨分包 import，也可来自同分包内具有唯一端点、`accountId/enabled` 参数和一分钟刷新契约的本地函数；候选缺失、重复或作用域不可达时必须拒绝。
- 额度卡片必须唯一挂载在侧边栏底部。底部区域可由旧版 `absolute inset-x-0 bottom-0` 布局或新版唯一 React key `usage-alert` 证明；若存在收起态固定浮动挂载，必须等长禁用并在补丁后二次解析中确认。
- 卡片根布局固定使用 `mx-2 mb-2`，内部卡片使用 `w-full`。已安装但缺少完整根布局间距契约的 v8 应进入 `upgrade-ready`，不得误报 `already-patched`。
- `EnableEmbeddedAsarIntegrityValidation` 未明确关闭时，仅当未打补丁目标分包已有有效整体与分块哈希且 ASAR 头部与 Info.plist 一致，才可应用等长补丁；应用时必须同步重写目标分包完整性元数据和 Info.plist 头部哈希，不能以头部哈希替代目标分包校验。
- 所有客户端写入必须保留原子替换、互斥锁、源文件竞态检查和失败回滚，不得增加吞错兜底。
- 签名必须由内到外执行。Codex Framework 与 Sparkle 内的独立可执行文件和应用必须作为显式签名目标处理；最终同时执行根应用深度严格检查和全部预期目标的逐项严格检查。
- 临时签名不得携带 OpenAI Team ID 绑定权限或 `com.apple.developer.aps-environment` 等需要 Apple 授权的受限 entitlement。`codesign --verify` 通过不代表 AMFI 可启动；修改签名或完整性流程后必须检查启动期 AMFI 日志。
- 端到端验证只在隔离副本上执行，不得占用、关闭或直接实验用户正在运行的正式客户端。应用、恢复、静态签名、AMFI 启动和视觉验收必须分别记录。
- `--allow-updated-signature` 只允许处理已精确识别的补丁后自动升级状态，不是通用签名绕过。语义依赖、ASAR fuse 或嵌套签名结构变化时必须明确拒绝并新增适配。

## 修改与问题记录

- 使用 `apply_patch` 修改项目文件；所有 shell 命令遵守上级 `AGENTS.md` 的 RTK 约束。
- 不隐藏错误，不自动忽略未知签名组件，不用版本范围匹配绕过语义兼容性检查。
- 发现问题先在 Projectmem 记录 issue；每次尝试后立即记录 worked、partial 或 failed；只有自动化证据、复现消失或用户确认后才能记录 fix。
- 技术边界、产品方向或长期约束变化时同步更新本文件和 Projectmem 决策记录。用户可见文档与日志使用简体中文。

## 发行验证

- 发行运行文件采用精确白名单。新增或删除运行文件必须同步更新 `bin/verify-release.mjs` 和 `release-manifest.json`，不得绕过完整性校验。
- 根目录的 `backups/`、`.codegraph/`、`.codex/`、`.projectmem/` 是明确允许但不参与发行哈希的本地数据目录；根目录普通文件 `.DS_Store` 和 `.gitignore` 是明确允许但不参与发行哈希的本地元数据文件。
- 校验器只能按精确根目录名称和条目类型忽略上述对象；同名符号链接、普通文件、嵌套条目及其他额外内容必须拒绝。
- 完成修改后，更新发行清单中每个文件的字节数与 SHA-256，并分别验证：含允许本地元数据的项目根目录、不含本地元数据的纯发行目录，以及同名类型不符、嵌套条目和未知内容的拒绝用例。

<!-- >>> projectmem codex bridge >>> -->
## Projectmem

Use the global `pjm-mcp-global` server for Projectmem. Pass this exact `project_id` to every project-scoped tool: `proj_0f5a65deb7b0425889ea08889c0eb3b6`. Do not bind `--root` or infer a project from CWD.

Before the first substantive project task in a new or resumed agent session, call `get_instructions(project_id)`, then `get_summary(project_id)`. Do not repeat them in an unchanged conversation; refresh after context recovery, task switching, or when the project state may have changed. Before editing a file call `precheck_file(project_id, path)`.
<!-- <<< projectmem codex bridge <<< -->
