// 網站登入 (design §0.2.7): what the 連接 page shows for a kept website login
// and the body it sends. No DOM here, so the rules are tested in node. The
// password is read from its field once, sent once, and never kept in a view.

/** One kept login as the core lists it (never a password). */
import { t as tx } from "./i18n/index.ts";
export interface SiteLoginView {
  id: string;
  origin: string;
  username?: string;
  label?: string;
  botIds?: string[];
  bots: Array<{ id: string; name: string }>;
}

export interface LoginFields {
  origin: string;
  username: string;
  password: string;
  label: string;
  botIds: string[];
}

export type LoginBody = {
  origin: string;
  password: string;
  username?: string;
  label?: string;
  botIds?: string[];
};

/** The same limits the core checks (`site-logins-api.ts` LOGIN_LIMITS). */
export const LOGIN_FORM_LIMITS = { password: 1024, username: 200, label: 80 } as const;

/** The canonical https origin of what the person typed ("example.com" counts as https), or undefined. */
export function formOrigin(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" && u.hostname ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The POST body, or the one thing to fix (never echoing the password). */
export function loginBody(f: LoginFields): { body: LoginBody } | { error: string } {
  const origin = formOrigin(f.origin);
  if (!origin) return { error: tx("desktop.siteLoginsModel.theAddressMustBeAn") };
  if (!f.password) return { error: tx("desktop.siteLoginsModel.aPasswordIsRequired") };
  if (f.password.length > LOGIN_FORM_LIMITS.password)
    return {
      error: tx("desktop.siteLoginsModel.passwordCanBeAtMost", { password: LOGIN_FORM_LIMITS.password }),
    };
  const username = f.username.trim();
  if (username.length > LOGIN_FORM_LIMITS.username)
    return {
      error: tx("desktop.siteLoginsModel.usernameCanBeAtMost", { username: LOGIN_FORM_LIMITS.username }),
    };
  const label = f.label.trim().slice(0, LOGIN_FORM_LIMITS.label);
  const botIds = [...new Set(f.botIds)];
  return {
    body: {
      origin,
      password: f.password,
      ...(username ? { username } : {}),
      ...(label ? { label } : {}),
      ...(botIds.length ? { botIds } : {}),
    },
  };
}

/** The row's words: a title, the account line and who may use it. */
export function loginLine(l: SiteLoginView): { title: string; account: string; who: string } {
  const host = (() => {
    try {
      return new URL(l.origin).host;
    } catch {
      return l.origin;
    }
  })();
  return {
    title: l.label ? tx("common.text4", { label: l.label, host }) : host,
    account: l.username ? tx("common.username", { username: l.username }) : tx("common.noUsername"),
    who: l.bots.length
      ? tx("common.only", { p0: l.bots.map((b) => b.name).join(tx("common.text")) })
      : tx("common.allBotsCanUseIt"),
  };
}
