import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { Context } from "hono";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { parse } from "yaml";

// ---- 类型 ----

interface OrgConfig {
  id: string;
  corpId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// ---- 配置加载 ----

const configRaw = readFileSync(resolve("config.yml"), "utf-8");
const { port = 28081, orgs } = parse(configRaw) as { port?: number; orgs: OrgConfig[] };

const orgMap = new Map<string, OrgConfig>();
for (const org of orgs) {
  orgMap.set(org.id, org);
}

// ---- 工具函数 ----

/**
 * issuer 基座 —— 反代（nginx TLS 卸载）后 c.req.url 的 scheme 是 http，
 * 必须优先取 X-Forwarded-Proto，否则 discovery 的 issuer 与 id_token 的 iss
 * 都会变成 http://，客户端（强制验签 iss=issuer）将验签失败。
 */
function issuerBase(c: Context, orgId: string): string {
  const url = new URL(c.req.url);
  const proto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ||
    url.protocol.replace(":", "");
  return new URL(`${proto}://${url.host}/${orgId}`).toString().replace(/\/$/, "");
}

function getOrg(c: Context): OrgConfig | null {
  const orgId = c.req.param("orgId");
  if (!orgId) return null;
  return orgMap.get(orgId) ?? null;
}

/**
 * 企业 access_token（AppKey/AppSecret 换取），供 getbyunionid 等 topapi 使用。
 * 注意：topapi/v2/user/getuserinfo 只认应用内免登临时码，不认扫码登录 authCode，
 * 且提交失败会作废该码——不要用它解析扫码登录身份（2026-10-28 实测）。
 */
async function getCorpAccessToken(org: OrgConfig): Promise<string | null> {
  const resp = await fetch(
    `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(org.clientId)}&appsecret=${encodeURIComponent(org.clientSecret)}`,
  );
  const j = (await resp.json()) as { access_token?: string; errcode?: number };
  return j.errcode === 0 && j.access_token ? j.access_token : null;
}

interface DingtalkIdentity {
  sub: string; // 钉钉企业内 userid（回退 openId）
  name: string;
  picture: string;
  openId: string;
}

/**
 * 钉钉身份解析链（2026-10-28 实测定型的唯一正确路径）：
 * userAccessToken → contact/users/me → unionId → topapi/user/getbyunionid → 企业 userid。
 * ⚠ 不要用 topapi/v2/user/getuserinfo：它只认应用内免登临时码，对扫码 authCode 恒报
 *   40078 且提交失败也会作废该码。
 */
async function resolveIdentity(
  org: OrgConfig,
  userAccessToken: string,
): Promise<DingtalkIdentity | null> {
  const userResp = await fetch("https://api.dingtalk.com/v1.0/contact/users/me", {
    headers: { "x-acs-dingtalk-access-token": userAccessToken },
  });
  if (!userResp.ok) {
    console.error("users/me 错误:", await userResp.text());
    return null;
  }
  const data = (await userResp.json()) as {
    openId: string;
    nick: string;
    avatarUrl?: string;
    unionId?: string;
  };

  let sub = data.openId;
  try {
    if (data.unionId) {
      const at = await getCorpAccessToken(org);
      if (at) {
        const r = await fetch(
          `https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(at)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ unionid: data.unionId }),
          },
        );
        const j = (await r.json()) as { errcode?: number; result?: { userid?: string } };
        if (j.errcode === 0 && j.result?.userid) sub = j.result.userid;
        else console.error("getbyunionid 失败:", JSON.stringify(j));
      } else {
        console.error("gettoken 失败，sub 回退 openId");
      }
    } else {
      console.error("users/me 未返回 unionId，sub 回退 openId");
    }
  } catch (e) {
    console.error("userid 解析异常（回退 openId）:", e);
  }

  return {
    sub,
    name: data.nick,
    picture: data.avatarUrl ?? "",
    openId: data.openId,
  };
}

// ---- 路由 ----

const app = new Hono();

// GET /:orgId/.well-known/openid-configuration — OIDC 发现文档
app.get("/:orgId/.well-known/openid-configuration", (c) => {
  const org = getOrg(c);
  if (!org) return c.text("organization not found", 404);

  const issuer = issuerBase(c, org.id);

  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["HS256"],
    scopes_supported: ["openid"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    claims_supported: ["iss", "sub", "aud", "exp", "iat", "name", "picture"],
  });
});

// GET /:orgId/authorize — 重定向到钉钉授权页
app.get("/:orgId/authorize", (c) => {
  const org = getOrg(c);
  if (!org) return c.text("organization not found", 404);

  const state = c.req.query("state") ?? "";
  const url = new URL("https://login.dingtalk.com/oauth2/auth");
  url.searchParams.append("redirect_uri", org.redirectUri);
  url.searchParams.append("response_type", "code");
  url.searchParams.append("client_id", org.clientId);
  url.searchParams.append("scope", "openid");
  url.searchParams.append("prompt", "consent");
  url.searchParams.append("state", state);
  return c.redirect(url.toString());
});

// POST /:orgId/token — 用授权码换取 access_token + id_token（OIDC）
app.post("/:orgId/token", async (c) => {
  const org = getOrg(c);
  if (!org) return c.text("organization not found", 404);

  const body = await c.req.parseBody<{ code: string }>();
  const code = body.code;

  if (!code || typeof code !== "string") {
    return c.json({ error: "invalid_request", error_description: "code is required" }, 400);
  }

  const tokenResp = await fetch(
    "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: org.clientId,
        clientSecret: org.clientSecret,
        code,
        grantType: "authorization_code",
      }),
    },
  );

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    console.error("TOKEN 错误:", err);
    return c.json({ error: "token failed" }, 400);
  }

  const data = (await tokenResp.json()) as {
    accessToken: string;
    expireIn: number;
  };

  // id_token 在 token 时点签发：sub 已解析为企业 userid（与 userinfo 同一解析链）。
  // 签名 HS256（MAC：org.clientSecret）——自用单部署，零密钥运维；RS256 的轮换收益不存在。
  // nonce 不支持：DingTalk 的 code 直达 App 回调、本服务无状态，无法把 nonce 绑进 id_token；
  // 受众(aud)+签名+全链 TLS 对自用场景已足。
  let idToken: string | undefined;
  try {
    const identity = await resolveIdentity(org, data.accessToken);
    if (identity) {
      const now = Math.floor(Date.now() / 1000);
      const issuer = issuerBase(c, org.id);
      idToken = await new SignJWT({
        name: identity.name,
        picture: identity.picture,
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(issuer.toString().replace(/\/$/, ""))
        .setSubject(identity.sub)
        .setAudience(org.clientId)
        .setIssuedAt(now)
        .setExpirationTime(now + data.expireIn)
        .sign(new TextEncoder().encode(org.clientSecret));
    } else {
      console.error("identity 解析失败，token 响应缺 id_token");
    }
  } catch (e) {
    // id_token 签发失败不阻塞 access_token 发放（userinfo 仍可用），但客户端验签将失败
    console.error("id_token 签发异常:", e);
  }

  return c.json({
    access_token: data.accessToken,
    token_type: "bearer",
    expires_in: data.expireIn,
    ...(idToken ? { id_token: idToken } : {}),
  });
});

// GET /:orgId/userinfo — 获取用户信息（与 id_token 同一解析链）
app.get("/:orgId/userinfo", async (c) => {
  const org = getOrg(c);
  if (!org) return c.text("organization not found", 404);

  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return c.text("unauthorized", 401);
  }
  const token = auth.slice("Bearer ".length);

  const identity = await resolveIdentity(org, token);
  if (!identity) {
    return c.text("unauthorized", 401);
  }

  return c.json({
    sub: identity.sub,
    name: identity.name,
    email: `${identity.openId}@dingtalk.internal`,
    picture: identity.picture,
  });
});

// ---- 启动 ----

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`OIDC 适配器运行在 ${info.port} 端口，已加载 ${orgs.length} 个组织。`);
});
