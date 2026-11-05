import {
  type DeviceDirectory,
  type DeviceRecord,
  generateIdentity,
  type HostSession,
  LinkClient,
  type LinkCredentials,
  LinkError,
  LinkHost,
  type LinkHostOptions,
  pairDevice,
} from "@alca/link";
import { type Rendezvous, type RendezvousOptions, startRendezvous } from "../src/server.ts";

export class MemoryDevices implements DeviceDirectory {
  rows = new Map<string, DeviceRecord>();
  n = 0;
  get(id: string) {
    return this.rows.get(id);
  }
  add(d: { name: string; kind: "phone" | "hands"; publicRaw: Uint8Array }, scopes: string[]) {
    const rec = {
      id: `dev_${++this.n}`,
      name: d.name,
      kind: d.kind,
      publicRaw: d.publicRaw,
      scopes,
      revoked: false,
    };
    this.rows.set(rec.id, rec);
    return rec;
  }
  seen() {}
}

export const cleanups: Array<() => Promise<void> | void> = [];
export async function cleanup() {
  for (const c of cleanups.splice(0).reverse()) await c();
}

export const until = async (f: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

export const SECRET_TEXT = "請幫我付款給山嵐選物";

export async function setup(
  o: {
    limits?: Record<string, number>;
    port?: number;
    host?: Partial<LinkHostOptions>;
    relay?: Partial<RendezvousOptions>;
  } = {},
) {
  const seen: unknown[] = [];
  const relay = await startRendezvous({
    ...o.relay,
    port: o.port ?? 0,
    ...(o.limits ? { limits: o.limits } : {}),
    tap: (_dir, payload) => seen.push(payload),
  });
  cleanups.push(() => relay.close());
  const devices = new MemoryDevices();
  const sessions: HostSession[] = [];
  const identity = await generateIdentity(true);
  const host = new LinkHost({
    relayUrl: relay.url,
    identity,
    coreName: "測試桌機",
    devices,
    backoff: { first: 50, max: 200 },
    ...o.host,
    onSession: (s) => {
      sessions.push(s);
      s.peer.handle(async (op, args) => {
        if (op === "ping") return "pong";
        if (op === "echo") {
          s.peer.emit("alca", { type: "message.delta", text: `${String(args.text)}（串流）` });
          return { echoed: args.text };
        }
        throw new LinkError("refused", "unknown op");
      });
    },
  });
  await host.start();
  cleanups.push(() => host.close());
  return { relay, host, devices, sessions, seen, identity };
}

export async function pairPhone(relay: Rendezvous, host: LinkHost, code?: string) {
  const p = await host.createPairing({ scopes: ["chat", "approve"] });
  const phone = await generateIdentity();
  const creds = await pairDevice({
    relayUrl: relay.url,
    code: code ?? p.display,
    identity: phone,
    device: { name: "iPhone", kind: "phone", platform: "test" },
    expectFingerprint: p.coreFingerprint,
  });
  return { p, phone, creds };
}

export function client(
  creds: LinkCredentials,
  identity: Awaited<ReturnType<typeof generateIdentity>>,
  preferLan = false,
) {
  const c = new LinkClient({
    credentials: creds,
    identity,
    backoff: { first: 50, max: 200 },
    preferLan,
    pingSec: 0,
  });
  cleanups.push(() => c.stop());
  return c;
}
