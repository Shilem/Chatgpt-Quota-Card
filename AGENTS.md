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
- `bin/user-assistant.mjs` 是普通用户的本机更新提醒和批准后退出/补丁/复查/启动编排，不下载官方客户端或执行开发者隔离验证。退出前必须兼容检查及明确确认，变化竞态、退出失败、应用失败或复查失败均不得继续或自动启动；不得强制终止客户端。实际客户端写入继续由主补丁事务负责。
- 助手在稳定观察客户端变化后与补丁前先查询固定GitHub仓库稳定Release；用户已授权助手无升级询问地热更新。下载SHA-256与纯发行ZIP、精确白名单/归档类型/全部哈希/发行版本/自检通过后才原子切换独立runtime配置，保留旧版与备份。图形入口和后台服务读取配置分派，旧进程不得继续应用补丁；访问或更新失败必须显示错误并暂停，不得把私有仓库404当作无Release或最新。不内嵌维护者凭据，私有访问仅使用用户显式选择的本机gh登录。
- `check`、`apply`、`restore`、`validate-backup` 的状态名和中文错误信息属于稳定接口，不得静默改变语义。
- 发行版本直接跟随已核验的官方 `com.openai.codex` 稳定客户端版本，`release-manifest.json` 的 `releaseVersion`、`targetClient.version`、Release tag及资产名必须一致。内部 `releaseRevision` 支持同官方版本修订，必须递增；不得改动独立的v8补丁语义标记或以版号替代兼容检查。横幅和安装器从清单读取版本，不再硬编码当前发行号。
- 公开仓库及发行文件不得包含个人绝对路径、本机Projectmem项目ID、账户数据、运行日志或凭据；仅在被Git忽略的本机元数据中保存。公开历史中的隐私清理或改写必须单独授权，不得擅自强推。
- 文件路径常量使用全大写名称；纯检查函数使用 `assert`、`inspect`、`validate` 前缀；产生写入的函数使用 `create`、`patch`、`sign`、`restore` 前缀。

## 操作与安全

- 官方稳定清单监控为 `maintainer/watch-client.mjs`，仅支持 arm64 完整 ZIP；必须在解压前验证固定原厂 Sparkle Ed25519 公钥签名，再检查原厂身份及版本/build。公钥轮换需验证官方来源，不能从未可信清单自动接受。去重必须包含工具哈希；失败不自动重试，不自动移除锁、不修改正式客户端或发布。

- 维护端隔离验证使用 `maintainer/validate-client.mjs`；必须验证输入原厂身份，仅写唯一副本与报告目录。启动测试需显式 `--launch`，在专用测试账户/机器运行以隔离原生共享状态；自动结果不能替代人工验收或直接批准稳定发布。CI 仅测试入口的边界和状态，不运行真实客户端。

- 修改客户端前必须记录版本，并验证 Bundle ID、唯一语义能力契约、ASAR 头部与目标分包内容完整性、Electron fuse、客户端未运行和签名状态。版本仅作为已验证记录，不得替代结构与依赖验证，也不得单独阻止通过完整语义预演的新版本。
- 未知版本必须在内存中完成补丁生成、等长断言和补丁后再次解析。Monthly Hook 可来自跨分包 import，也可来自同分包内具有唯一端点、`accountId/enabled` 参数和一分钟刷新契约的本地函数；候选缺失、重复或作用域不可达时必须拒绝。
- 额度卡片必须唯一挂载在侧边栏底部。底部区域可由旧版 `absolute inset-x-0 bottom-0` 布局或新版唯一 React key `usage-alert` 证明；若存在收起态固定浮动挂载，必须等长禁用并在补丁后二次解析中确认。
- 卡片根布局固定使用 `mx-2 mb-2`，内部卡片使用 `w-full`。已安装但缺少完整根布局间距契约的 v8 应进入 `upgrade-ready`，不得误报 `already-patched`。
- Monthly 分流使用当前额度状态的 `plan_type` 和同一 `account_id`，复用唯一可达、已验证导出与套餐列表语义的原生企业判定，不使用邮箱域名。企业契约标记缺失的旧v8进入 `upgrade-ready`；依赖缺失、重复或判定/查询/渲染分流不一致时拒绝，不退回邮箱判断。
- `EnableEmbeddedAsarIntegrityValidation` 未明确关闭时，仅当未打补丁目标分包已有有效整体与分块哈希且 ASAR 头部与 Info.plist 一致，才可应用等长补丁；应用时必须同步重写目标分包完整性元数据和 Info.plist 头部哈希，不能以头部哈希替代目标分包校验。
- 所有客户端写入必须保留原子替换、互斥锁、源文件竞态检查和失败回滚，不得增加吞错兜底。
- 签名必须由内到外执行。Codex Framework 与 Sparkle 内的独立可执行文件和应用必须作为显式签名目标处理；最终同时执行根应用深度严格检查和全部预期目标的逐项严格检查。
- 临时签名不得携带 OpenAI Team ID 绑定权限或 `com.apple.developer.aps-environment` 等需要 Apple 授权的受限 entitlement。`codesign --verify` 通过不代表 AMFI 可启动；修改签名或完整性流程后必须检查启动期 AMFI 日志。
- 日志确认的五个原生库采用显式签名清单，不附加主进程 entitlement，并逐项严格验签。标准测试账户不能读取系统日志时，仅允许管理员对完整启动证据及单独日志权限失败进行独立补验；原报告保留，其他失败不得覆盖。
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
- 显式 `--project` 额外允许根目录 `.git/`、`.github/`、`maintainer/` 和 `dist/` 的真实目录，`dist/` 存放开发候选产物；严格用户发行模式继续拒绝它们。普通用户助手安装器只含发行运行文件与安装校验器，不得混入开发者清单下载/隔离验证程序。
- 完成修改后，更新发行清单中每个文件的字节数与 SHA-256，并分别验证：含允许本地元数据的项目根目录、不含本地元数据的纯发行目录，以及同名类型不符、嵌套条目和未知内容的拒绝用例。

## Projectmem

使用本机配置的 Projectmem 服务。明确选择已注册的项目后，每次项目级工具调用都传入同一个显式 `project_id`；不得根据CWD猜测项目。项目ID保存在本机配置或会话指令中，不写入公开仓库或发行包。

新会话或恢复后先调用 `get_instructions(project_id)`、`get_summary(project_id)`，按需读取项目地图及计划；项目状态未变时不重复读取。修改前调用 `precheck_file(project_id, path)`。
