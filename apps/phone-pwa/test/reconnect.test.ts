// C5: 診斷 › 重新連線 answers with the round trip or the reason.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { t } from "../../../packages/design/src/i18n/index.ts";
import { checkConnection, connectionCheckText } from "../app/connection-check.ts";

function client(o: { online: boolean; comesBack?: boolean; rtt?: number; lastError?: string }) {
  const hs: Array<(s: string) => void> = [];
  const c = {
    status: o.online ? "online" : "offline",
    stats: { lastRttMs: -1, lastError: o.lastError ?? "" },
    resume: async () => {
      if (c.status === "online") {
        c.stats.lastRttMs = o.rtt ?? 42;
        return true;
      }
      // A fresh connection starts; it may come up a moment later.
      if (o.comesBack)
        setTimeout(() => {
          c.status = "online";
          for (const h of [...hs]) h("online");
        }, 5);
      return false;
    },
    onStatus: (h: (s: string) => void) => {
      hs.push(h);
      return () => hs.splice(hs.indexOf(h), 1);
    },
  };
  return c;
}

describe("phone 診斷 › 重新連線", () => {
  it("online: 連線正常 · NN ms", async () => {
    const r = await checkConnection(client({ online: true, rtt: 37 }));
    expect(r).toEqual({ ok: true, ms: 37 });
    expect(connectionCheckText(r)).toBe(t("phone.diag.connectionOkMs", { ms: 37 }));
    expect(connectionCheckText(r)).toBe("連線正常 · 37 ms");
  });

  it("offline, then the connection comes back: waits and reports the round trip", async () => {
    expect(await checkConnection(client({ online: false, comesBack: true, rtt: 12 }), 1000)).toEqual({
      ok: true,
      ms: 12,
    });
  });

  it("never comes back: the reason (the last connection error), not silence", async () => {
    const r = await checkConnection(client({ online: false, lastError: "no_peer" }), 20);
    expect(r).toEqual({ ok: false, reason: "no_peer" });
    expect(connectionCheckText(r)).toBe("連不上電腦：no_peer");
    const s = await checkConnection(client({ online: false }), 20);
    expect(s.ok).toBe(false);
    expect((s as { reason: string }).reason).toBe(
      t("phone.reconnect.computerOfflineReconnectingAutomatically"),
    );
  });

  it("diag shows it in the shared toast layer (not a toast at the end of the scrolling sheet)", () => {
    const src = readFileSync(new URL("../app/diag.ts", import.meta.url), "utf8");
    expect(src).toContain("checkConnection(s.client)");
    expect(src).not.toContain('class: "mem-toast"');
    expect(src).toMatch(/import \{ toast \} from "\.\/toast\.ts"/);
  });
});
