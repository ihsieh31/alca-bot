import { hostname } from "node:os";
import {
  type ClientStatus,
  importIdentity,
  LinkClient,
  loadDeviceIdentity,
  pairDevice,
  readDeviceFile,
  writeDeviceFile,
} from "@alca/link";
import { HandsExecutor } from "./executor.ts";

/** Pair this machine as a hands device (once). Stores only its own key and the core's public key. */
export async function pairHands(o: {
  statePath: string;
  relayUrl: string;
  code: string;
  name?: string;
  fingerprint?: string;
}) {
  const { identity, file } = await loadDeviceIdentity(o.statePath);
  const credentials = await pairDevice({
    relayUrl: o.relayUrl,
    code: o.code,
    identity,
    device: { name: o.name ?? hostname(), kind: "hands", platform: `${process.platform} ${process.arch}` },
    ...(o.fingerprint ? { expectFingerprint: o.fingerprint } : {}),
  });
  writeDeviceFile(o.statePath, { ...file, credentials });
  return credentials;
}

export interface HandsDaemon {
  client: LinkClient;
  executor: HandsExecutor;
  stop(): void;
}

/** Run: keep a session to the paired core open and answer its calls. */
export async function runHands(o: {
  statePath: string;
  workdir: string;
  preferLan?: boolean;
  onStatus?: (s: ClientStatus, why?: string) => void;
}): Promise<HandsDaemon> {
  const f = readDeviceFile(o.statePath);
  if (!f?.credentials) throw new Error(`還沒配對：先執行 pair（狀態檔 ${o.statePath}）`);
  const identity = await importIdentity(f.identity);
  const executor = new HandsExecutor({ workdir: o.workdir });
  const client = new LinkClient({
    credentials: f.credentials,
    identity,
    onRequest: executor.handle,
    preferLan: o.preferLan ?? true,
  });
  if (o.onStatus) client.onStatus(o.onStatus);
  client.onReady(() => {
    // Remember new LAN addresses the core reported (public info only).
    writeDeviceFile(o.statePath, { ...f, credentials: client.credentials });
  });
  client.start();
  return { client, executor, stop: () => client.stop() };
}
