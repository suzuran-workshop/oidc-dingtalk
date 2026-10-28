# oidc-dingtalk

钉钉 OIDC Provider —— 将钉钉登录接口转为标准 OIDC 端点，供第三方系统以标准 OIDC 协议对接钉钉身份认证。

## 这是什么？

- 定位：钉钉身份认证的标准 OIDC Provider（Authorization Code Flow）
- 解决的核心问题：第三方系统（homura 应用、Nextcloud、Keycloak 等）无法直接对接钉钉私有的登录 API，本项目将其包装为标准 OIDC 端点（authorize / token+id_token / userinfo / discovery）

## 为什么存在？

- 钉钉开放平台的授权登录接口（`login.dingtalk.com/oauth2/auth` + `api.dingtalk.com/v1.0/oauth2/userAccessToken`）与标准 OIDC Provider 的端点存在差异（如 token 端点用 POST body 而非 `Authorization` header、userinfo 端点用自定义 header `x-acs-dingtalk-access-token` 而非标准 Bearer Token、身份解析链需要 unionId→userid 换算）。本项目作为中间层屏蔽这些差异，让任何支持标准 OIDC 的系统都能无感对接钉钉。
- v2.0.0（2026-10-28）从纯 OAuth2 适配器升级为 OIDC Provider：token 端点签发签名的 `id_token`（`sub` = 钉钉企业 userid，语义锚定），并暴露 discovery 文档。

## 如何安装和运行？

- 前置要求：Node.js >= 24 (LTS)、pnpm >= 11
- 安装步骤：

```bash
pnpm install
cp config.example.yml config.yml  # 然后编辑 config.yml 填入钉钉应用凭据
```

- 填写 `config.yml` 中的组织凭据：

  ```yaml
  port: 28081

  orgs:
    - id: my_org           # 组织标识，会出现在 URL 路径中
      corpId: ding...      # 钉钉 CorpID
      clientId: ding...    # 钉钉 AppKey
      clientSecret: ...    # 钉钉 AppSecret（同时用作 id_token 的 HS256 签名密钥）
      redirectUri: https://example.com/api/oauth/callback  # 第三方系统的回调地址
  ```

  > 一个 `config.yml` 可配置多个组织，每个组织使用独立的凭据。`id` 会出现在 URL 中（`/<orgId>/authorize`）。
  > 凭据取自钉钉开放平台「企业内部应用」，需在钉钉后台登记回调地址，并开通 Contact.User.Read 权限。

- 配置 OIDC 客户端：

  - issuer：`https://dingtalk.auth.xrl.im/<orgId>`
  - discovery：`https://dingtalk.auth.xrl.im/<orgId>/.well-known/openid-configuration`
  - Client ID / Secret：对应组织的 `clientId` / `clientSecret`
  - Scopes：openid

- 运行 / 启动：

```bash
pnpm dev    # 开发模式（热重载）
pnpm build  # 编译
pnpm start  # 启动编译产物
```

### 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/:orgId/.well-known/openid-configuration` | OIDC discovery |
| GET | `/:orgId/authorize` | 重定向到钉钉授权页 |
| POST | `/:orgId/token` | 授权码换 access_token + **id_token**（HS256，sub=userid） |
| GET | `/:orgId/userinfo` | Bearer Token 获取用户信息（sub 与 id_token 同源） |

### 身份语义（关键契约）

- `sub` = 钉钉**企业内 userid**（解析链：userAccessToken → users/me → unionId → getbyunionid → userid；失败回退 openId）。消费方的绑定表/目录表都以 userid 为锚。
- id_token 与 userinfo 的 `sub` 同源同值，客户端可交叉核对。
- 不支持 nonce：钉钉的 code 直达消费方回调、本服务无状态，无法把 nonce 绑进 id_token；受众(aud)+HS256 签名+全链 TLS 对自用场景已足。

## 当前状态

- 阶段：稳定（v2.0.0，OIDC 完整可用）
- 已知限制：仅支持 Authorization Code Flow；不支持 Refresh Token / Client Credentials / JWK 轮换（HS256 共享密钥）。

## 核心技术

- Hono — 轻量高性能 Web 框架
- @hono/node-server — Hono 的 Node.js 适配器
- jose — id_token 签发（HS256）
- TypeScript — 类型安全
- 原生 `fetch` — 零外部 HTTP 依赖

详细架构与决策记录见 `docs/`。
