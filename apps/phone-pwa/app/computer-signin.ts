// /computer-signin (P12): the computer's Google sign-in, done by this site
// with its Web client so the computer needs no OAuth client or secret.
//
//   computer → opens <site>/computer-signin?state=S&port=P in the system browser
//   this page → Google (OIDC implicit, response_type id_token,
//               nonce = b64u(SHA-256("alca-link/v1 computer-signin " ‖ S)),
//               OAuth state = "c." ‖ S, redirect_uri = <site>/)
//   back at <site>/#id_token=…&state=c.S → checks S against what it stored,
//               the nonce, the port → top-level to
//               http://127.0.0.1:P/google-callback#id_token=…&state=S
//
// The computer checks the state and the nonce again; the relay checks
// Google's signature and that `aud` is this site's client. Nothing here is
// kept: the pending entry lives in sessionStorage for one round trip.

import { t } from "./i18n/index.ts";
import { userFromToken } from "./idtoken.ts";

export const CS_KEY = "alca.csignin";
const PREFIX = "c.";

export interface ComputerSignIn {
  state: string;
  port: number;
}

/** `?state=…&port=…` from the computer, or undefined when either is malformed. */
export function computerParams(search: string): ComputerSignIn | undefined {
  const q = new URLSearchParams(search);
  const state = q.get("state") ?? "";
  const port = Number(q.get("port"));
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(state)) return undefined;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return undefined;
  return { state, port };
}

export async function nonceFor(state: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`alca-link/v1 computer-signin ${state}`),
  );
  let s = "";
  for (const b of new Uint8Array(d)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The Google URL for this sign-in (the page stores `p` before going). */
export async function googleUrl(clientId: string, origin: string, p: ComputerSignIn): Promise<string> {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/`,
    response_type: "id_token",
    scope: "openid email",
    nonce: await nonceFor(p.state),
    state: `${PREFIX}${p.state}`,
    prompt: "select_account",
  }).toString();
  return u.toString();
}

export const loopbackUrl = (port: number, f: Record<string, string>): string =>
  `http://127.0.0.1:${port}/google-callback#${new URLSearchParams(f).toString()}`;

export type ReturnResult = { go: string } | { error: string };

/**
 * Back from Google with `#…&state=c.S`: where to send the browser (the
 * computer's loopback port), or why not. undefined = not a computer sign-in.
 */
export async function computerReturn(
  hash: string,
  pendingRaw: string | null,
): Promise<ReturnResult | undefined> {
  const f = new URLSearchParams(hash.replace(/^#/, ""));
  const st = f.get("state") ?? "";
  if (!st.startsWith(PREFIX)) return undefined;
  let p: ComputerSignIn | undefined;
  try {
    const v = JSON.parse(pendingRaw ?? "null") as { state?: unknown; port?: unknown } | null;
    p = v ? computerParams(`?state=${String(v.state)}&port=${String(v.port)}`) : undefined;
  } catch {
    p = undefined;
  }
  if (!p || p.state !== st.slice(PREFIX.length))
    return { error: t("phone.computerSignin.thisIsntTheCurrentSign") };
  const err = f.get("error");
  if (err) return { go: loopbackUrl(p.port, { error: err, state: p.state }) };
  const token = f.get("id_token") ?? "";
  const u = userFromToken(token) as { nonce?: string } | undefined;
  if (!u || u.nonce !== (await nonceFor(p.state)))
    return { error: t("phone.computerSignin.googlesReplyDidntMatchNonce") };
  return { go: loopbackUrl(p.port, { id_token: token, state: p.state }) };
}
