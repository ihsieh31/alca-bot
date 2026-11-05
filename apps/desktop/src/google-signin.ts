// 用 Google 帳號啟用遠端 (P10): Google sign-in on the computer with the
// installed-app flow — a one-shot loopback listener on 127.0.0.1 receives the
// redirect (RFC 8252 § 7.3), PKCE S256 binds the code to this process
// (RFC 7636), `state` binds the redirect to this attempt. The ID token comes
// straight from Google's token endpoint over TLS and is handed to the relay
// once (computer.register); nothing from the sign-in is kept except the email
// for display.
import { startGoogleOAuth } from "./google-oauth.ts";

export interface GoogleOAuthConfig {
  /** The Desktop OAuth client ID. */
  clientId: string;
  /**
   * Google issues a client secret for Desktop clients too; its installed-app
   * guide says such a secret is not treated as a secret (it ships with the
   * app). Kept in config.json; sent only to the token endpoint.
   */
  clientSecret?: string;
  authEndpoint: string;
  tokenEndpoint: string;
}

export interface GoogleSignInResult {
  idToken: string;
  email?: string;
}

export interface GoogleSignIn {
  /** Open this in the person's browser. */
  authUrl: string;
  redirectUri: string;
  result: Promise<GoogleSignInResult>;
  cancel(): void;
}

/** Read the email from an ID token we just got from Google over TLS (display only; the relay verifies it). */
export function emailOf(idToken: string): string | undefined {
  try {
    const p = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      email?: unknown;
    };
    return typeof p.email === "string" ? p.email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start a sign-in: listen on a free loopback port, build the authorization
 * URL. `result` settles when Google redirects back (or after `timeoutMs`).
 */
export async function startGoogleSignIn(
  cfg: GoogleOAuthConfig,
  o: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<GoogleSignIn> {
  return startGoogleOAuth(cfg, {
    scopes: ["openid", "email"],
    params: { prompt: "select_account" },
    take: (j) => {
      if (typeof j.id_token !== "string")
        throw new Error(`Google 沒有發出憑證（${typeof j.error === "string" ? j.error : "沒有 ID token"}）`);
      const email = emailOf(j.id_token);
      return { idToken: j.id_token, ...(email ? { email } : {}) };
    },
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
}
