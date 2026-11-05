import { RpcError } from "@alca/link";
import { type ConnectorsApi, ConnectorsApiError } from "./connectors-api.ts";

/**
 * Connected apps + routines for the phone (P6). Reading needs `chat`;
 * anything that changes which accounts exist or what a bot may use, and
 * turning routines on / off / running them, needs `approve`. The Composio key
 * is never entered or shown on the phone (desktop only).
 *
 * Next round R8: MCP accounts are seen here but set up on the desktop only
 * (no server add / change on the phone);
 * the phone can lower a bot's access to them or disconnect them.
 *
 * P13: `routines.create` (needs `approve`) adds a scheduled routine from the
 * phone through the same `ConnectorsApi.createRoutine` as the desktop, so the
 * same checks (a name, a known check, interval ≥ 60 s, a valid cron + IANA
 * zone, a time for a single run). The phone form is the desktop's simple one:
 * every N minutes / hours, daily at a time, or once; an app check; what to do
 * with new items; 提前做. Event (trigger) routines are made on the computer.
 */

const ROUTINE_FIELDS = new Set([
  "name",
  "kind",
  "intervalSec",
  "cron",
  "tz",
  "runAt",
  "check",
  "instructions",
  "speculative",
  "threadId",
  "botId",
]);

/** The phone's routine request, checked for shape before the shared validation runs. */
export function phoneRoutine(a: Record<string, unknown>): Record<string, unknown> {
  const extra = Object.keys(a).filter((k) => !ROUTINE_FIELDS.has(k));
  if (extra.length) throw new RpcError("bad_request", `手機上不能設定：${extra.join("、")}`);
  if (a.kind !== "interval" && a.kind !== "cron" && a.kind !== "once")
    throw new RpcError("bad_request", "手機上可以建立：每隔一段時間、每天固定時間、或只跑一次");
  const check = a.check as Record<string, unknown> | undefined;
  if (!check || typeof check !== "object" || check.kind !== "app" || typeof check.app !== "string")
    throw new RpcError("bad_request", "要選一個要檢查的 app");
  const out: Record<string, unknown> = {
    name: a.name,
    kind: a.kind,
    check: {
      kind: "app",
      app: check.app.slice(0, 64),
      ...(typeof check.account === "string" ? { account: check.account.slice(0, 64) } : {}),
    },
    instructions: typeof a.instructions === "string" ? a.instructions.slice(0, 4000) : "",
    speculative: a.speculative === true,
  };
  for (const k of ["intervalSec", "cron", "tz", "runAt", "threadId"] as const)
    if (a[k] !== undefined) out[k] = a[k];
  return out;
}

type Op = ["chat" | "approve", (a: Record<string, unknown>) => unknown];

const id = (a: Record<string, unknown>, k: string) => {
  const v = a[k];
  if (typeof v !== "string" || !v || v.length > 64) throw new RpcError("bad_request", `${k} is required`);
  return v;
};

async function mapped<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConnectorsApiError)
      throw new RpcError(
        e.status === 404 ? "not_found" : e.status === 409 ? "conflict" : "bad_request",
        e.message,
      );
    throw e;
  }
}

/** What the phone sees of the status: whether a key is set, never any part of it. */
function forPhone<T extends { keyPreview?: unknown; keyStore?: unknown }>(st: T) {
  const { keyPreview: _p, keyStore: _s, ...rest } = st;
  return rest;
}

export function connectorOps(
  api: ConnectorsApi | undefined,
  /** P13: the conversation a new routine reports to, started with the bot the phone picked. */
  threadFor?: (name: string, botId: unknown) => string,
): Record<string, Op> {
  const c = () => {
    if (!api) throw new RpcError("unavailable", "connectors are off");
    return api;
  };
  return {
    "connectors.status": ["chat", () => mapped(async () => forPhone(await c().status()))],
    "connectors.refresh": ["chat", () => mapped(async () => forPhone(await c().refresh()))],
    "connectors.connect": [
      "approve",
      (a) =>
        mapped(() =>
          c().connect({ toolkit: a.toolkit, label: a.label, ...(a.botId ? { botId: a.botId } : {}) }),
        ),
    ],
    "connectors.disconnect": ["approve", (a) => mapped(() => c().disconnect(id(a, "accountId")))],
    // Design §0.2.7: the phone lists and removes website logins; adding one is desktop-only
    // (a password never travels the relay).
    "connectors.logins": ["chat", () => mapped(() => c().logins.list())],
    "connectors.logins.remove": ["approve", (a) => mapped(() => c().logins.remove(id(a, "loginId")))],
    "connectors.grant": [
      "approve",
      (a) =>
        mapped(() => c().grantFromPhone(id(a, "accountId"), id(a, "botId"), { access: a.access ?? null })),
    ],
    "routines.list": ["chat", () => mapped(() => c().listRoutines())],
    "routines.enable": [
      "approve",
      (a) => mapped(() => c().setRoutineEnabled(id(a, "routineId"), a.enabled !== false)),
    ],
    "routines.create": [
      "approve",
      (a) => {
        const body = phoneRoutine(a);
        return mapped(() => {
          const api = c();
          if (!body.threadId && a.botId !== undefined && threadFor)
            body.threadId = threadFor(String(body.name ?? "").slice(0, 40) || "例行工作", a.botId);
          return api.createRoutine(body);
        });
      },
    ],
    "routines.run": ["approve", (a) => mapped(() => c().runRoutine(id(a, "routineId")))],
    "drafts.use": ["chat", (a) => mapped(() => c().useDraft(id(a, "draftId")))],
    "drafts.discard": ["chat", (a) => mapped(() => c().discardDraft(id(a, "draftId")))],
  };
}
