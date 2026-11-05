// C5: the answer to 診斷 › 重新連線. Kept DOM-free so it is unit-testable
// under the root tsconfig (no DOM lib for apps/*/test).
import { t } from "./i18n/index.ts";
import { waitForOnline } from "./reach.ts";

const STATE: Record<string, string> = {
  connecting: t("common.connectingToYourComputer"),
  offline: t("phone.reconnect.computerOfflineReconnectingAutomatically"),
  revoked: t("common.thisPhoneHasBeenRevoked"),
  idle: t("common.notConnectedYet"),
};

export type ConnectionCheck = { ok: true; ms: number } | { ok: false; reason: string };

/**
 * C5: 診斷 › 重新連線, with an answer. Online: one ping (its round trip).
 * Not online (or the ping failed and a fresh connection started): wait for
 * the connection up to `waitMs`, then ping once more for the number; the
 * failure reason is the last connection error (or the state).
 */
export async function checkConnection(
  c: {
    status: string;
    resume(timeoutMs?: number): Promise<boolean>;
    onStatus(h: (s: string) => void): () => void;
    stats: { lastRttMs: number; lastError: string };
  },
  waitMs = 10_000,
): Promise<ConnectionCheck> {
  if (await c.resume(3000)) return { ok: true, ms: Math.max(0, c.stats.lastRttMs) };
  if (c.status === "revoked") return { ok: false, reason: t("common.thisPhoneHasBeenRevoked") };
  if ((await waitForOnline(c, waitMs)) && (await c.resume(3000)))
    return { ok: true, ms: Math.max(0, c.stats.lastRttMs) };
  return { ok: false, reason: c.stats.lastError || STATE[c.status] || c.status };
}

export const connectionCheckText = (r: ConnectionCheck): string =>
  r.ok
    ? t("phone.diag.connectionOkMs", { ms: r.ms })
    : t("phone.diag.cantConnectReason", { reason: r.reason });
