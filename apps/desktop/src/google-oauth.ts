import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GoogleOAuthConfig } from "./google-signin.ts";

// Google's installed-app OAuth flow (RFC 8252 § 7.3 loopback redirect, RFC
// 7636 PKCE S256, `state` bound to the attempt). Used only by 用 Google 帳號
// 啟用遠端 (P10, an ID token for the relay); Gmail / Calendar are read through
// Composio, never with this client (Google direct was removed 2026-11-05). The
// client is always the person's own (config.json or $ALCA_GOOGLE_CLIENT_ID).

const b64u = (b: Buffer) => b.toString("base64url");

const page = (title: string, body: string) => `<!doctype html>
<html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#ededed;
font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif}
main{max-width:360px;padding:32px;text-align:center}b{display:block;margin-bottom:24px;font-size:13px;letter-spacing:.32em;color:#8a8a8a}
h1{margin:0 0 8px;font-size:22px;font-weight:600}p{margin:0;color:#a3a3a3}
</style></head><body><main><b>ALCA</b><h1>${title}</h1><p>${body}</p></main></body></html>`;

/** What Google's token endpoint answered (the caller picks what it needs). */
export interface GoogleTokenAnswer {
  id_token?: unknown;
  error?: unknown;
}

export interface GoogleOAuthFlow<T> {
  /** Open this in the person's browser. */
  authUrl: string;
  redirectUri: string;
  result: Promise<T>;
  cancel(): void;
}

/**
 * The installed-app flow of 用 Google 帳號啟用遠端: listen on a free
 * loopback port, build the authorization URL with PKCE S256 and `state`.
 * `result` settles when Google redirects back (or after `timeoutMs`) with
 * whatever `take` makes of the token answer (it throws to refuse it).
 */
export async function startGoogleOAuth<T>(
  cfg: GoogleOAuthConfig,
  o: {
    scopes: readonly string[];
    /** Extra authorization parameters (prompt). */
    params?: Record<string, string>;
    take: (j: GoogleTokenAnswer) => T;
    timeoutMs?: number;
    fetch?: typeof fetch;
  },
): Promise<GoogleOAuthFlow<T>> {
  const verifier = b64u(randomBytes(48)); // 64 characters, within RFC 7636's 43–128
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const state = b64u(randomBytes(24));
  let settle!: { ok: (r: T) => void; fail: (e: Error) => void };
  const result = new Promise<T>((ok, fail) => {
    settle = { ok, fail };
  });
  result.catch(() => undefined);
  let done = false;
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/" || done) return void res.writeHead(404).end();
    const answer = (status: number, title: string, body: string) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "referrer-policy": "no-referrer",
      });
      res.end(page(title, body));
    };
    // Anything without our state is not this sign-in (a stray or forged request): ignore it.
    if (u.searchParams.get("state") !== state)
      return answer(400, "這不是這次的登入", "請回到 Alca 再試一次。");
    done = true;
    const err = u.searchParams.get("error");
    const code = u.searchParams.get("code");
    if (err || !code) {
      answer(200, "沒有完成登入", "可以關掉這個分頁，回到 Alca。");
      finish(
        new Error(
          err === "access_denied" ? "你取消了 Google 登入" : `Google 登入失敗（${err ?? "沒有授權碼"}）`,
        ),
      );
      return;
    }
    void exchange(code).then(
      (r) => {
        answer(200, "已登入", "可以關掉這個分頁，回到 Alca 的電腦畫面。");
        finish(undefined, r);
      },
      (e: Error) => {
        answer(200, "登入沒有完成", "Google 沒有發出憑證，請回到 Alca 再試一次。");
        finish(e);
      },
    );
  });
  await new Promise<void>((r, j) => {
    server.once("error", j);
    server.listen(0, "127.0.0.1", () => r());
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const timer = setTimeout(() => finish(new Error("Google 登入逾時，請再試一次")), o.timeoutMs ?? 5 * 60_000);
  timer.unref();

  function finish(e: Error | undefined, r?: T) {
    clearTimeout(timer);
    done = true;
    // Let the answer page leave before the listener goes.
    setTimeout(() => server.close(), 200).unref();
    server.closeIdleConnections?.();
    if (e) settle.fail(e);
    else if (r) settle.ok(r);
  }

  async function exchange(code: string): Promise<T> {
    const body = new URLSearchParams({
      code,
      client_id: cfg.clientId,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
    });
    const res = await (o.fetch ?? fetch)(cfg.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    const j = (await res.json().catch(() => ({}))) as GoogleTokenAnswer;
    if (!res.ok)
      throw new Error(
        `Google 沒有發出憑證（${typeof j.error === "string" ? j.error : `HTTP ${res.status}`}）`,
      );
    return o.take(j);
  }

  const auth = new URL(cfg.authEndpoint);
  auth.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: o.scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(o.params ?? {}),
  }).toString();
  return {
    authUrl: auth.toString(),
    redirectUri,
    result,
    cancel: () => {
      if (!done) finish(new Error("已取消"));
    },
  };
}
