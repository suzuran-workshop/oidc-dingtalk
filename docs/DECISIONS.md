# DECISIONS

## ADR-001：使用 Hono 替代 Express

- 日期：2026-09-03
- 状态：已采纳
- 背景：原实现使用 Express，项目技术栈规范要求 Web Gateway 层采用 TypeScript + Hono。
- 考虑过的方案：Express（原方案）、Fastify、Hono
- 决策：使用 Hono + @hono/node-server
- 为什么选这个：与项目全局技术栈一致；Hono 轻量、TypeScript 原生支持好、API 简洁；在 Node.js 上通过 @hono/node-server 运行，未来可零改动迁移到 Cloudflare Workers / Bun / Deno。
- 为什么不选其他：Express 无 TypeScript 原生支持、中间件模型较重；Fastify 功能丰富但对本项目的简单透传场景过于重量。
- 后果：依赖从 express + axios 简化为 hono + @hono/node-server，HTTP 请求改用原生 fetch。
- 何时重新审视：如果需要添加中间件（日志、限流、CORS 等）时评估 Hono 内置能力是否足够。

## ADR-002：使用原生 fetch 替代 axios

- 日期：2026-09-03
- 状态：已采纳
- 背景：原实现使用 axios 发起 HTTP 请求。Node.js 18+ 已内置全局 fetch API。
- 考虑过的方案：axios（原方案）、node-fetch、原生 fetch
- 决策：使用原生 fetch
- 为什么选这个：零依赖、无额外包安装；Node 24 LTS 的 fetch 实现已稳定成熟；项目仅需简单的 POST/GET 请求，不需要 axios 的拦截器等高级功能。
- 为什么不选其他：axios 和 node-fetch 都引入了额外依赖，对本项目的简单需求来说不必要。
- 后果：减少一个运行时依赖，package 更精简。
- 何时重新审视：如果需要请求重试、超时控制、拦截器等能力时重新评估。

## ADR-003：expires_in 透传钉钉 expireIn

- 日期：2026-09-03（最初）、2026-10-12（修订）
- 状态：已修订
- 背景：钉钉 token 接口返回 `expireIn`（注意大小写），原实现硬编码返回 `expires_in: 7200`。
- 考虑过的方案：硬编码 7200s（原方案）、透传钉钉返回的 `expireIn`
- 决策：改为透传钉钉实际返回的 `expireIn` 值。
- 为什么选这个：透传更准确地反映 token 实际过期时间，避免与钉钉实际值不一致。
- 后果：`expires_in` 值与钉钉 API 返回值保持一致。
- 何时重新审视：如果钉钉 API 的 `expireIn` 字段发生变更。

## ADR-004：从单组织 .env 配置迁移到多组织 YAML 配置

- 日期：2026-10-12
- 状态：已采纳
- 背景：原实现仅支持单一钉钉组织，凭据通过 `.env` 环境变量注入。用户需要一套服务同时为多个钉钉组织提供 OAuth2 适配。
- 考虑过的方案：环境变量数组（`ORG_1_CLIENT_ID` 等）、TOML 配置、YAML 配置
- 决策：使用 `config.yml` + `yaml` npm 包
- 为什么选这个：YAML 可读性好，支持嵌套结构，天然适合多组织数组配置；`yaml` 包（eemeli）ESM-native，与项目 `"type": "module"` 一致；配置文件可 `.gitignore`，模板文件（`config.example.yml`）可安全提交。
- 为什么不选其他：环境变量数组方案（`ORG_1_*`、`ORG_2_*`）难以维护且不支持动态数量；TOML 功能相近但 JavaScript 生态支持不如 YAML 广泛。
- 后果：路由从 `/oauth/<endpoint>` 变为 `/:orgId/<endpoint>`，向后不兼容；移除 `.env` 依赖，启动脚本不再需要 `--env-file` 参数。
- 何时重新审视：如果未来需要热加载配置，或组织数量达到数百级别需要更高效的查找结构时。

## ADR-005：升级为 OIDC Provider（id_token + discovery），签名选 HS256

- 日期：2026-10-28
- 状态：已采纳（v2.0.0）
- 背景：下游 homura 全链转向 OIDC（客户端做 id_token 验签 + sub 交叉核对），IdP 需从纯
  OAuth2 适配器升级为 OIDC Provider。项目仅自用，无向下兼容负担。
- 考虑过的方案：RS256（JWK + 密钥轮换）、HS256（clientSecret 作 MAC）
- 决策：HS256 签发 id_token（密钥即组织的 clientSecret），token 端点签发，claims 含
  iss/sub/aud/iat/exp/name/picture；新增 `/.well-known/openid-configuration` discovery。
- 为什么选这个：自用单部署下 RS256 的密钥生成/托管/轮换收益不存在，HS256 复用已有
  clientSecret，客户端验签零额外配置；OIDC 规范允许 id_token 用 client secret 做 MAC。
- 为什么不选其他：RS256 引入密钥对生命周期管理（生成、存档、轮换、jwks 端点缓存），
  在单租户自用场景是纯负债。
- 决策之二：不支持 nonce。钉钉的 code 直达消费方回调、本服务无状态（不跟踪 authCode），
  token 端点只收到 code，无法把 authorize 时的 nonce 绑进 id_token。受众校验(aud=clientId)
  + HS256 签名 + 全链 TLS 已覆盖自用场景的威胁模型。
- 后果：token 端点在换 userAccessToken 后即执行身份解析链（users/me→unionid→getbyunionid），
  id_token 的 sub 与 userinfo 同源；identity 解析失败时不阻塞 access_token 发放（仅缺
  id_token），客户端验签自然失败即 fail-closed。package 更名 oidc-dingtalk，版本 2.0.0。
- 何时重新审视：出现多消费方/公网开放、或需要密钥轮换审计时，升级 RS256 + jwks 端点。
