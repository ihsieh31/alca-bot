// A local stand-in for Google's identity endpoints (tests and screenshots):
// a JWKS at /oauth2/v3/certs, an ID-token signer (RS256), and an installed-app
// OAuth flow (authorize → loopback redirect with a code → token exchange
// checking the PKCE verifier). Written from Google's public Identity docs.
import { createHash, createSign, generateKeyPairSync, type KeyObject, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_ISSUER = "https://accounts.google.com";

export interface FakeGoogle {
  url: string;
  jwksUrl: string;
  authEndpoint: string;
  tokenEndpoint: string;
  /** Sign an ID token; defaults: iss Google, iat now, exp in 1 h. */
  token(
    claims: { sub: string; aud: string; email?: string } & Record<string, unknown>,
    o?: { kid?: string; key?: KeyObject },
  ): string;
  /** The account the next authorize request signs in as. */
  signInAs: { sub: string; email: string };
  /** Token requests seen (for assertions). */
  tokenRequests: Array<Record<string, string>>;
  jwksFetches: number;
  /** A key Google does not list (forged token). */
  strangerKey: KeyObject;
  close(): Promise<void>;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export async function startFakeGoogle(o: { clientSecret?: string } = {}): Promise<FakeGoogle> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const codes = new Map<string, { challenge: string; clientId: string; redirect: string; nonce?: string }>();
  let url = "";
  const sign = (claims: Record<string, unknown>, so: { kid?: string; key?: KeyObject } = {}): string => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: "RS256", kid: so.kid ?? "fake-1", typ: "JWT" }));
    const body = b64u(JSON.stringify({ iss: FAKE_ISSUER, iat: now, exp: now + 3600, ...claims }));
    const s = createSign("RSA-SHA256")
      .update(`${head}.${body}`)
      .sign(so.key ?? privateKey);
    return `${head}.${body}.${b64u(s)}`;
  };
  const g: Partial<FakeGoogle> = {
    signInAs: { sub: "1000001", email: "xiaoming@example.com" },
    tokenRequests: [],
    jwksFetches: 0,
    strangerKey: stranger,
  };
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/oauth2/v3/certs") {
      (g as FakeGoogle).jwksFetches++;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=600" });
      return void res.end(
        JSON.stringify({ keys: [{ kty: "RSA", alg: "RS256", use: "sig", kid: "fake-1", ...jwk }] }),
      );
    }
    if (u.pathname === "/o/oauth2/v2/auth") {
      const p = u.searchParams;
      const redirect = p.get("redirect_uri") ?? "";
      if (
        p.get("response_type") !== "code" ||
        p.get("code_challenge_method") !== "S256" ||
        !redirect.startsWith("http://127.0.0.1:")
      )
        return void res.writeHead(400).end("bad request");
      const code = randomUUID();
      codes.set(code, {
        challenge: p.get("code_challenge") ?? "",
        clientId: p.get("client_id") ?? "",
        redirect,
      });
      const to = new URL(redirect);
      to.searchParams.set("code", code);
      to.searchParams.set("state", p.get("state") ?? "");
      res.writeHead(302, { location: to.toString() });
      return void res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const f = Object.fromEntries(new URLSearchParams(raw));
        (g as FakeGoogle).tokenRequests.push(f);
        const c = codes.get(f.code ?? "");
        codes.delete(f.code ?? "");
        const verifierOk =
          c &&
          createHash("sha256")
            .update(f.code_verifier ?? "")
            .digest("base64url") === c.challenge;
        const secretOk = !o.clientSecret || f.client_secret === o.clientSecret;
        if (!c || !verifierOk || c.clientId !== f.client_id || c.redirect !== f.redirect_uri || !secretOk) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "invalid_grant" }));
        }
        const who = (g as FakeGoogle).signInAs;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "fake-access",
            expires_in: 3599,
            token_type: "Bearer",
            scope: "openid email",
            id_token: sign({
              sub: who.sub,
              email: who.email,
              email_verified: true,
              aud: c.clientId,
              azp: c.clientId,
            }),
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(g, {
    url,
    jwksUrl: `${url}/oauth2/v3/certs`,
    authEndpoint: `${url}/o/oauth2/v2/auth`,
    tokenEndpoint: `${url}/token`,
    token: (
      claims: { sub: string; aud: string } & Record<string, unknown>,
      so?: { kid?: string; key?: KeyObject },
    ) => sign(claims, so),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }) as FakeGoogle;
}
