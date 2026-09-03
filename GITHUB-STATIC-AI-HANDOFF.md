# GitHub 静态版与飞书 AI 交接

## 当前默认

默认分享入口是 `https://maxi-max-dev.github.io/ops/`。它是纯静态构建：匿名访问、无需安装、无需运行自有服务，演示数据和交互只存在于浏览器本地。Base 仍是 LIVE 任务的唯一真源，公开页面不读取或复制任何私有 Base 数据。

## `Command/Ctrl + K`

- 未保存 Base 快捷入口：打开本地 Preview 输入框，只修改当前浏览器里的脱敏演示。
- 已保存 Base 快捷入口：打开用户自己保存的 Base；进入 Base 后再点右上角 `问问 AI`。这不代表 Agent 已获得数据权限。
- 所有者私人启动链接：打开其自己的 Base；访问仍由 Base 权限决定。
- LIVE fresh-copy 运行态：直接交接到该运行态确认过的 Base URL。

## 普通用户的目标接入

公开页面右上角提供 `接入数据与 Agent`，主路径被收敛为两步：

1. `用飞书登录并创建`：进入飞书授权页；授权完成后，在用户自己的租户创建或复制一套 OPS Base 工作区；
2. 给 Agent 命名并复制一行配对指令：Agent 自行取得一次性、限域的配对入口，注册到 Agent 名册，并把 start/progress/question/artifact/finish 与 feedback claim/ack/receipt 写回同一份 Base。

用户不应创建表、填写 App Secret，或理解 `message_id`、`instance_id`、`task_id`、`agent_id`、`run_id`。这些标识由安装器、模板和 Connector 内部解析。

这条目标路径需要一个**非公开飞书商店应用**和一个最小 OAuth 回调服务。Beta 代码已实现 OAuth、五表创建与自动发现、同 Base 看板读写、一次性 Agent 配对、progress receipt 和撤销；飞书创建的开放平台应用属于机密客户端，授权码换取用户令牌需要 `client_secret`，所以纯 GitHub Pages 无法安全独立完成跨租户一键安装。当前商店安装链接与 OAuth 回调尚未获发布授权；页面主按钮会失败关闭并明确披露，不伪装成功。实现与未验证项见 [`docs/ONE-CLICK-BETA.md`](./docs/ONE-CLICK-BETA.md)。

私人 LIVE canary 和通用 Connector 已经跑通。当前新增的是普通人接入界面和机器可读安装合同，见 [`docs/feishu-onboarding-contract.json`](./docs/feishu-onboarding-contract.json)。

完全无托管仍保留在“已有 Base / 技术模式”：复制五表模板、自建飞书应用、把 App Secret 留在本机、安装 Connector。它能工作，但不再被描述为普通人主路径。

用户仍可在技术模式把 `https://example.feishu.cn/base/BASE_TOKEN` 粘贴到页面，作为当前浏览器的快捷入口。它只在 `localStorage` 保存一个 Base 地址，不读取 Base 数据，也不授予 Agent 权限。保存后，底部命令栏会显示 `去飞书「问问 AI」`，`Command/Ctrl + K` 打开用户自己的 Base。

私人启动链接格式：

```text
https://maxi-max-dev.github.io/ops/#feishu-ai=https%3A%2F%2Fmy.feishu.cn%2Fbase%2Fexample%3Ftable%3Dtasks
```

解析器只接受 URL fragment 中名为 `feishu-ai` 的值，并且目标必须同时满足：

1. `https:`；
2. 主机是 `feishu.cn` 或它的子域名（例如 `my.feishu.cn`、`your-team.feishu.cn`）；
3. 路径以 `/base/` 开头。

无效值会被忽略，页面退回普通公开 Preview。真实 Base locator 不写入源代码或静态产物。URL fragment 不随 HTTP 请求发送到 GitHub Pages，但拿到私人启动链接的人仍能看到其中的 Base 地址；Base 自身权限继续决定是否可访问。用户也可在接入向导中移除当前设备保存的 Base。

## 诚实边界

飞书 Base 的 AI 侧栏开合状态没有可复用的 URL。静态页因此不能声称一键直接打开侧栏，也不能在匿名访客没有飞书登录和 Base 权限时让飞书 AI 处理私人任务。当前已接入用户的最短可靠路径是：静态页按 `Command/Ctrl + K` → 打开自己的 Base → 点 `问问 AI`。

飞书 AI Agent 可以使用表格工具、消息、记忆和自定义 MCP 做自然语言读写与工作流；它不自动替 OPS 设计完整页面。今天 / 项目 / 动态、项目详情和 Agent 名册由 Base 模板或飞书应用预置，AI 负责其中的数据操作与整理。

如果要让评委真正操作飞书 AI，需要另行分享一个脱敏 Base/智能体并确认可见范围；这属于权限配置，不由公开静态页暗中扩大。

## 验证

```bash
npm test
npm run lint
npm run build:pages
```

相关测试：

- `tests/feishu-ai-handoff.test.mjs`：目标 URL allowlist 与私有 locator 泄漏检查。
- `tests/feishu-embedded-ui.test.mjs`：快捷键和 UI 边界。
- `tests/feishu-onboarding.test.mjs`：安装链接失败关闭、Agent 命名与无内部 ID 的配对指令。
- `tests/one-click-onboarding.test.mjs`：五表契约、OAuth 跳转、本地完整安装、单次配对、Base progress receipt、幂等和立即撤销。
- `tests/rendered-html.test.mjs`：服务端渲染文案回归。
