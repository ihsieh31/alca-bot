import { RpcError } from "@alca/link";
import { type TeamApi, TeamApiError } from "./team-api.ts";

/**
 * The team for the phone (P7). Reading the roster, a bot's profile and the
 * bot-to-bot trail needs `chat` (the phone already sees the conversations the
 * trail came from); stopping a running request needs `approve`.
 *
 * P13: the phone may add a bot and edit a bot's simple fields (name, avatar,
 * colour, role, instructions, approval level) with `approve` — the same
 * `TeamApi.create` / `update` the desktop uses, so the same validation (a
 * name, unique, ≤ 12 bots, known colour and level). Provider, model, browser
 * profile and memory mode stay on the computer: a phone that sends them is
 * refused, not ignored. No model-service keys or base URLs cross Link: an
 * engine is a label.
 */

/** What the phone may set on a bot (P13). Anything else in the request is an error. */
export const PHONE_BOT_FIELDS = ["name", "avatar", "color", "role", "instructions", "approvalLevel"] as const;

function botFields(a: Record<string, unknown>): Record<string, unknown> {
  const extra = Object.keys(a).filter(
    (k) => k !== "botId" && !(PHONE_BOT_FIELDS as readonly string[]).includes(k),
  );
  if (extra.length) throw new RpcError("bad_request", `手機上不能改：${extra.join("、")}（請在電腦上設定）`);
  // Phase 5: 完全授權 is turned on only on the computer, in the bot's settings.
  if (a.approvalLevel === "full_access")
    throw new RpcError("bad_request", "完全授權只能在電腦上的 bot 設定裡開啟");
  const out: Record<string, unknown> = {};
  for (const k of PHONE_BOT_FIELDS) if (a[k] !== undefined) out[k] = a[k];
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
    if (e instanceof TeamApiError)
      throw new RpcError(
        e.status === 404 ? "not_found" : e.status === 409 ? "conflict" : "bad_request",
        e.message,
      );
    throw e;
  }
}

export function teamOps(api: TeamApi | undefined): Record<string, Op> {
  const t = () => {
    if (!api) throw new RpcError("unavailable", "the team is off");
    return api;
  };
  return {
    "team.get": [
      "chat",
      () =>
        mapped(() => {
          const v = t().team();
          return {
            bots: v.bots,
            rules: v.rules,
            leadId: v.leadId,
            defaultBotId: v.defaultBotId,
            // P11: shown read-only on the phone (provider, kind, default model); keys never leave the computer.
            engines: v.engines.map((e) => ({ id: e.id, label: e.label, kind: e.kind, model: e.model })),
          };
        }),
    ],
    "peers.list": [
      "chat",
      (a) =>
        mapped(() =>
          t().peers({
            ...(typeof a.threadId === "string" ? { thread: a.threadId } : {}),
            ...(typeof a.botId === "string" ? { bot: a.botId } : {}),
            limit: String(Math.min(Number(a.limit) || 40, 100)),
          }),
        ),
    ],
    "peers.get": ["chat", (a) => mapped(() => t().peer(id(a, "requestId")))],
    "peers.stop": ["approve", (a) => mapped(() => t().stopPeer(id(a, "requestId")))],
    "team.bots.create": ["approve", (a) => mapped(() => t().create(botFields(a)))],
    "team.bots.update": [
      "approve",
      (a) => {
        const botId = id(a, "botId");
        const fields = botFields(a);
        if (!Object.keys(fields).length) throw new RpcError("bad_request", "沒有要改的欄位");
        return mapped(() => t().update(botId, fields));
      },
    ],
  };
}

/** Who answers a phone message (an explicit bot or an @name at the start), as on the desktop. */
export function phoneAddressee(
  api: TeamApi | undefined,
  threadId: string,
  text: string,
  botId: unknown,
): string | undefined {
  if (!api) return undefined;
  try {
    return api.addressee(threadId, text, botId);
  } catch (e) {
    if (e instanceof TeamApiError) throw new RpcError("bad_request", e.message);
    throw e;
  }
}
