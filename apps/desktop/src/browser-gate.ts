import type { ChannelEvent, NetworkConfirm, NetworkConfirmRequest } from "@alca/browser";
import type { AgentSystem, AlcaCore } from "@alca/core";
import type { EventData, EventType } from "@alca/protocol";
import { appendAudit } from "@alca/store";

/**
 * Network-layer gate → the always-confirm gate. A sensitive request a Space's
 * page makes (paused in Chromium by the browser host) becomes an ordinary
 * approval card: authorized and audited by the core's ActionGateway, shown in
 * the run that owns the Space (the thread's turn, or the worker's), answered
 * from the desktop or a phone like any other card. Only an explicit yes lets
 * the request go; no run to show the card in, a deny rule, an abort or the
 * time limit all block it.
 */

export interface NetworkConfirmOptions {
  /** How often the card's status is re-read (default 250 ms). */
  pollMs?: number;
  /** Give up (and expire the card) after this long (default 10 min). */
  timeoutMs?: number;
}

const BY = { kind: "system" as const, id: "browser-network" };

type RunRef = Pick<NetworkConfirmRequest, "threadId" | "workerId">;

/** Into the run that owns the Space: the worker's, or the thread's turn. False when none is live. */
function runEmitter(core: AlcaCore, agents?: AgentSystem) {
  return <T extends EventType>(req: RunRef, type: T, data: EventData<T>): boolean => {
    if (req.workerId && agents) return agents.workers.emitToRun(req.workerId, type, data);
    if (!req.threadId) return false;
    return core.emitToActiveRun(req.threadId, type, data) !== undefined;
  };
}

export const CHANNEL_STOPPED = "browser.channel.stopped";

/**
 * R3: a channel the request gate cannot hold. A WebSocket frame that looked
 * like an always-confirm action has already left when the tab is stopped, so
 * this is a notice in the owning run (not an approval card: there is nothing
 * left to approve) plus an audit row `browser.channel.stopped`. A refused
 * WebRTC connection is only an audit row (`browser.channel.blocked`).
 */
export function channelNotifier(core: AlcaCore, agents?: AgentSystem): (e: ChannelEvent) => void {
  const emit = runEmitter(core, agents);
  return (e) => {
    try {
      appendAudit(core.store.db, {
        ts: new Date().toISOString(),
        initiator: { kind: "agent", id: e.botId },
        actor: { kind: "system", id: "browser-network" },
        action: `browser.channel.${e.outcome}`,
        actionClass: e.actionClass,
        target: e.url.slice(0, 500),
        decision: "deny",
        detail: {
          kind: e.kind,
          spaceId: e.spaceId,
          reasons: e.reasons.slice(0, 5),
          ...(e.workerId ? { workerId: e.workerId } : {}),
          ...(e.threadId ? { threadId: e.threadId } : {}),
        },
      });
    } catch {
      // the row is a record, the tab is already stopped
    }
    if (e.outcome !== "stopped") return;
    let where = e.url.slice(0, 120);
    try {
      where = new URL(e.url).host;
    } catch {
      // keep the raw text
    }
    emit(e, "error", {
      code: CHANNEL_STOPPED,
      message: `瀏覽器分頁經 WebSocket（${where}）送出了疑似需要你確認的資料（${e.actionClass}），Alca 事後才看得到，已停止這個分頁。這個動作可能已經生效，請到該網站確認。`,
      retryable: false,
    } as EventData<"error">);
  };
}

export function networkConfirmer(
  core: AlcaCore,
  agents?: AgentSystem,
  o: NetworkConfirmOptions = {},
): NetworkConfirm {
  const emit = runEmitter(core, agents);
  return async (req, signal) => {
    const auth = core.gateway.authorize(
      {
        initiator: { kind: "agent", id: req.botId },
        actor: { kind: "agent", id: req.botId },
        action: "browser_network",
        actionClass: req.actionClass,
        target: req.url,
        args: { method: req.method, url: req.url, reasons: req.reasons, spaceId: req.spaceId },
      },
      {
        botId: req.botId,
        ...(req.threadId ? { threadId: req.threadId } : {}),
        ...(req.workerId ? { workerId: req.workerId } : {}),
        summary: req.summary,
      },
    );
    if (auth.decision.effect === "allow") return true;
    if (auth.decision.effect === "deny" || !auth.approvalId) return false;
    const id = auth.approvalId;
    const shown = emit(req, "approval.requested", {
      approvalId: id,
      botId: req.botId,
      ...(req.workerId ? { workerId: req.workerId } : {}),
      actionClass: auth.request.actionClass,
      summary: req.summary,
    } as EventData<"approval.requested">);
    if (!shown) {
      // Nobody would ever see this card: close it instead of leaving it pending.
      core.gateway.resolveApproval(id, "expired", BY);
      return false;
    }
    const deadline = Date.now() + (o.timeoutMs ?? 10 * 60_000);
    const poll = o.pollMs ?? 250;
    let status = core.gateway.approval(id)?.status ?? "expired";
    while (status === "pending") {
      if (signal.aborted || Date.now() > deadline) {
        core.gateway.resolveApproval(id, "expired", BY);
        status = core.gateway.approval(id)?.status ?? "expired";
        break;
      }
      await new Promise((r) => setTimeout(r, poll));
      status = core.gateway.approval(id)?.status ?? "expired";
    }
    const rec = core.gateway.approval(id);
    const by = rec?.resolvedBy ?? BY;
    const kind = (["user", "agent", "tool", "system"] as const).find((k) => k === by.kind) ?? "system";
    emit(req, "approval.resolved", {
      approvalId: id,
      decision: status === "approved" ? "approved" : status === "denied" ? "denied" : "expired",
      by: { kind, id: by.id },
    } as EventData<"approval.resolved">);
    return status === "approved";
  };
}
