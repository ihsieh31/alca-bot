// Google sign-in on the phone site (P10). Google Identity Services renders
// the official button and hands back an ID token (only the client ID is
// used; there is no secret on a static site). The token lives in memory only:
// it is sent to the relay to list this account's computers and to ask one of
// them for approval, and is not needed again once the computer has said yes.
//
// Fallback for browsers where the GIS pop-up cannot come back (some
// home-screen apps): the OpenID Connect implicit redirect (response_type
// id_token, a nonce kept in sessionStorage and checked on return).

import { t as tx } from "./i18n/index.ts";
import { type GoogleUser, userFromToken } from "./idtoken.ts";

export type { GoogleUser } from "./idtoken.ts";
export { tokenFresh, userFromToken } from "./idtoken.ts";

interface GisId {
  initialize(o: Record<string, unknown>): void;
  renderButton(el: HTMLElement, o: Record<string, unknown>): void;
  prompt(): void;
  disableAutoSelect(): void;
}
type GisWindow = { google?: { accounts?: { id?: GisId } } };

const GIS_SRC = "https://accounts.google.com/gsi/client";
let loading: Promise<GisId> | undefined;

/** Load GIS once (a page that already has `google.accounts.id` — e.g. a preview — uses that). */
export function loadGis(timeoutMs = 10_000): Promise<GisId> {
  const have = (window as GisWindow).google?.accounts?.id;
  if (have) return Promise.resolve(have);
  loading ??= new Promise<GisId>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    const t = setTimeout(() => reject(new Error(tx("phone.google.googleSignInTimedOut"))), timeoutMs);
    s.onload = () => {
      clearTimeout(t);
      const id = (window as GisWindow).google?.accounts?.id;
      if (id) resolve(id);
      else reject(new Error(tx("phone.google.googleSignInIsntAvailable")));
    };
    s.onerror = () => {
      clearTimeout(t);
      loading = undefined;
      reject(new Error(tx("phone.google.cantReachGoogleSignIn")));
    };
    document.head.append(s);
  });
  return loading;
}

/** Render Google's button into `el`; `onUser` gets each new sign-in. */
export async function renderGoogleButton(
  el: HTMLElement,
  clientId: string,
  onUser: (u: GoogleUser) => void,
): Promise<void> {
  const id = await loadGis();
  id.initialize({
    client_id: clientId,
    callback: (r: { credential?: string }) => {
      const u = r.credential ? userFromToken(r.credential) : undefined;
      if (u) onUser(u);
    },
    auto_select: true,
    ux_mode: "popup",
    itp_support: true,
    use_fedcm_for_prompt: true,
    context: "signin",
  });
  id.renderButton(el, {
    type: "standard",
    theme: document.documentElement.dataset.theme === "light" ? "outline" : "filled_black",
    size: "large",
    shape: "pill",
    text: "continue_with",
    logo_alignment: "left",
    locale: "zh-TW",
    width: Math.min(400, Math.max(240, Math.round(el.getBoundingClientRect().width || 320))),
  });
}

/** Sign out of this site's automatic sign-in (does not touch the computer or its trusted devices). */
export function forgetGoogle(): void {
  (window as GisWindow).google?.accounts?.id?.disableAutoSelect();
}

// ── Redirect fallback (OIDC implicit, id_token in the fragment) ─────────

const NONCE_KEY = "alca.gnonce";

export function redirectSignIn(clientId: string): void {
  const nonce = crypto.randomUUID();
  sessionStorage.setItem(NONCE_KEY, nonce);
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${location.origin}${location.pathname}`,
    response_type: "id_token",
    scope: "openid email",
    nonce,
    prompt: "select_account",
  }).toString();
  location.assign(u.toString());
}

/** Back from the redirect: `#id_token=…` with our nonce → the user (and the fragment is cleared). */
export function userFromRedirect(hash = location.hash): GoogleUser | undefined {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const t = p.get("id_token");
  if (!t) return undefined;
  history.replaceState(null, "", location.pathname + location.search);
  const want = sessionStorage.getItem(NONCE_KEY);
  sessionStorage.removeItem(NONCE_KEY);
  const u = userFromToken(t) as (GoogleUser & { nonce?: string }) | undefined;
  if (!u || !want || u.nonce !== want) return undefined;
  return u;
}
