# Chatgpt-Quota-Card

[![发行校验](https://github.com/Shilem/Chatgpt-Quota-Card/actions/workflows/verify.yml/badge.svg)](https://github.com/Shilem/Chatgpt-Quota-Card/actions/workflows/verify.yml)

为 macOS Codex 客户端侧边栏添加常驻额度卡片，并提供图形助手，在客户端更新后检查 GitHub 补丁版本、热更新助手并协助重新应用卡片。

> **适用客户端：** Bundle ID 为 `com.openai.codex` 的 Codex。部分安装沿用 `ChatGPT.app` 名称；普通 ChatGPT 聊天客户端不在支持范围内。
>
> **当前状态：** `26.1007.21159` 修订4已完成自动检查、专用账户启动及 AMFI（macOS 执行安全检查）补验，并经用户确认卡片、真实额度与登录交互人工验收通过。该结论仅针对当前已验收版本。

## 功能

- **侧边栏额度卡片：** 客户端原生判定为企业类别的账户显示 Monthly 剩余额度、本月已用量与总额度，不限制邮箱域名；其他账户显示 5h、Weekly 剩余额度和重置时间。
- **复用原生数据：** 仅在 ChatGPT 登录方式下显示，使用客户端已有额度状态与 Usage 月额度查询；Monthly 按一分钟周期刷新。
- **图形更新助手：** 查看状态、启停提醒、应用补丁、打开日志与备份，无需手动输入监控命令。
- **助手热更新：** 检测本机客户端变化后，先检查固定 GitHub 仓库的稳定 Release，校验通过后自动切换助手运行文件。
- **可检查、可恢复：** 写入前验证兼容性与完整性，创建备份；应用失败执行回滚，支持单独恢复备份。

卡片只挂载在侧边栏底部，保留左右和底部间距；侧边栏收起时不显示浮动卡片。

## 运行要求

| 项目 | 要求 |
| --- | --- |
| 系统 | macOS，当前分发面向 Apple Silicon |
| 客户端 | `com.openai.codex`；常见路径为 `/Applications/Codex.app` 或 `/Applications/ChatGPT.app` |
| 图形安装器 | arm64 Node.js 22 或更高版本 |
| 单独运行补丁命令 | Node.js 18.15 或更高版本 |
| 网络 | 助手检查和下载 GitHub Release 时需要联网 |

图形安装器检查常见安装路径和当前用户 NVM 目录。缺少兼容 Node.js 时提供官网安装入口，不内嵌 Node，也不自动修改系统环境。

### 当前版本

| 项目 | 值 |
| --- | --- |
| 工具发行版本 / 目标官方版本 | `26.1007.21159` |
| 对应官方构建号 | `20052` |
| 同版本补丁修订 | `releaseRevision: 4` |
| 内部补丁结构标记 | `v8` |

公开版本号、Release tag、ZIP 文件名和安装器版本跟随官方客户端；同一官方版本的补丁改进由 `releaseRevision` 区分。版本号用于记录验证对象，兼容性仍由实际结构、完整性和签名检查决定。

## 安装与使用

### 图形助手

从 [GitHub Releases](https://github.com/Shilem/Chatgpt-Quota-Card/releases) 下载稳定版用户安装器及校验文件：

```text
quota-user-assistant-installer-26.1007.21159-arm64.zip
quota-user-assistant-installer-26.1007.21159-arm64.zip.sha256
```

请下载上面列出的资产，源码 ZIP 不是图形安装器。[Actions](https://github.com/Shilem/Chatgpt-Quota-Card/actions/workflows/verify.yml) 的 `candidate-package` 仍是候选材料，不能替代稳定 Release。

1. 确认下载来源，在 ZIP 所在目录核对 SHA-256：
   ```bash
   shasum -a 256 -c quota-user-assistant-installer-26.1007.21159-arm64.zip.sha256
   ```
2. 解压，双击“额度卡片更新助手安装器.app”，选择客户端并确认安装。
3. 打开 `~/Applications/额度卡片更新助手.app`。
4. 首次安装卡片时选择“应用补丁”，按终端与弹窗提示操作。

安装只记录当前客户端基线，**基线一致不代表卡片已经安装**。关闭管理窗口不会停止后台提醒；可在窗口中停用。

### 客户端更新后会发生什么？

助手每 5 分钟观察所选客户端。变化连续观察两次、至少间隔一分钟后：

1. 查询固定仓库 `Shilem/Chatgpt-Quota-Card` 的已发布、非预发布 Release。
2. 有可用更新时，自动下载纯补丁包；检查资产来源、SHA-256、归档路径与类型、运行文件白名单、清单版本及自检结果，再原子切换到新助手。
3. 提醒用户处理卡片。选择“应用补丁”后再次检查 GitHub 与客户端兼容性，并显示风险确认。
4. 用户确认后正常退出客户端，重新核对内容、执行补丁和备份、复查成功，再请求启动同一路径的客户端。

**助手升级无需确认；退出客户端和写入补丁必须由用户确认。** 用户取消时不会退出客户端。不能正常退出、客户端仍在变化或补丁失败时会停止，不强制杀进程。

同版本 Release 的 ZIP 变化也会检查修订号，拒绝已建立基线后的同修订替换或修订回退。更新失败保留旧运行目录，并暂停应用补丁；窗口和日志显示原因。待处理变化每小时复查 GitHub，也可手动立即检查。

助手不下载或更新官方客户端，不调用 AI 自动修复，也不自动发布。遇到不兼容版本，需要维护者适配并发布新补丁。

### 只使用补丁包

纯补丁包为 `codex-quota-card-patcher-26.1007.21159.zip` 及对应 `.zip.sha256`。解压后双击：

- `应用企业月额度卡片.command`：介绍修改范围、风险与备份位置，输入 `y` 才执行。
- `恢复额度卡片备份.command`：选择并校验备份后恢复。

这两个入口不会自动退出或重启客户端，操作前须用 Command+Q 完全退出。整个解压目录可以移动或改名。

终端用法：

```bash
node bin/patch-codex-quota-card.mjs check --app /Applications/Codex.app
node bin/patch-codex-quota-card.mjs apply --app /Applications/Codex.app
```

将路径替换为实际客户端位置。双击入口也可通过 `CODEX_PATCH_APP` 指定路径。

## 备份与恢复

图形助手的状态、日志和补丁备份位于：

```text
~/Library/Application Support/Chatgpt-Quota-Card/user-assistant/
```

单独运行补丁时，备份默认放在发行目录的 `backups/`；具体位置以操作输出为准。每份备份包含完整 ASAR，可能占用数百 MiB，请保留至少一份可用备份。

```bash
node bin/patch-codex-quota-card.mjs validate-backup --app /Applications/Codex.app --backup /path/to/backup
node bin/patch-codex-quota-card.mjs restore --app /Applications/Codex.app --backup /path/to/backup
```

只接受本工具生成且完整校验通过的 v2 备份。恢复可以还原文件内容，**不能恢复 OpenAI 官方发布签名**；需要官方签名时请重新安装官方客户端。

## 安全与限制

本项目修改客户端生产包，应用后使用本机临时签名。当前没有 Apple Developer ID，也未公证，macOS 可能拦截安装器或命令入口。确认来源后按系统提示打开，不要关闭 Gatekeeper。

- 签名身份改变可能需要重新登录或授权钥匙串；系统推送与官方自动更新能力不能保证保留。
- SHA-256 和内部清单用于核对完整性，不是独立的维护者发行签名；热更新信任 GitHub HTTPS、仓库及 Release 的控制权限。
- 用户助手可能需要终端自动化权限。提交启动请求不代表客户端已成功启动或卡片数据显示正确。
- 未知版本必须通过语义、ASAR、Electron fuse 和签名结构检查；工具不会因版本号相近就强行应用。
- 临时签名与隔离测试不能替代真实使用验收。完整分发边界见 [NOTICE.md](NOTICE.md)。

## 常见问题

**检查结果是什么意思？**

| 状态 | 含义与操作 |
| --- | --- |
| `ready` | 当前完整检查通过，可以按提示应用 |
| `already-patched` | 已安装且补丁契约有效，无需重复应用 |
| `upgrade-ready` | 已有旧补丁需要升级，可按提示重新应用 |
| 语义、完整性或签名检查失败 | 停止操作，保留错误信息，等待适配或重新安装官方客户端 |

**GitHub 检查失败，能直接用旧补丁吗？**

不能。无权限、网络错误或限流会显示“最新版未知/检查失败”，并暂停应用。确认仓库可访问但尚无稳定 Release 时，可经风险确认检查并应用本机补丁。公开仓库默认匿名检查；私有访问仅可使用接收者自己的已登录 GitHub CLI，不分发维护者凭据。

**为什么客户端更新后签名不通过？**

之前应用过补丁再自动升级，可能留下失效的签名链。`--allow-updated-signature` 仅用于精确识别的这种状态，必须显示“升级后重签资格：符合”；它不是通用签名绕过。资格不符或 ASAR 头部不一致时，请重新安装官方客户端。

**为什么安装后没有提醒？**

安装时的客户端版本被记为基线，无变化时保持安静。首次卡片安装请主动选择“应用补丁”，并确认后台提醒已启用。

**为什么没有额度卡片或 Monthly 显示不可用？**

卡片仅适用于 ChatGPT 登录方式，且显示依赖客户端原生额度数据。企业分类复用原生套餐判定，包含 Enterprise、部分 Business 和教育套餐；不会因为使用公司邮箱就认定为企业账户，也不会将所有付费或 Team 套餐都当作企业类别。读取当前额度状态的 `plan_type`，并向同一 `account_id` 查询 Monthly。月额度接口不可用、缺失、单位不匹配或无限额度不会伪装成 `0%`；若预期数据与原生 Usage 页面不一致，请提交脱敏问题报告。旧邮箱判断版 v8 会显示 `upgrade-ready`，需要重新应用补丁才生效。

## 反馈与维护

在 [Issues](https://github.com/Shilem/Chatgpt-Quota-Card/issues) 提交问题时，请说明 macOS 与芯片类型、客户端版本/构建号、助手发行版本和错误阶段。可附相关错误片段或卡片截图；先遮盖邮箱、账户/工作区 ID、Token、真实用量及个人路径，不要上传完整备份或未经检查的日志。

- [维护与构建说明](https://github.com/Shilem/Chatgpt-Quota-Card/blob/main/maintainer/README.md)：开发者监控、隔离验证、候选打包与发行验收。
- [更新记录](https://github.com/Shilem/Chatgpt-Quota-Card/blob/main/maintainer/CHANGELOG.md)：历史适配与修复。
- [安全及分发声明](NOTICE.md)：临时签名与可信来源边界。
