// Alca rendezvous: a relay that only matches pairing codes and forwards ciphertext.
//
//   node --disable-warning=ExperimentalWarning services/rendezvous/src/main.ts [options]
//
//   --host <addr>        listen address (default 127.0.0.1; 0.0.0.0 to expose)   $ALCA_RELAY_HOST
//   --port <n>           default 8787                                             $ALCA_RELAY_PORT
//   --tls-cert <pem>     serve HTTPS/WSS directly (else run behind a TLS proxy)    $ALCA_RELAY_TLS_CERT
//   --tls-key <pem>                                                               $ALCA_RELAY_TLS_KEY
//   --pwa <dir>          also serve the built phone PWA from this directory        $ALCA_RELAY_PWA
//   --trust-proxy        client address from X-Forwarded-For (behind your proxy)   $ALCA_RELAY_TRUST_PROXY=1
//   --trust-proxy-hops <n>  how many proxies of yours append to X-Forwarded-For (default 1 with
//                        --trust-proxy): the client is the n-th entry from the right  $ALCA_RELAY_TRUST_PROXY=<n>
//   --origin <url>       allowed browser Origin (repeatable; default any)          $ALCA_RELAY_ORIGINS (comma list)
//   --hooks-file <path>  keep webhook mailboxes (connected-app events) across restarts  $ALCA_RELAY_HOOKS_FILE
//   --google-client-id <id>  accept Google ID tokens for this OAuth client (repeatable: the Web client
//                        of the phone site and the Desktop client)                 $ALCA_RELAY_GOOGLE_CLIENT_IDS (comma list)
//   --accounts-file <path>  keep the Google-account registry (keyed hashes → computers), 0600
//                                                                                  $ALCA_RELAY_ACCOUNTS_FILE
//   Relay secret (keys the account hash): $ALCA_RELAY_SECRET, else <accounts-file>.key, created on first start.
import { parseArgs } from "node:util";
import { startRendezvous } from "./server.ts";

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    port: { type: "string" },
    "tls-cert": { type: "string" },
    "tls-key": { type: "string" },
    pwa: { type: "string" },
    "trust-proxy": { type: "boolean" },
    "trust-proxy-hops": { type: "string" },
    origin: { type: "string", multiple: true },
    "hooks-file": { type: "string" },
    "google-client-id": { type: "string", multiple: true },
    "accounts-file": { type: "string" },
  },
});
const env = process.env;
const origins = values.origin ?? (env.ALCA_RELAY_ORIGINS ? env.ALCA_RELAY_ORIGINS.split(",") : []);
const cert = values["tls-cert"] ?? env.ALCA_RELAY_TLS_CERT;
const key = values["tls-key"] ?? env.ALCA_RELAY_TLS_KEY;
const pwa = values.pwa ?? env.ALCA_RELAY_PWA;
const hooksFile = values["hooks-file"] ?? env.ALCA_RELAY_HOOKS_FILE;
const clientIds = (
  values["google-client-id"] ??
  (env.ALCA_RELAY_GOOGLE_CLIENT_IDS ? env.ALCA_RELAY_GOOGLE_CLIENT_IDS.split(",") : [])
)
  .map((s) => s.trim())
  .filter(Boolean);
const accountsFile = values["accounts-file"] ?? env.ALCA_RELAY_ACCOUNTS_FILE;
// --trust-proxy = one proxy; --trust-proxy-hops n (or ALCA_RELAY_TRUST_PROXY=n) = n proxies.
const hopsArg =
  values["trust-proxy-hops"] ??
  (/^\d+$/.test(env.ALCA_RELAY_TRUST_PROXY ?? "") ? env.ALCA_RELAY_TRUST_PROXY : undefined);
const trustProxy = hopsArg !== undefined ? Number(hopsArg) : (values["trust-proxy"] ?? false);
if (!Number.isInteger(Number(trustProxy)) || Number(trustProxy) < 0) {
  console.error("--trust-proxy-hops needs a whole number ≥ 0");
  process.exit(2);
}
const r = await startRendezvous({
  host: values.host ?? env.ALCA_RELAY_HOST ?? "127.0.0.1",
  port: Number(values.port ?? env.ALCA_RELAY_PORT ?? 8787),
  ...(cert && key ? { tlsCert: cert, tlsKey: key } : {}),
  ...(pwa ? { pwaDir: pwa } : {}),
  trustProxy,
  origins: origins.map((s) => s.trim()).filter(Boolean),
  ...(hooksFile ? { hooks: { file: hooksFile } } : {}),
  ...(clientIds.length ? { google: { clientIds } } : {}),
  ...(accountsFile ? { accountsFile } : {}),
});
if (clientIds.length)
  console.log(
    `Google sign-in on for ${clientIds.length} client ID(s); account registry ${accountsFile ?? "in memory (lost on restart: set --accounts-file)"}.`,
  );
console.log(
  `Alca rendezvous on ${r.url} (WebSocket ${r.url.replace(/^http/, "ws")}/v0/link)${pwa ? ", PWA at /" : ""}`,
);
console.log(
  hooksFile
    ? `Forwards ciphertext only; webhook mailboxes kept in ${hooksFile}. Ctrl+C to stop.`
    : "Stores nothing; forwards ciphertext only (webhook mailboxes in memory). Ctrl+C to stop.",
);
const stop = async () => {
  await r.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
