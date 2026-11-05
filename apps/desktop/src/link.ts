import type { AgentSystem, AlcaCore } from "@alca/core";
import {
  encodeQr,
  fromB64u,
  type HostSession,
  type IdentityJwk,
  importIdentity,
  type LanListener,
  LinkHost,
  loadNodeRtc,
  type PairedDevice,
  type Pairing,
  type PairingOutcome,
  qrSvg,
  RtcHost,
  safetyNumber,
  startLanListener,
} from "@alca/link";
import type { Device, Store } from "@alca/store";
import type { BrowserSetup } from "./browser.ts";
import type { ConnectorsApi } from "./connectors-api.ts";
import type { GoogleOAuthConfig } from "./google-signin.ts";
import type { HandsRegistry } from "./hands.ts";
import { type PakeRecord, recordPake } from "./link-pake.ts";
import { type LinkPrefs, loadLinkPrefs, normalizePrefs, saveLinkPrefs } from "./link-prefs.ts";
import { type CodeOutcome, type EnrollmentView, RemoteAccess, type RemoteView } from "./link-remote.ts";
import { phoneHandler } from "./link-rpc.ts";
import { log } from "./log.ts";
import type { MemoryApi } from "./memory-api.ts";
import type { OfficialConfig } from "./official.ts";
import type { PushNotifier } from "./push.ts";
import type { TeamApi } from "./team-api.ts";

/**
 * Desktop wiring for Alca Link: the core's LinkHost (outbound to the
 * rendezvous; no inbound port), the device list in the store, phones served
 * by an allow-listed RPC surface, hands daemons registered for the hands
 * tools. The loopback HTTP API is never reachable from the Link side.
 */

export interface LinkOptions {
  core: AlcaCore;
  store: Store;
  agents: AgentSystem | undefined;
  browser: BrowserSetup | undefined;
  /** Memory + skills management (P5). */
  memory?: MemoryApi | undefined;
  /** Connected apps + routines (P6). */
  connectors?: ConnectorsApi | undefined;
  /** The team (P7): roster + bot-to-bot trail for the phone. */
  team?: TeamApi | undefined;
  /** Web Push (P8). */
  push?: PushNotifier | undefined;
  identity: IdentityJwk;
  /** The relay from `--rendezvous` / settings; a stable URL set in 連線 (link.json) wins over it. */
  relayUrl: string;
  /** Where link.json lives (連線 settings); unset = not editable (tests). */
  dataDir?: string;
  /** Reachability self-check period (default 15 min). */
  selfCheckMs?: number;
  pairingMaxAttempts?: number;
  hands: HandsRegistry;
  coreName?: string;
  /** Where the phone PWA lives (for the QR link); default: the relay's own origin. */
  pwaUrl?: string;
  /** Also listen on the LAN (port, 0 = any free one); off by default. */
  lanPort?: number;
  lanHost?: string;
  defaultScopes: string[];
  pairingTtlSec: number;
  /** Self-host (P10): a Desktop OAuth client; when unset the computer signs in through the phone site (P12). */
  google?: GoogleOAuthConfig | undefined;
  /** P12: the official relay / site / Web client ID (build-time defaults; 連線 overrides the site). */
  official?: OfficialConfig;
  /** Open the Google sign-in page in the default browser (default: none; the UI opens it). */
  openUrl?: (url: string) => boolean;
  /** P13: STUN servers for the direct WebRTC path (settings engineering.rtc.iceServers); empty = relay only. */
  rtcIceServers?: string[];
}

export interface PairingView extends Pairing {
  /** Deep link the QR encodes (opens the PWA with the code filled in). */
  url: string;
  qrSvg: string;
}

export interface LinkSetup {
  host: LinkHost;
  /** P13: the direct WebRTC path, when ICE servers are configured and werift is installed. */
  rtc: RtcHost | undefined;
  lan: LanListener | undefined;
  hands: HandsRegistry;
  pair(o?: { scopes?: string[] }): Promise<PairingView>;
  /** The core key's short safety number (also shown on the phone after pairing). */
  safetyNumber: string;
  devices(): Array<Device & { online: boolean }>;
  revoke(deviceId: string): boolean;
  setScopes(deviceId: string, scopes: string[]): void;
  onPairing(h: (p: PairingOutcome) => void): () => void;
  /** G1: the last pairings / enrollments with the PAKE version they ran (0 = refused, v1-only device). */
  pake(): { recent: PakeRecord[] };
  /** 連線: where phones reach this core, and how the last self-check went. */
  connection(): ConnectionView;
  setConnection(v: unknown): Promise<ConnectionView>;
  checkNow(): Promise<ConnectionView>;
  /** P10: Google remote access and the new-device sheets waiting for 允許 / 拒絕. */
  remote(): RemoteView;
  remoteStart(): Promise<RemoteView>;
  remoteDisable(): Promise<RemoteView>;
  enrollments(): EnrollmentView[];
  /** P12: the code typed on the sheet → right (device stored), wrong (tries left) or failed. */
  submitEnrollmentCode(id: string, code: string): Promise<CodeOutcome> | undefined;
  cancelEnrollment(id: string): boolean;
  close(): Promise<void>;
}

export interface ConnectionView {
  status: string;
  relayUrl: string;
  /** The relay given on the command line / in config.json. */
  defaultRelayUrl: string;
  /** P12: the phone site phones open and the computer signs in through (連線 override, else the official one). */
  siteUrl: string | null;
  defaultSiteUrl: string | null;
  googleClientId: string | null;
  /** The person's own stable relay, when set. */
  stableRelayUrl: string | null;
  directUrls: string[];
  lan: string[];
  relays: string[];
  mailbox: string;
  health: LinkHost["health"];
  selfCheckMinutes: number;
}

export const ALL_SCOPES = ["chat", "approve", "view_screen", "control_computer"] as const;

export async function startLink(o: LinkOptions): Promise<LinkSetup> {
  const identity = await importIdentity(o.identity);
  let prefs: LinkPrefs = o.dataDir ? loadLinkPrefs(o.dataDir) : { directUrls: [] };
  const selfCheckMs = o.selfCheckMs ?? 15 * 60_000;
  const deviceList = () =>
    o.store.devices.list().map((d) => ({ ...d, online: host.sessions(d.id).length > 0 }));
  o.hands.setKnown(() => o.store.devices.list().filter((d) => d.kind === "hands"));
  let lan: LanListener | undefined;
  const changed = () => {
    for (const s of host.sessions())
      if (s.device.kind === "phone") s.peer.emit("link", { type: "devices.changed" });
  };
  /** Pairing code or 允許 on a new-device sheet: the same checks, the same device list. */
  const addDevice = (p: PairedDevice, scopes: string[]) => {
    const existing = o.store.devices.byFingerprint(p.fingerprint);
    if (existing && existing.revokedAt === null) throw new Error("這台裝置已經配對過了");
    if (existing) throw new Error("這把金鑰已被撤銷，請在裝置上重設後再配對");
    const d = o.store.devices.add({
      name: p.name,
      kind: p.kind,
      platform: p.platform,
      pubkey: Buffer.from(p.publicRaw).toString("base64url"),
      keyFingerprint: p.fingerprint,
      scopes,
    });
    setTimeout(changed, 0);
    return { id: d.id, name: d.name, kind: d.kind, publicRaw: p.publicRaw, scopes: d.scopes, revoked: false };
  };
  const pakeLog: PakeRecord[] = [];
  let remote: RemoteAccess | undefined;
  let rtc: RtcHost | undefined;
  const host: LinkHost = new LinkHost({
    onEnroll: () => {
      if (!remote) throw new Error("not ready");
      return remote.onEnroll();
    },
    relayUrl: prefs.relayUrl ?? o.relayUrl,
    selfCheckMs,
    ...(o.pairingMaxAttempts ? { pairingMaxAttempts: o.pairingMaxAttempts } : {}),
    onPake: (e) => recordPake(o.store, pakeLog, e),
    // The default relay stays on the phones' list behind a stable one.
    endpoints: () => ({ relays: [o.relayUrl], direct: prefs.directUrls }),
    identity,
    coreName: o.coreName ?? "Alca",
    devices: {
      get: (id) => {
        const d = o.store.devices.get(id);
        if (!d) return undefined;
        return {
          id: d.id,
          name: d.name,
          kind: d.kind,
          publicRaw: fromB64u(d.pubkey),
          scopes: d.scopes,
          revoked: d.revokedAt !== null,
        };
      },
      add: addDevice,
      seen: (id) => o.store.devices.seen(id),
    },
    readyInfo: () => ({ ...(lan ? { lan: lan.urls } : {}), ...rtc?.readyInfo() }),
    onSession: (s: HostSession) => {
      if (s.device.kind === "hands") o.hands.attach(s);
      else
        phoneHandler(s, {
          core: o.core,
          agents: o.agents,
          browser: o.browser,
          memory: o.memory,
          connectors: o.connectors,
          team: o.team,
          push: o.push,
          link: () => setup,
          linkHost: host,
          rtc,
        });
      setTimeout(changed, 0);
      s.peer.onClose(() => setTimeout(changed, 0));
    },
    log: (m) => log.warn(m),
  });
  // A phone whose app is in front hears about a new card over its live session instead of a push.
  o.push?.setInApp((deviceId, p) => {
    for (const s of host.sessions(deviceId)) s.peer.emit("notify", p);
  });
  // P13: idempotency keys of queued phone sends are kept for a week.
  o.store.clientOps.prune();
  const ice = o.rtcIceServers ?? [];
  const rtcFactory = ice.length ? await loadNodeRtc((m) => log.warn(m)) : undefined;
  if (rtcFactory)
    rtc = new RtcHost({
      factory: rtcFactory,
      iceServers: ice,
      // The channel is one more wire: the full session handshake against the paired key runs on it.
      accept: async (wire) => {
        const s = await host.acceptWire(wire, "rtc");
        return s ? { deviceId: s.device.id, close: (why) => s.peer.close(why) } : undefined;
      },
      log: (m) => log.warn(m),
    });
  await host.start();
  remote = new RemoteAccess({
    host,
    google: o.google,
    site: () => {
      const siteUrl = prefs.siteUrl ?? o.pwaUrl ?? o.official?.siteUrl;
      if (!siteUrl) return undefined;
      const clientId = prefs.googleClientId ?? o.official?.googleClientId;
      return { siteUrl, ...(clientId ? { clientId } : {}) };
    },
    coreName: () => o.coreName ?? "Alca",
    prefs: () => prefs,
    savePrefs: (p) => {
      prefs = p;
      if (o.dataDir) saveLinkPrefs(o.dataDir, p);
    },
    addDevice: (d) => addDevice(d, d.kind === "hands" ? ["hands"] : o.defaultScopes),
    changed: () => undefined,
    ...(o.openUrl ? { openUrl: o.openUrl } : {}),
  });
  const rem = remote;
  if (o.lanPort !== undefined)
    lan = await startLanListener(host, { port: o.lanPort, ...(o.lanHost ? { host: o.lanHost } : {}) });

  const pwaBase = () =>
    (
      prefs.siteUrl ??
      o.pwaUrl ??
      o.official?.siteUrl ??
      new URL(host.relayUrl.replace(/^ws/, "http")).origin
    ).replace(/\/$/, "");
  const connection = (): ConnectionView => ({
    status: host.status,
    relayUrl: host.relayUrl,
    defaultRelayUrl: o.relayUrl,
    siteUrl: prefs.siteUrl ?? null,
    defaultSiteUrl: o.pwaUrl ?? o.official?.siteUrl ?? null,
    googleClientId: prefs.googleClientId ?? null,
    stableRelayUrl: prefs.relayUrl ?? null,
    directUrls: prefs.directUrls,
    lan: lan?.urls ?? [],
    relays: host.endpoints().relays,
    mailbox: host.mailbox,
    health: { ...host.health },
    selfCheckMinutes: Math.round(selfCheckMs / 60_000),
  });
  const setup: LinkSetup = {
    host,
    rtc,
    lan,
    hands: o.hands,
    async pair(p = {}) {
      const scopes = (p.scopes ?? o.defaultScopes).filter((s) =>
        (ALL_SCOPES as readonly string[]).includes(s),
      );
      const pairing = await host.createPairing({ scopes, ttlSec: o.pairingTtlSec });
      const base = pwaBase();
      const relayParam =
        pairing.relayUrl === `${base.replace(/^http/, "ws")}/v0/link`
          ? ""
          : `&r=${encodeURIComponent(pairing.relayUrl)}`;
      // G1: `pk=2` = the pairing version this core runs (v2 only; kept for later negotiation).
      const url = `${base}/#pair=${pairing.code}&fp=${pairing.coreFingerprint}&pk=2${relayParam}`;
      return { ...pairing, url, qrSvg: qrSvg(encodeQr(url), { label: "配對用 QR code" }) };
    },
    safetyNumber: await safetyNumber(identity.publicRaw),
    devices: deviceList,
    setScopes(id, scopes) {
      o.store.devices.setScopes(id, scopes);
      // BUG-14: a connected phone only read its scopes in `ready`; tell it now, so it stops
      // offering what it may no longer do (刪除 without approve) without a new pairing.
      const now = o.store.devices.get(id)?.scopes ?? scopes;
      for (const s of host.sessions(id))
        if (s.device.kind === "phone") s.peer.emit("link", { type: "scopes", scopes: now });
      setTimeout(changed, 0);
    },
    revoke(id) {
      const ok = o.store.devices.revoke(id);
      host.disconnect(id, "revoked");
      // B8: nothing more goes to it, not even a push retry already scheduled.
      o.push?.forget(id);
      setTimeout(changed, 0);
      return ok;
    },
    onPairing: (h) => host.onPairing(h),
    pake: () => ({ recent: [...pakeLog] }),
    connection,
    async setConnection(v) {
      if (!o.dataDir) throw new Error("這個核心的連線設定不能修改");
      const next = normalizePrefs(v);
      // The Google listing is not part of the 連線 form: keep it.
      if (prefs.google) next.google = prefs.google;
      else delete next.google;
      saveLinkPrefs(o.dataDir, next);
      prefs = next;
      await host.setRelayUrl(next.relayUrl ?? o.relayUrl);
      host.announceEndpoints();
      return connection();
    },
    async checkNow() {
      await host.selfCheck();
      return connection();
    },
    remote: () => rem.view(),
    remoteStart: () => rem.start(),
    remoteDisable: () => rem.disable(),
    enrollments: () => rem.enrollments(),
    submitEnrollmentCode: (id, code) => rem.submitCode(id, code),
    cancelEnrollment: (id) => rem.cancel(id),
    async close() {
      rem.close();
      rtc?.close();
      await lan?.close();
      await host.close();
    },
  };
  return setup;
}
