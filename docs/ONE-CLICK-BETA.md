# OPS 一键安装 Beta

## 已实现

`worker/onboarding.ts` 是最小多租户安装边界，`worker/onboarding-contract.mjs` 是可公开携带的脱敏模板。安装服务只保存授权、Base 映射、配对、撤销和首条回执状态；项目、任务、事件、问题、产物和回执始终直接读写用户自己的 Base。

公开 GitHub Pages 继续只承载 React 漂亮看板和脱敏演示。未配置商店应用时，`/api/install/status` 返回 `permission_gate`，按钮不会跳到假授权页，配对按钮保持禁用。

## 运行时配置（不进入仓库）

- `MAXOPS_STORE_APP_ID`：非公开飞书商店应用的客户端 ID。
- `MAXOPS_STORE_APP_SECRET`：只保存在服务端 secret store。
- `MAXOPS_ONBOARDING_KEY`：至少 32 字节，用于 AES-GCM 加密会话和 OAuth/Base 元数据。
- `MAXOPS_INSTALL_PUBLIC_ORIGIN`：正式 HTTPS 自定义域名；生产模式拒绝 `workers.dev` 和 `github.io`。
- `MAXOPS_OAUTH_SCOPES`：商店应用审核通过的最小用户授权 scope 字符串；必须包含 `offline_access`，否则无法安全刷新用户授权，安装器保持失败关闭。

回调地址固定为 `<origin>/api/install/callback`。不要把上述值写入 `wrangler.jsonc` 的公开 `vars`。

## 数据流

1. OAuth v3 换取用户令牌并读取用户/租户身份。
2. 在用户租户新建 Base，创建五表、字段、视图和一条“连接测试”任务，再重新枚举表与字段校验结果。
3. D1 只保存加密后的用户令牌、Base locator 和表字段映射；React 每次向 Base 取数。
4. 配对码只保存 SHA-256，十分钟过期；交换成功后只返回 Agent 专属 bearer 和现有 Connector v2 的 `webhook_write` 配置。
5. Agent 读取明确分配的“连接测试”，用 `maxops-webhook-write/1` 回写 progress；服务从 Base 返回 `event:<event_id>` receipt。
6. 看板允许的任务状态更新写回同一条 Base 记录，并在“产物／回执”表创建回执。
7. 撤销 Agent 后 bearer 立即失效；撤销 OPS 只撤销授权和 Agent，不删除用户 Base。

## 实机保真矩阵

| 表面 | 当前证据 |
|---|---|
| 五表、字段、四视图、连接测试任务 | 本地 mock Feishu OpenAPI canary PASS |
| OAuth state、单次配对、progress receipt、幂等、撤销 | Worker + SQLite 端到端 canary PASS |
| 桌面浏览器公开失败关闭 | PASS |
| 390×844 响应式布局 | PASS（不是移动真机） |
| 第二租户复制 | UNAVAILABLE |
| 飞书原生应用模式 | UNAVAILABLE |
| 飞书 AI Agent | UNAVAILABLE |
| 自动化和跨租户权限 | UNAVAILABLE |
| 桌面真实飞书宿主 | UNAVAILABLE |
| 移动真机 | UNAVAILABLE |
| 中国网络可达性 | UNAVAILABLE |

应用模式、AI Agent、自动化或权限任一项不能随模板保留时，只降级该项；Base + 自动绑定 React 看板 + Agent Connector 不随之回退。

## 发布前命令

```bash
npm test
npm run lint
npm run build:pages
```

正式发布还必须完成第二租户、桌面真实宿主、移动真机、中国网络、权限拒绝和错误恢复 canary。非公开飞书商店应用仍需由项目所有者登录开发者后台后创建和提交。

## 生产承载

用户入口与 OAuth 回调统一使用 `https://install.example`。公开静态 GitHub Pages 继续作为无密钥预览；`wrangler.onboarding.jsonc` 部署独立的 onboarding-only Worker 和独立 D1 元数据库，香港入口只做 HTTPS 反向代理。该 Worker 不暴露私人 OPS API，D1 也只创建 onboarding 三张元数据表，不创建项目或任务副本。

截至 2026-09-01，域名 DNS、香港 Caddy HTTPS、独立 Worker、独立 D1 迁移和 onboarding 加密密钥已部署；`/api/install/status`、公开页面和错误恢复均有真实浏览器／HTTP 证据。商店应用凭据未配置前服务保持 `permission_gate`，`/api/install/start` 返回 503，私人 Agent API 在该 Worker 上返回 404。

## 官方依据

- [飞书应用可用范围](https://open.feishu.cn/document/home/introduction-to-scope-and-authorization/availability.md)
- [获取 OAuth 授权码](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code.md)
- [获取 user access token v3](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3.md)
- [创建多维表格](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app/create.md)
- [新增数据表](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table/create.md)
