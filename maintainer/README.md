# 维护者说明

本页记录官方客户端发现、隔离验证、维护监控和候选发行流程。普通用户的安装、应用、更新与恢复说明见[项目首页](../README.md)，安全与签名边界见[安全声明](../NOTICE.md)。

## 当前发行状态

当前稳定发行对齐官方客户端 `26.1007.21159`（build `20052`），内部修订4。40项回归及9个非启动隔离步骤通过；专用标准账户启动存活25秒，无FATAL。系统日志查询因账户权限失败，管理员使用独立补验工具核验同路径、同时间窗口的38条记录，未发现AMFI拒绝或库权限约束。用户已确认卡片、真实额度与登录交互人工验收通过。

原验证报告仍保留日志权限失败，补验报告独立绑定原报告SHA-256；自动字段 `releaseEligible=false` 保持不变，不能代替发布者的人工决策。原报告摘要为 `d5e0058d2c8893aad85de1afd22f86d3d7b8801b985b81593debedf052dda489`。本轮已获得用户发布授权；验收不代表所有账户、未来客户端或长期运行均已覆盖。

CI 和本地构建生成的包都是候选产物。静态回归或候选包校验通过不能代替专用环境中的启动、AMFI、视觉及数据验收，也不能触发稳定发布。

### 标准测试账户的AMFI补验

客户端验证仍在专用标准账户执行，不得使用sudo启动验证器。若唯一失败是 `amfi 失败：exit=77, signal=null`，且报告保存了通过的25秒启动观察，可将完整验证目录交由能够读取系统日志的管理员运行：

```bash
node maintainer/review-amfi.mjs "<验证目录>/report.json" "<新补验报告.json>"
```

工具使用原客户端路径和原启动时间窗口查询日志，校验启动日志摘要与其他步骤，拒绝AMFI约束/拒绝记录。补验报告记录原报告SHA-256，原报告保持不变；仍须人工验收卡片、登录、交互和真实额度。旧报告没有独立启动证据时须重新测试，不能补填通过。

## 官方稳定清单监控

`watch-client.mjs` 查询 Codex 内置的 appcast：

```text
https://updates.oaistatic.com/codex/app/appcast
```

请求包含随机 installation ID、CPU 架构、客户端版本、系统版本和 `beta=false`，不读取登录凭据。这个清单接口没有公开稳定 API 承诺，可能晚于官网 DMG；监控只报告清单中发现的构建，不声称它是全局最新版。

```bash
# 只查询清单，不下载客户端
node maintainer/watch-client.mjs --app "<ChatGPT.app 路径>" --state-dir "<状态目录>"

# 下载并验证新候选；隔离验证默认不启动应用
node maintainer/watch-client.mjs --app "<ChatGPT.app 路径>" --state-dir "<状态目录>" --process

# 原因排除后，才显式重试失败任务
node maintainer/watch-client.mjs --app "<ChatGPT.app 路径>" --state-dir "<状态目录>" --process --retry

# 可选：提交 macOS 通知
node maintainer/watch-client.mjs --app "<ChatGPT.app 路径>" --state-dir "<状态目录>" --process --notify
```

监控只接受官方 HTTPS 域名下适用于当前系统的 arm64 稳定完整 ZIP，按数字 build 选择唯一最高项，并拒绝重复最高项或清单回退。下载后先核对字节数，再用已核验原厂客户端 `26.1007.21159/build 20052` 中的固定 `SUPublicEDKey` 对完整 ZIP 执行 Ed25519 验签；只有验签通过才解压。随后还要核对 Apple/OpenAI 原厂签名、包内版本与 build。公钥轮换须重新从官方客户端核验，不能自动信任清单提供的新公钥。

任务以清单身份和补丁、验证器、监控程序哈希去重；相同输入不会重复下载或验证，工具哈希变化会重新验收。复用缓存 ZIP 时仍会重新验签。失败和中断不会自动重试；确认原因已解决后才使用 `--process --retry`。互斥锁阻止并行任务，锁记录 PID 与时间。遗留锁只能在确认持有任务已结束后手动处理；损坏状态会明确报错，不会自动重置。

状态目录保存状态、任务材料、下载包、验证报告和日志。成功后保留最近三次已结束任务的完整材料；更早任务会清理大型 ZIP、副本及测试 profile，但保留报告和日志。运行中的任务和正式客户端备份不参与清理。通知提交失败会明确记录，不改变补丁兼容性结论；系统可能因通知设置而不显示已提交的通知。

后台清单验证默认不启动应用、不修改正式客户端、不调用 AI，也不发布 Release。自动结果仍受人工验收限制。

## 隔离客户端验证

`validate-client.mjs` 只接受 Apple 信任链、OpenAI Team ID 和 Bundle ID 均符合预期的原厂未补丁客户端。它在报告目录中创建唯一副本，在副本上检查、应用、校验备份与签名、恢复，并确认源文件未变；不会退出或写入输入的正式客户端。失败时保留副本、备份、分步日志和 `report.json`，不自动重试或发布。

```bash
node maintainer/validate-client.mjs --app "<原厂 ChatGPT.app 路径>" --output "<报告目录>"

# 只有专用测试账户或测试机器才可显式启动副本
node maintainer/validate-client.mjs --app "<原厂 ChatGPT.app 路径>" --output "<报告目录>" --launch
```

默认跳过启动并报告 `partial`。`--launch` 会启动副本主程序，使用独立 Electron 用户数据目录，观察初始化和 FATAL 状态，并检查与副本路径相关的 AMFI 日志；测试进程结束后停止本次测试进程组。它可能显示应用窗口，也不是完整系统沙盒：原生钥匙串、共享设置和外部服务仍可能与当前账户或机器共享。因此只能在专用测试账户或测试机器运行。AMFI 查询失败会使验证失败；没有发现路径相关的拒绝日志也不能证明启动完全正常。

全部自动步骤通过时状态为 `automated-passed`，但 `releaseEligible` 仍为 `false`。卡片视觉、真实账户额度和登录交互仍需人工验收。入口拒绝已打补丁或临时签名的输入，不允许用 `--allow-updated-signature` 绕过原厂身份检查；此入口不下载 DMG 或安装正式客户端。

## 定时监控与图形管理

下面的命令安装仅供当前登录用户使用的 LaunchAgent。任务在登录时和每小时运行一次：

```bash
node maintainer/manage-monitor.mjs install --app "<ChatGPT.app 路径>"
node maintainer/manage-monitor.mjs status
node maintainer/manage-monitor.mjs disable
node maintainer/manage-monitor.mjs enable
node maintainer/manage-monitor.mjs notify-test
```

首次安装可追加 `--migrate "<旧状态目录>"` 迁移已有监控状态。安装会立即建立验证基线。`disable` 卸载并停用后续登录加载，但保留状态和日志；`enable` 恢复登录及定时检查，并立即检查。任务运行时拒绝停用或重装；迁移不会覆盖已有状态，也不会删除旧目录。

安装后可从用户自己的 `Applications` 目录打开“额度卡片监控.app”。图形窗口展示状态、最近检查、清单版本和验证结果，并提供启用、停用、测试通知、查看报告及打开日志目录等操作。关闭窗口不会停止后台任务。此本机生成的管理应用绑定安装时程序路径，不应直接复制给其他用户；跨用户安装请使用下面的可移动安装器。

## 构建三类候选包

所有输出目录都应放在仓库之外；构建器不会覆盖已有同名文件。普通补丁包只含发行白名单中的运行文件、安全声明和入口；用户助手安装包和维护监控安装包分别使用独立白名单，不混入彼此的维护工具。

```bash
# 普通补丁发行包
node maintainer/build-release.mjs /tmp/quota-patcher-candidate

# 普通用户的客户端更新助手安装包
node maintainer/build-monitor-installer.mjs /tmp/quota-user-candidate user

# 维护者的可移动监控安装包
node maintainer/build-monitor-installer.mjs /tmp/quota-monitor-candidate
```

用户助手和监控安装器只支持 macOS Apple Silicon，并要求 arm64 Node.js 22 或更高版本。图形安装器按自身位置定位程序，可移动或改名；缺少受支持的 Node 时会引导用户从 Node.js 官网安装。自定义 Node 路径不受支持。首次监控基线需要网络和数 GB 可用空间。当前安装器使用本机临时签名，未使用 Developer ID、未公证；清单和 SHA-256 用于完整性检查，不能证明发布者身份，也不能替代 Gatekeeper。

每个包都必须验证精确白名单、归档条目类型、文件大小和 SHA-256，并重新解压检查。修改发行运行文件后，先更新 `release-manifest.json` 对应条目的大小和 SHA-256；构建器不会自动接受未登记变化。监控安装包使用自己的 `monitor-manifest.json`，不扩大发行包白名单。

## 项目校验、纯包校验与 CI

开发目录校验显式使用 `--project`，它允许维护脚本、CI 和 Git 元数据；纯发行包校验继续使用严格默认白名单：

```bash
node bin/verify-release.mjs . --project
node maintainer/verify-project.mjs
node maintainer/build-release.mjs /tmp/quota-patcher-candidate
```

构建普通补丁包后，使用 `ditto` 解压到独立目录，再以 `node bin/verify-release.mjs "<解压目录>"` 验证纯包。还须确认不含白名单外文件，并验证校验器会拒绝同名但类型不符的条目、嵌套条目和未知内容。项目根目录允许的本地元数据不进入发行哈希；它们不应被加入发行包。

GitHub Actions 在 push、pull request 或手动触发时运行发行回归、入口语法检查和候选打包，并上传 `candidate-package` Artifact。CI 不创建 Release，也不自动发布稳定版。

## 稳定 Release 资产

只有专用环境所需的隔离应用、恢复、签名、启动/AMFI、视觉和真实额度验收完成后，才可发布稳定版。发行清单的 `releaseVersion`、`targetClient.version`、Release tag 和资产版本必须一致；当前官方版本为 `26.1007.21159`。`releaseRevision` 必须为正整数，默认值为 `1`；同一官方版本需要修订发行时递增该值。它用于区分同版本补丁修订，不能替代完整语义兼容检查。

稳定用户 Release 应提供四个资产：

- `codex-quota-card-patcher-26.1007.21159.zip` 与 `codex-quota-card-patcher-26.1007.21159.zip.sha256`；
- `quota-user-assistant-installer-26.1007.21159-arm64.zip` 与 `quota-user-assistant-installer-26.1007.21159-arm64.zip.sha256`。

维护监控安装器 `quota-monitor-installer-26.1007.21159-arm64.zip` 是独立的维护工具候选包，不作为用户助手或普通补丁包的替代品。Release tag、发行清单版本和 ZIP 文件名必须一致；候选 Artifact 不得标记或宣传为已验收稳定版。不得将维护者凭据放入任何包中。
