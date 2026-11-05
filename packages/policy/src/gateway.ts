import type { DatabaseSync } from "node:sqlite";
import type { PermissionLevelT } from "@alca/config";
import { newId } from "@alca/protocol";
import { type ApprovalRecord, appendAudit, type HumanInputRepo } from "@alca/store";
import { escalate, shellFloor } from "./classify.ts";
import { type ActionClass, type ActionRequest, decide, isActionClass, type PolicyDecision } from "./rules.ts";

export class PolicyDeniedError extends Error {
  readonly decision: PolicyDecision;
  constructor(decision: PolicyDecision) {
    super(`action not authorized: ${decision.reason}`);
    this.name = "PolicyDeniedError";
    this.decision = decision;
  }
}

/** The outcome of resolve → decide → audit for one action. */
export interface Authorization {
  request: ActionRequest & { actionClass: ActionClass };
  decision: PolicyDecision;
  auditId: number;
  /** Set when the decision is "ask": the persisted approval card. */
  approvalId?: string;
}

export interface AuthorizeContext {
  runId?: string;
  callId?: string;
  /** Human-readable line for the approval card. */
  summary?: string;
  /** Bot whose action this is (recorded on the card and in the audit detail). */
  botId?: string;
  /** Worker session whose call this is (P3; recorded on the card and in the audit detail). */
  workerId?: string;
  /** Conversation the call runs in (P7: a peer conversation narrows the level to the strictest bot of its chain). */
  threadId?: string;
  /**
   * P13: a host check (the shell review, an edit outside the bot's folder)
   * wants a person for a call the rules and level would allow: an `allow`
   * becomes `ask` with this reason. Never loosens a decision.
   */
  escalate?: string;
  /**
   * P13: nobody is there to answer (提前做 in the background): a call that
   * would need a card is denied with this reason instead. Never loosens.
   */
  noAsk?: string;
  /**
   * Review 2026-11-04b S2.1: a host check refuses the call outright (a native
   * tool reaching Alca's data folder): any decision becomes deny with this
   * reason. Never loosens.
   */
  deny?: string;
}

export interface GatewayOptions {
  db: DatabaseSync;
  human: HumanInputRepo;
  /** Read on every decision so edited rules apply to the next call. */
  rules: () => readonly unknown[];
  /** Read per decision: the level can depend on the bot (and its delegation chain, P7). */
  level: (ctx: AuthorizeContext) => PermissionLevelT;
  now?: () => Date;
  /** Approval ids must look like protocol ids (`apr_…`). */
  newApprovalId?: () => string;
}

function summarize(req: ActionRequest): string {
  const cmd = typeof req.args?.command === "string" ? `：${req.args.command}` : "";
  const target = req.target ? `（${req.target}）` : "";
  return `${req.action}${target}${cmd}`.slice(0, 500);
}

/**
 * Host-frozen floors after the rules and the level, at every level and over
 * any allow rule (deny still wins):
 * - a shell command Alca cannot vouch for asks (review 2026-11-04b H1,
 *   shell-safe.ts).
 */
function withFloor(req: ActionRequest, decision: PolicyDecision, level?: PermissionLevelT): PolicyDecision {
  if (decision.effect !== "allow") return decision;
  const shell = shellFloor(req.action, req.args ?? {}, level === "full_access");
  return shell ? { effect: "ask", reason: shell } : decision;
}

/**
 * The single action gateway: resolve → decide → write audit → execute.
 * The audit row is written before anything runs, and `execute` re-checks the
 * persisted approval instead of trusting the caller.
 */
export class ActionGateway {
  private readonly o: GatewayOptions;
  constructor(opts: GatewayOptions) {
    this.o = opts;
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  /** Normalize the request: validate the class and escalate obvious sends / deletes / publishes. */
  resolve(req: ActionRequest): ActionRequest & { actionClass: ActionClass } {
    const declared = isActionClass(req.actionClass) ? req.actionClass : undefined;
    if (!declared) return { ...req, actionClass: req.actionClass as ActionClass };
    return { ...req, actionClass: escalate(declared, req.action, req.args ?? {}) };
  }

  /** The permission level a call in this context runs under. */
  levelOf(ctx: AuthorizeContext = {}): PermissionLevelT {
    return this.o.level(ctx);
  }

  /** The decision this request would get, with no audit row and no card (P13: whether a review is worth asking). */
  preview(req: ActionRequest, ctx: AuthorizeContext = {}): PolicyDecision {
    try {
      const resolved = this.resolve(req);
      const level = this.o.level(ctx);
      return withFloor(resolved, decide(this.o.rules(), resolved, level), level);
    } catch (err) {
      return { effect: "deny", reason: `policy error: ${String(err)}` };
    }
  }

  authorize(req: ActionRequest, ctx: AuthorizeContext = {}): Authorization {
    const resolved = this.resolve(req);
    let decision: PolicyDecision;
    try {
      const level = this.o.level(ctx);
      decision = withFloor(resolved, decide(this.o.rules(), resolved, level), level);
    } catch (err) {
      decision = { effect: "deny", reason: `policy error: ${String(err)}` };
    }
    // Host checks only ever tighten: allow → ask (escalate), ask → deny (nobody to ask).
    if (decision.effect === "allow" && ctx.escalate)
      decision = { effect: "ask", reason: ctx.escalate.slice(0, 300) };
    if (decision.effect === "ask" && ctx.noAsk)
      decision = { effect: "deny", reason: ctx.noAsk.slice(0, 300) };
    if (ctx.deny) decision = { effect: "deny", reason: ctx.deny.slice(0, 300) };
    const now = this.now();
    const audit = appendAudit(this.o.db, {
      ts: now.toISOString(),
      initiator: resolved.initiator,
      actor: resolved.actor,
      action: resolved.action,
      actionClass: resolved.actionClass,
      ...(resolved.target ? { target: resolved.target } : {}),
      decision: decision.effect,
      detail: {
        reason: decision.reason,
        ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
        ...(decision.grant ? { grant: decision.grant } : {}),
        ...(ctx.runId ? { runId: ctx.runId } : {}),
        ...(ctx.callId ? { callId: ctx.callId } : {}),
        ...(ctx.botId ? { botId: ctx.botId } : {}),
        ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
        ...(resolved.args ? { args: resolved.args } : {}),
      },
    });
    const out: Authorization = { request: resolved, decision, auditId: audit.id };
    if (decision.effect === "ask") {
      const id = this.o.newApprovalId?.() ?? newId("approval", now.getTime());
      this.o.human.requestApproval(
        {
          id,
          runId: ctx.runId ?? null,
          callId: ctx.callId ?? null,
          actionClass: resolved.actionClass,
          summary: ctx.summary ?? summarize(resolved),
          detail: { action: resolved.action, args: resolved.args ?? {}, reason: decision.reason },
          ...(ctx.botId ? { botId: ctx.botId } : {}),
          ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
        },
        now,
      );
      out.approvalId = id;
    }
    return out;
  }

  approval(id: string): ApprovalRecord | undefined {
    return this.o.human.approval(id);
  }

  /**
   * Resolve an approval card once. A second call (another device, a double
   * click) returns `{ resolved: false }` and changes nothing.
   */
  resolveApproval(
    id: string,
    decision: "approved" | "denied" | "expired",
    by: { kind: "user" | "agent" | "tool" | "system"; id: string },
  ): { resolved: boolean; record: ApprovalRecord | undefined } {
    const now = this.now();
    const resolved = this.o.human.resolveApproval(id, decision, by, now);
    const record = this.o.human.approval(id);
    if (resolved && record) {
      const detail = record.detail as { action?: unknown };
      appendAudit(this.o.db, {
        ts: now.toISOString(),
        initiator: { kind: by.kind === "user" ? "user" : "agent", id: by.id },
        actor: by,
        action: typeof detail.action === "string" ? detail.action : "approval",
        actionClass: record.actionClass,
        decision: decision === "approved" ? "allow" : "deny",
        detail: { approvalId: id, resolution: decision, ...(record.runId ? { runId: record.runId } : {}) },
      });
    }
    return { resolved, record };
  }

  /** Is this authorization good to execute right now (re-reads the approval)? */
  isAuthorized(auth: Authorization): boolean {
    if (auth.decision.effect === "allow") return true;
    if (auth.decision.effect === "deny" || !auth.approvalId) return false;
    return this.o.human.approval(auth.approvalId)?.status === "approved";
  }

  /** Run `fn` only when authorized; otherwise throw PolicyDeniedError. */
  async execute<T>(auth: Authorization, fn: () => Promise<T> | T): Promise<T> {
    if (!this.isAuthorized(auth)) {
      const status = auth.approvalId ? this.o.human.approval(auth.approvalId)?.status : undefined;
      throw new PolicyDeniedError(
        status && status !== "approved"
          ? { effect: "deny", reason: `approval ${status}` }
          : auth.decision.effect === "deny"
            ? auth.decision
            : { effect: "deny", reason: "approval not granted" },
      );
    }
    return await fn();
  }

  /**
   * One-shot path for callers without their own approval UI loop:
   * allow → execute now; deny → throw; ask → return the pending approval id.
   */
  async submit<T>(
    req: ActionRequest,
    fn: () => Promise<T> | T,
    ctx: AuthorizeContext = {},
  ): Promise<{ status: "done"; value: T; auth: Authorization } | { status: "pending"; auth: Authorization }> {
    const auth = this.authorize(req, ctx);
    if (auth.decision.effect === "ask") return { status: "pending", auth };
    const value = await this.execute(auth, fn);
    return { status: "done", value, auth };
  }

  /** On restart nobody is waiting for old cards: expire them so they cannot be approved late. */
  expireAllPending(): number {
    let n = 0;
    for (const a of this.o.human.pendingApprovals()) {
      if (this.resolveApproval(a.id, "expired", { kind: "system", id: "recovery" }).resolved) n++;
    }
    return n;
  }
}
