import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { Context } from "hono";
import { Hono } from "hono";
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

// ---- 路由 ----

const app = new Hono();

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

// POST /:orgId/token — 用授权码换取 access_token
app.post("/:orgId/token", async (c) => {
  const org = getOrg(c);
  if (!org) return c.text("organization not found", 404);

  const body = await c.req.parseBody<{ code: string }>();
  const code = body.code;

  if (!code || typeof code !== "string") {
    return c.json({ error: "invalid_request", error_description: "code is required" }, 400);
  }

  // ⚠ 不要在这里调 topapi/v2/user/getuserinfo：它只认应用内免登的临时码，
  // 对扫码登录的 authCode 恒报 40078，且**提交失败也会作废该 authCode**，
  // 导致后续 userAccessToken 交换报「不合法的临时授权码」（2026-10-28 实测）。
  // 扫码登录的正确解析链：authCode → userAccessToken → users/me → unionId → getbyunionid。
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

  return c.json({
    access_token: data.accessToken,
    token_type: "bearer",
    expires_in: data.expireIn,
  });
});

// GET /:orgId/userinfo — 获取用户信息
app.get("/:orgId/userinfo", async (c) => {
  const org = getOrg(c);
  if (!org) return c.text("organization not found", 404);

  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return c.text("unauthorized", 401);
  }
  const token = auth.slice("Bearer ".length);

  const userResp = await fetch("https://api.dingtalk.com/v1.0/contact/users/me", {
    headers: { "x-acs-dingtalk-access-token": token },
  });

  if (!userResp.ok) {
    const err = await userResp.text();
    console.error("USERINFO 错误:", err);
    return c.text("unauthorized", 401);
  }

  const data = (await userResp.json()) as {
    openId: string;
    nick: string;
    avatarUrl?: string;
    unionId?: string;
  };

  // 回退：sub 用钉钉企业内 userid（非 openId）：消费方（guga-onduty 等）的绑定表/推送目标
  // 都是 userid（通讯录同步而来）。users/me 只给 unionId → 用应用凭证调
  // topapi/user/getbyunionid 换 userid；unionId 缺失或换算失败则回退 openId（消费方 fail-closed）。
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

  return c.json({
    sub,
    name: data.nick,
    email: `${data.openId}@dingtalk.internal`,
    picture: data.avatarUrl ?? "",
  });
});

// ---- 启动 ----

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`适配器运行在 ${info.port} 端口，已加载 ${orgs.length} 个组织。`);
});