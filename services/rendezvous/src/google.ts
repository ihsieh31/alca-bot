// Google ID token verification for the relay (P10). WebCrypto + fetch only,
// so the Node relay and the Cloudflare Worker share it.
//
// Checks (Google Identity: "Verify the Google ID token on your server side"):
// RS256 signature against Google's published JWKS (fetched, cached for the
// response's max-age, refetched on an unknown `kid` at most every 30 s), `iss`
// is accounts.google.com, `aud` is one of the configured client IDs, `exp`
// / `iat` / `nbf` within a small clock skew. Only `sub` (and the email, for
// display by the caller if it wants) comes out; the token itself is not kept.
import { fromB64u, fromUtf8, type Key } from "@alca/link/bytes";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export type TokenFailure =
  | "malformed"
  | "alg"
  | "unknown_key"
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "not_yet_valid"
  | "jwks_unavailable";

export class TokenError extends Error {
  readonly reason: TokenFailure;
  constructor(reason: TokenFailure, message: string = reason) {
    super(message);
    this.name = "TokenError";
    this.reason = reason;
  }
}

export interface VerifiedToken {
  sub: string;
  aud: string;
  email?: string;
  exp: number;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export interface GoogleVerifierOptions {
  /** OAuth client IDs whose tokens are accepted (the Web client of the phone site, the Desktop client). */
  audiences: string[];
  issuers?: string[];
  jwksUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Clock skew allowed on exp / iat / nbf, seconds (default 120). */
  skewSec?: number;
}

type RsaJwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string };

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

function part(s: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(fromUtf8(fromB64u(s)));
  } catch {
    throw new TokenError("malformed", "not a JWT");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new TokenError("malformed", "not a JWT");
  return v as Record<string, unknown>;
}

function maxAge(res: Response): number {
  const m = /max-age=(\d+)/i.exec(res.headers.get("cache-control") ?? "");
  const sec = m ? Number(m[1]) : 3600;
  return Math.min(Math.max(sec, 60), 86_400) * 1000;
}

export class GoogleTokenVerifier implements TokenVerifier {
  private keys = new Map<string, Promise<Key>>();
  private expiresAt = 0;
  private lastFetch = 0;
  private inflight: Promise<void> | undefined;
  private readonly o: GoogleVerifierOptions;
  private readonly now: () => number;

  constructor(o: GoogleVerifierOptions) {
    if (!o.audiences.length) throw new Error("at least one Google client ID is needed");
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  get audiences(): string[] {
    return [...this.o.audiences];
  }

  private refresh(): Promise<void> {
    this.inflight ??= (async () => {
      this.lastFetch = this.now();
      let res: Response;
      try {
        res = await (this.o.fetch ?? fetch)(this.o.jwksUrl ?? GOOGLE_JWKS_URL, {
          headers: { accept: "application/json" },
        });
      } catch {
        throw new TokenError("jwks_unavailable", "could not fetch Google's keys");
      }
      if (!res.ok) throw new TokenError("jwks_unavailable", `Google's keys: HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { keys?: RsaJwk[] };
      const next = new Map<string, Promise<Key>>();
      for (const k of body.keys ?? []) {
        if (k.kty !== "RSA" || !k.kid || !k.n || !k.e) continue;
        if (k.alg && k.alg !== "RS256") continue;
        const p = crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true },
          ALG,
          false,
          ["verify"],
        );
        p.catch(() => undefined);
        next.set(k.kid, p);
      }
      this.keys = next;
      this.expiresAt = this.now() + maxAge(res);
    })().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async key(kid: string): Promise<Key> {
    if (this.now() >= this.expiresAt) await this.refresh();
    let k = this.keys.get(kid);
    // A rotated key: look again, but not more than every 30 s (unknown kids must not make us hammer Google).
    if (!k && this.now() - this.lastFetch > 30_000) {
      await this.refresh();
      k = this.keys.get(kid);
    }
    if (!k) throw new TokenError("unknown_key", "signed with a key Google does not list");
    return k;
  }

  async verify(token: string): Promise<VerifiedToken> {
    if (typeof token !== "string" || token.length > 8192) throw new TokenError("malformed", "not a JWT");
    const parts = token.split(".");
    if (parts.length !== 3) throw new TokenError("malformed", "not a JWT");
    const [h, p, s] = parts as [string, string, string];
    const header = part(h);
    if (header.alg !== "RS256") throw new TokenError("alg", "only RS256 is accepted");
    if (typeof header.kid !== "string") throw new TokenError("unknown_key", "no key id");
    const key = await this.key(header.kid);
    let sig: Uint8Array<ArrayBuffer>;
    try {
      sig = fromB64u(s);
    } catch {
      throw new TokenError("malformed", "bad signature encoding");
    }
    const ok = await crypto.subtle
      .verify(ALG, key, sig, new TextEncoder().encode(`${h}.${p}`))
      .catch(() => false);
    if (!ok) throw new TokenError("signature", "signature check failed");
    const c = part(p);
    const issuers = this.o.issuers ?? GOOGLE_ISSUERS;
    if (typeof c.iss !== "string" || !issuers.includes(c.iss))
      throw new TokenError("issuer", "not issued by Google");
    if (typeof c.aud !== "string" || !this.o.audiences.includes(c.aud))
      throw new TokenError("audience", "issued for another app");
    const now = Math.floor(this.now() / 1000);
    const skew = this.o.skewSec ?? 120;
    if (typeof c.exp !== "number" || c.exp + skew < now) throw new TokenError("expired", "token expired");
    if (typeof c.iat === "number" && c.iat - skew > now)
      throw new TokenError("not_yet_valid", "issued in the future");
    if (typeof c.nbf === "number" && c.nbf - skew > now)
      throw new TokenError("not_yet_valid", "not valid yet");
    if (typeof c.sub !== "string" || !c.sub || c.sub.length > 255)
      throw new TokenError("malformed", "no subject");
    return {
      sub: c.sub,
      aud: c.aud,
      exp: c.exp,
      ...(typeof c.email === "string" ? { email: c.email } : {}),
    };
  }
}
