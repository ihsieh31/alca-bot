// G1: every pairing / enrollment that reached a PAKE goes into the audit log
// with the protocol version it ran, and the last few are kept for the 手機與
// 裝置 dialog. PAKE v1 is removed: a v1-only device is always refused
// (`upgrade_required`, version 0, nothing stored); that refusal is audited
// (decision deny, refused "pake_v1") and the dialog tells the person to update
// and pair again.
import type { PakeEvent } from "@alca/link";
import { appendAudit, type Store } from "@alca/store";
import { log } from "./log.ts";

export interface PakeRecord extends PakeEvent {
  at: string;
}

const KEEP = 10;

export function recordPake(store: Store, recent: PakeRecord[], e: PakeEvent): void {
  const at = new Date().toISOString();
  recent.unshift({ ...e, at });
  recent.splice(KEEP);
  if (e.error === "upgrade_required")
    log.warn(
      `link: refused a ${e.flow} that offered only PAKE v1 (removed; the device must update and pair again)`,
    );
  try {
    appendAudit(store.db, {
      ts: at,
      initiator: { kind: "user", id: "link" },
      actor: { kind: "device", id: e.deviceName ?? "unknown" },
      action: e.flow === "pair" ? "link.pair" : "link.enroll",
      actionClass: "write",
      decision: e.ok ? "allow" : "deny",
      detail: {
        pake: e.version,
        ...(e.error ? { error: e.error } : {}),
        ...(e.error === "upgrade_required" ? { refused: "pake_v1" } : {}),
      },
    });
  } catch (err) {
    log.warn(`link: could not audit a pairing (${err instanceof Error ? err.message : String(err)})`);
  }
}
