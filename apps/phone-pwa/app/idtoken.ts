// Claims of a Google ID token the phone shows (email, name) and its expiry.
// Display only: the relay verifies the signature. No DOM here (unit-tested in Node).

export interface GoogleUser {
  idToken: string;
  email?: string;
  name?: string;
  picture?: string;
  /** Seconds since the epoch. */
  exp: number;
}

/** Read the claims we show (email, name) — display only; the relay verifies the signature. */
export function userFromToken(idToken: string): GoogleUser | undefined {
  try {
    const b = (idToken.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      [...atob(b)].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
    );
    const c = JSON.parse(json) as Record<string, unknown>;
    return {
      idToken,
      exp: typeof c.exp === "number" ? c.exp : 0,
      ...(typeof c.email === "string" ? { email: c.email } : {}),
      ...(typeof c.name === "string" ? { name: c.name } : {}),
      ...(typeof c.picture === "string" ? { picture: c.picture } : {}),
      ...(typeof c.nonce === "string" ? { nonce: c.nonce } : {}),
    } as GoogleUser;
  } catch {
    return undefined;
  }
}

export const tokenFresh = (u: GoogleUser | undefined, marginSec = 60): u is GoogleUser =>
  !!u && u.exp - marginSec > Date.now() / 1000;
