// 用 Google 登入 on the computer through the phone site (P12): no Desktop
// OAuth client and no client secret. The computer listens once on a random
// 127.0.0.1 port and opens `<site>/computer-signin?state=…&port=…` in the
// system browser; the site signs in with Google using its Web client (nonce
// bound to `state`) and sends the browser on, top level, to
// `http://127.0.0.1:<port>/google-callback#id_token=…&state=…`. A fragment is
// never sent to a server, so the callback page posts it back to this
// listener from its own origin. The computer checks the state (constant
// time), the nonce, the audience and the expiry, then hands the token to the
// relay once (which checks Google's signature and `aud`).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GoogleSignIn, GoogleSignInResult } from "./google-signin.ts";

export interface SiteSignInConfig {
  /** The phone site (https://…; http only on loopback for tests). */
  siteUrl: string;
  /** The site's Google Web client ID (checked against the token's `aud` when known). */
  clientId?: string | undefined;
}

/** The nonce the site asks Google for: binds the ID token to this one `state`. */
export function nonceForState(state: string): string {
  return createHash("sha256").update(`alca-link/v1 computer-signin ${state}`).digest("base64url");
}

/** Claims we check before the relay sees the token (it verifies the signature). */
export function claimsOf(idToken: string): Record<string, unknown> | undefined {
  try {
    const c = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as unknown;
    return c && typeof c === "object" ? (c as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const SHELL = (title: string, body: string, script = "") => `<!doctype html>
<html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alca</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#ededed;
font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif}
main{max-width:360px;padding:32px;text-align:center}b{display:block;margin-bottom:24px;font-size:13px;letter-spacing:.32em;color:#8a8a8a}
h1{margin:0 0 8px;font-size:22px;font-weight:600}p{margin:0;color:#a3a3a3}
</style></head><body><main><b>ALCA</b><h1 id="t">${title}</h1><p id="p">${body}</p></main>${script}</body></html>`;

// Reads the fragment, clears it, posts it to this listener and shows the answer.
const CALLBACK_JS = `
const f = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const t = document.getElementById("t"), p = document.getElementById("p");
fetch("/google-callback", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ id_token: f.get("id_token") || "", state: f.get("state") || "", error: f.get("error") || "" }) })
  .then((r) => r.json()).then((j) => { t.textContent = j.title; p.textContent = j.body; })
  .catch(() => { t.textContent = "登入沒有完成"; p.textContent = "請回到 Alca 再試一次。"; });
`;
const CALLBACK_HASH = `'sha256-${createHash("sha256").update(CALLBACK_JS).digest("base64")}'`;

/** Start a sign-in through the site; `result` settles when the browser comes back (or after `timeoutMs`). */
export async function startSiteSignIn(
  cfg: SiteSignInConfig,
  o: { timeoutMs?: number; now?: () => number } = {},
): Promise<GoogleSignIn> {
  const state = randomBytes(24).toString("base64url");
  const nonce = nonceForState(state);
  let settle!: { ok: (r: GoogleSignInResult) => void; fail: (e: Error) => void };
  const result = new Promise<GoogleSignInResult>((ok, fail) => {
    settle = { ok, fail };
  });
  result.catch(() => undefined);
  let done = false;
  let port = 0;
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const head = {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };
    if (u.pathname !== "/google-callback") return void res.writeHead(404, head).end();
    if (req.method === "GET") {
      res.writeHead(200, {
        ...head,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src ${CALLBACK_HASH}; connect-src 'self'`,
      });
      return void res.end(SHELL("正在完成登入…", "", `<script>${CALLBACK_JS}</script>`));
    }
    const answer = (status: number, title: string, body: string) => {
      res.writeHead(status, { ...head, "content-type": "application/json" });
      res.end(JSON.stringify({ title, body }));
    };
    // Only our own callback page may post (same origin, JSON): not another site in the browser.
    if (
      req.method !== "POST" ||
      req.headers.origin !== `http://127.0.0.1:${port}` ||
      !String(req.headers["content-type"] ?? "").startsWith("application/json")
    )
      return answer(403, "這不是這次的登入", "請回到 Alca 再試一次。");
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      raw += c;
      if (raw.length > 16_384) req.destroy();
    });
    req.on("end", () => {
      let b: { id_token?: unknown; state?: unknown; error?: unknown };
      try {
        b = JSON.parse(raw) as typeof b;
      } catch {
        return answer(400, "這不是這次的登入", "請回到 Alca 再試一次。");
      }
      // Anything without our state is not this sign-in (stray or forged): ignore it, keep waiting.
      if (done || typeof b.state !== "string" || !same(b.state, state))
        return answer(400, "這不是這次的登入", "請回到 Alca 再試一次。");
      if (typeof b.error === "string" && b.error) {
        answer(200, "沒有完成登入", "可以關掉這個分頁，回到 Alca。");
        return finish(
          new Error(b.error === "access_denied" ? "你取消了 Google 登入" : `Google 登入失敗（${b.error}）`),
        );
      }
      const token = typeof b.id_token === "string" ? b.id_token : "";
      const why = check(token);
      if (why) {
        answer(200, "登入沒有完成", "Google 的憑證不對，請回到 Alca 再試一次。");
        return finish(new Error(why));
      }
      answer(200, "已登入", "可以關掉這個分頁，回到 Alca 的電腦畫面。");
      const email = claimsOf(token)?.email;
      finish(undefined, { idToken: token, ...(typeof email === "string" ? { email } : {}) });
    });
  });
  await new Promise<void>((r, j) => {
    server.once("error", j);
    server.listen(0, "127.0.0.1", () => r());
  });
  port = (server.address() as AddressInfo).port;
  const timer = setTimeout(() => finish(new Error("Google 登入逾時，請再試一次")), o.timeoutMs ?? 5 * 60_000);
  timer.unref();

  function check(token: string): string | undefined {
    const c = claimsOf(token);
    if (!c) return "Google 沒有發出憑證";
    if (c.nonce !== nonce) return "Google 登入的 nonce 不符（不是這次的登入）";
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (cfg.clientId && !aud.includes(cfg.clientId)) return "Google 憑證不是發給 Alca 網站的";
    const now = (o.now?.() ?? Date.now()) / 1000;
    if (typeof c.exp !== "number" || c.exp < now - 60) return "Google 憑證已過期";
    return undefined;
  }

  function finish(e: Error | undefined, r?: GoogleSignInResult) {
    clearTimeout(timer);
    done = true;
    setTimeout(() => server.close(), 200).unref();
    server.closeIdleConnections?.();
    if (e) settle.fail(e);
    else if (r) settle.ok(r);
  }

  const site = new URL(cfg.siteUrl);
  site.pathname = `${site.pathname.replace(/\/$/, "")}/computer-signin`;
  site.search = new URLSearchParams({ state, port: String(port) }).toString();
  site.hash = "";
  return {
    authUrl: site.toString(),
    redirectUri: `http://127.0.0.1:${port}/google-callback`,
    result,
    cancel: () => {
      if (!done) finish(new Error("已取消"));
    },
  };
}
