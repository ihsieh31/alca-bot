// Relay wire protocol v0 (JSON text messages over WebSocket). The relay
// matches pairing nameplates and forwards channel messages between a core
// and its devices; it never opens what is inside `d`.
//
// Core (one connection, many channels):
//   → {op:"core.hello", v, pub}                ← {op:"challenge", nonce}
//   → {op:"core.auth", sig}                     ← {op:"core.ready", mailbox}
//   → {op:"nameplate.open", ttlSec, req}        ← {op:"nameplate", req, nameplate, expiresAt}
//   → {op:"nameplate.reopen", nameplate}       (after a wrong code; the relay caps claims per code)
//   → {op:"nameplate.close", nameplate}
//   → {op:"ping"}                               ← {op:"pong"}
//   ← {op:"ch.open", ch, via:"claim"|"dial", nameplate?}
//   ↔ {op:"ch.msg", ch, d}        → {op:"ch.close", ch}   ← {op:"ch.closed", ch}
// Device (one connection = one channel):
//   → {op:"claim", v, nameplate} | {op:"dial", v, mailbox}   ← {op:"open"}
//   → {op:"probe", v, mailbox}   ← {op:"probe", online}   (then closed; no channel)
//   ↔ {op:"msg", d}
// P10, Google account (only when the relay is configured with client IDs):
//   core   → {op:"computer.register", req, idToken, name}   ← {op:"computer.registered", req, mailbox, fingerprint}
//   core   → {op:"computer.unregister", req}                ← {op:"computer.unregistered", req}
//   device → {op:"computers.list", v, idToken}              ← {op:"computers", computers:[…]}   (then closed)
//   device → {op:"connect", v, mailbox, idToken}            ← {op:"open"}; the core gets ch.open via:"connect"
// Either: ← {op:"error", code, message, req?}
import { framed, utf8 } from "./bytes.ts";

export const RELAY_VERSION = 0;
export const RELAY_PATH = "/v0/link";

export const coreAuthPayload = (nonce: Uint8Array) => framed(utf8("alca-relay/v0 core auth"), nonce);

/** `https://relay.example` → `wss://relay.example/v0/link` (keeps an explicit ws(s) URL as it is). */
export function relayWsUrl(base: string): string {
  const u = new URL(base);
  if (u.protocol === "https:") u.protocol = "wss:";
  else if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol !== "wss:" && u.protocol !== "ws:") throw new Error("relay URL must be http(s) or ws(s)");
  if (u.pathname === "/" || u.pathname === "") u.pathname = RELAY_PATH;
  u.hash = "";
  return u.toString();
}

export type RelayErrorCode =
  | "bad_request"
  | "rate_limited"
  | "no_such_code"
  | "offline"
  | "auth_failed"
  | "too_many"
  | "too_big"
  | "bad_token"
  | "no_such_computer"
  | "not_enabled";

/** One computer in a Google account's list (`computers.list`). Nothing here is secret. */
export interface ComputerListing {
  mailbox: string;
  name: string;
  /** Fingerprint of the computer's Link key as the relay saw it (the SAS is what authenticates it). */
  fingerprint: string;
  registeredAt: string;
  lastSeen: string;
  online: boolean;
}
