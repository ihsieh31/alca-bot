import { isAlwaysConfirm, type PermissionLevelT } from "@alca/config";
import { FULL_ACCESS_REASON, fullAccessAllows } from "./full-access.ts";

export const ACTION_CLASSES = Object.freeze([
  "read",
  "write",
  "execute",
  "network",
  "payment",
  "send",
  "delete",
  "publish",
] as const);
export type ActionClass = (typeof ACTION_CLASSES)[number];

export function isActionClass(v: unknown): v is ActionClass {
  return typeof v === "string" && (ACTION_CLASSES as readonly string[]).includes(v);
}

export interface ActionRequest {
  initiator: { kind: "user" | "schedule" | "agent" | "webhook"; id: string };
  actor: { kind: "agent" | "tool" | "system" | "user"; id: string };
  /** Tool or verb name, e.g. "Bash" or "mail.send". */
  action: string;
  actionClass: string;
  target?: string;
  /** Tool arguments, used by the classifier and kept in the audit detail. */
  args?: Record<string, unknown>;
}

export type Effect = "allow" | "deny" | "ask";

export interface PolicyDecision {
  effect: Effect;
  reason: string;
  ruleId?: string;
  /** Phase 5: the call runs only because the bot is at 完全授權 (the ledger records it). */
  grant?: "full_access";
}

/**
 * A user-authored rule. `action` is an exact name, "*" for every action, or a
 * prefix ending in "*" ("mcp__mail__*"). `target` is an optional prefix of the
 * request target (a path or URL).
 */
export interface PolicyRule {
  id: string;
  effect: Effect;
  action: string;
  actionClass?: ActionClass;
  target?: string;
}

const RULE_KEYS = new Set(["id", "effect", "action", "actionClass", "target"]);

/** Returns the problem with a rule, or undefined when it is well formed. */
export function ruleProblem(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "rule is not an object";
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) return `unknown key ${k}`;
  if (typeof r.id !== "string" || r.id.trim() === "") return "id must be a non-empty string";
  if (r.effect !== "allow" && r.effect !== "deny" && r.effect !== "ask")
    return "effect must be allow/deny/ask";
  if (typeof r.action !== "string" || r.action.trim() === "") return "action must be a non-empty string";
  if (
    r.action.includes("*") &&
    !(r.action === "*" || (r.action.endsWith("*") && !r.action.slice(0, -1).includes("*")))
  ) {
    return "action may only use one trailing *";
  }
  if (r.actionClass !== undefined && !isActionClass(r.actionClass)) return "unknown actionClass";
  if (r.target !== undefined && (typeof r.target !== "string" || r.target === ""))
    return "target must be a string";
  return undefined;
}

function actionMatches(pattern: string, action: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return action.startsWith(pattern.slice(0, -1));
  return pattern === action;
}

function matches(r: PolicyRule, req: ActionRequest): boolean {
  if (!actionMatches(r.action, req.action)) return false;
  if (r.actionClass !== undefined && r.actionClass !== req.actionClass) return false;
  if (r.target !== undefined && !(req.target ?? "").startsWith(r.target)) return false;
  return true;
}

/**
 * Rule-only evaluation (P0 contract, kept): deny > ask > allow, a malformed rule
 * makes everything deny, always-confirm classes are never downgraded to allow,
 * no match → ask.
 */
export function evaluate(rules: readonly unknown[], req: ActionRequest): PolicyDecision {
  const hits: PolicyRule[] = [];
  for (const raw of rules) {
    const problem = ruleProblem(raw);
    if (problem) {
      const id = (raw as { id?: unknown } | null)?.id;
      return {
        effect: "deny",
        reason: `malformed rule ${JSON.stringify(typeof id === "string" ? id : null)}: ${problem}`,
        ...(typeof id === "string" ? { ruleId: id } : {}),
      };
    }
    const r = raw as PolicyRule;
    if (matches(r, req)) hits.push(r);
  }
  const pick = (e: Effect) => hits.find((h) => h.effect === e);
  const deny = pick("deny");
  if (deny) return { effect: "deny", reason: "denied by rule", ruleId: deny.id };
  const ask = pick("ask");
  if (ask) return { effect: "ask", reason: "rule requires confirmation", ruleId: ask.id };
  if (isAlwaysConfirm(req.actionClass)) {
    return { effect: "ask", reason: `${req.actionClass} always requires confirmation` };
  }
  const allow = pick("allow");
  if (allow) return { effect: "allow", reason: "allowed by rule", ruleId: allow.id };
  return { effect: "ask", reason: "no matching rule" };
}

/**
 * The full decision: rules first (deny wins, fail closed), then the
 * host-frozen always-confirm classes, then the permission level.
 * - autonomous: anything not denied / not always-confirm runs.
 * - confirm_each_step: reads run; everything else asks unless a rule allows it.
 * - full_access (Phase 5, a bot's own 完全授權): what `autonomous` runs, plus
 *   a plain git push and file deletes (`fullAccessAllows`); payment and
 *   outward sends still ask, and a user's own ask / deny rule still wins.
 */
export function decide(
  rules: readonly unknown[],
  req: ActionRequest,
  level: PermissionLevelT,
): PolicyDecision {
  if (!isActionClass(req.actionClass)) {
    return { effect: "deny", reason: `unknown action class ${JSON.stringify(req.actionClass)}` };
  }
  if (req.action.trim() === "") return { effect: "deny", reason: "empty action" };
  const byRules = evaluate(rules, req);
  if (
    level === "full_access" &&
    byRules.effect !== "deny" &&
    !(byRules.effect === "ask" && byRules.ruleId !== undefined) &&
    fullAccessAllows(req.actionClass, req.action, req.args ?? {})
  )
    return { effect: "allow", reason: FULL_ACCESS_REASON, grant: "full_access" };
  if (byRules.effect === "deny" || byRules.ruleId !== undefined || isAlwaysConfirm(req.actionClass)) {
    return byRules;
  }
  if (level === "autonomous" || level === "full_access")
    return { effect: "allow", reason: "autonomous level" };
  if (req.actionClass === "read") return { effect: "allow", reason: "reads run without asking" };
  return { effect: "ask", reason: "confirm_each_step level" };
}
