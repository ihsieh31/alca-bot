// Review L5: the phone site's connect-src, built from the configured relay at
// build time. vercel.json (and the Node relay's PWA_CSP) send a header that
// allows `wss:` — any WebSocket host — because the source names no deployment.
// When a build knows its relay (ALCA_RELAY_URL / ALCA_OFFICIAL_RELAY_URL), the
// page also carries a <meta> CSP whose connect-src is only this site, that
// relay, Google Identity Services, Tailscale `serve` (direct wss:// addresses,
// RUNNING § 9) and ALCA_CSP_CONNECT_EXTRA; a browser enforces both policies,
// so connections are limited to what both allow.
//
//   ALCA_CSP_CONNECT_EXTRA="wss://mac.example.net,https://relay2.example.com"  more origins
//   ALCA_CSP_CONNECT=open      no narrowing (a site whose phones pair with relays typed by hand)

/** Origins a phone may connect to besides the relay (Tailscale serve URLs end in .ts.net). */
export const DEFAULT_EXTRA = ["wss://*.ts.net"];
const GIS = "https://accounts.google.com/gsi/";

const origin = (u: string, schemes: string[]): string[] => {
  const url = new URL(u);
  return schemes.map((s) => `${s}//${url.host}`);
};

/** The connect-src value for this build, or undefined (no relay known, or narrowing turned off). */
export function connectSrc(env: Record<string, string | undefined>): string | undefined {
  if (env.ALCA_CSP_CONNECT?.trim() === "open") return undefined;
  const relay = (env.ALCA_RELAY_URL || env.ALCA_OFFICIAL_RELAY_URL)?.trim();
  if (!relay) return undefined;
  const secure = /^(https|wss):/.test(relay);
  const sources = new Set<string>([
    "'self'",
    ...origin(relay, secure ? ["https:", "wss:"] : ["http:", "ws:"]),
  ]);
  for (const x of [...DEFAULT_EXTRA, ...(env.ALCA_CSP_CONNECT_EXTRA ?? "").split(",")]) {
    const v = x.trim();
    if (!v) continue;
    if (!/^(https|wss):\/\/[A-Za-z0-9*.-]+(:\d+)?$/.test(v))
      throw new Error(`ALCA_CSP_CONNECT_EXTRA: ${v} is not an https:// or wss:// origin`);
    sources.add(v);
  }
  sources.add(GIS);
  return [...sources].join(" ");
}

/** index.html with the <meta> CSP right after <meta charset> (before any script or style). */
export function withConnectCsp(html: string, env: Record<string, string | undefined>): string {
  const src = connectSrc(env);
  if (!src) return html;
  const meta = `<meta http-equiv="Content-Security-Policy" content="connect-src ${src}" />`;
  const at = html.indexOf("<meta charset");
  if (at < 0) throw new Error("index.html has no <meta charset>");
  const end = html.indexOf(">", at) + 1;
  return `${html.slice(0, end)}\n    ${meta}${html.slice(end)}`;
}
