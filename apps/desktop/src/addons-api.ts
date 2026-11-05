import { AddonError, type AddonView, type AgentSystem } from "@alca/core";
import { tSource } from "@alca/design/i18n";
import { RpcError } from "@alca/link";
import type { OfferRecord } from "@alca/store";
import { HttpError, json } from "./http.ts";
import type { Mount } from "./routes.ts";

/**
 * Add-ons per bot (P14), shared by the loopback routes (desktop) and the Link
 * ops (phone). The registry is built in; this only lists a bot's add-ons with
 * today's usage and turns one on / off or changes its settings, through the
 * same `AddonService` checks (requirements, the add-on's own schema).
 *
 *   GET   /api/bots/:id/addons
 *   PATCH /api/bots/:id/addons/:addonId   {enabled?, settings?}
 *   GET   /api/offers?botId=               the 主動留意 cards waiting for an answer
 *   POST  /api/offers/:id/answer           {choice: yes | later | never}
 *
 * Link: `team.bots.addons.list` (chat), `team.bots.addons.set` (approve),
 * `offers.list` (chat), `offers.answer` (approve: 好 starts work).
 */
export interface OfferView {
  id: string;
  botId: string;
  threadId: string | null;
  category: string;
  text: string;
  status: string;
  dueAt: string | null;
  shownAt: string | null;
  workerId: string | null;
}

const offerView = (o: OfferRecord): OfferView => ({
  id: o.id,
  botId: o.botId,
  threadId: o.threadId,
  category: o.category,
  text: o.text,
  status: o.status,
  dueAt: o.dueAt,
  shownAt: o.shownAt,
  workerId: o.workerId,
});

export class AddonsApi {
  private readonly agents: AgentSystem | undefined;
  constructor(agents: AgentSystem | undefined) {
    this.agents = agents;
  }

  private get service() {
    if (!this.agents) throw new AddonError(404, tSource("core.addons.needsRouter"));
    return this.agents.addons;
  }

  list(botId: string): { botId: string; addons: AddonView[] } {
    return { botId, addons: this.service.list(botId) };
  }

  /** P14 C: the add-on cards waiting for an answer (the phone's 待處理, the desktop strip). */
  offers(botId?: string): { offers: OfferView[] } {
    if (!this.agents) throw new AddonError(404, tSource("core.addons.needsRouter"));
    if (botId && !this.agents.core.store.bots.get(botId))
      throw new AddonError(404, tSource("core.common.noBot"));
    return { offers: this.agents.proactive.pending(botId).map(offerView) };
  }

  /** 好 / 先不用 / 別再提這類 on a card. */
  answer(offerId: string, choice: unknown): OfferView {
    if (!this.agents) throw new AddonError(404, tSource("core.addons.needsRouter"));
    if (choice !== "yes" && choice !== "later" && choice !== "never")
      throw new AddonError(400, tSource("core.addons.choice"));
    try {
      return offerView(this.agents.proactive.answer(offerId, choice));
    } catch (e) {
      if (e instanceof Error && e.message === "沒有這個提議") throw new AddonError(404, e.message);
      throw e;
    }
  }

  set(botId: string, addonId: string, body: Record<string, unknown>): AddonView {
    const extra = Object.keys(body).filter(
      (k) => k !== "enabled" && k !== "settings" && k !== "botId" && k !== "addonId",
    );
    if (extra.length)
      throw new AddonError(400, tSource("core.addons.unknownFields", { fields: extra.join(", ") }));
    return this.service.set(botId, addonId, {
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.settings !== undefined ? { settings: body.settings } : {}),
    });
  }
}

const http = (e: unknown): never => {
  if (e instanceof AddonError) throw new HttpError(e.status, e.message);
  throw e;
};

/** Loopback routes: mounted ahead of the team area, answers only its own paths. */
export function addonMount(): Mount {
  return {
    areas: ["bots"],
    handle: async (r) => {
      const [, , botId, sub, addonId, more] = r.parts;
      if (sub !== "addons" || !botId || more) return false;
      const api = new AddonsApi(r.ctx.agents);
      const method = r.req.method ?? "GET";
      try {
        if (!addonId && method === "GET") {
          json(r.res, 200, api.list(botId));
          return true;
        }
        if (addonId && method === "PATCH") {
          json(r.res, 200, api.set(botId, addonId, await r.body()));
          return true;
        }
      } catch (e) {
        http(e);
      }
      throw new HttpError(405, "method not allowed");
    },
  };
}

/** P14 C: /api/offers… */
export function offerMount(): Mount {
  return {
    areas: ["offers"],
    handle: async (r) => {
      const [, , id, sub, more] = r.parts;
      const api = new AddonsApi(r.ctx.agents);
      const method = r.req.method ?? "GET";
      try {
        if (!id && method === "GET") {
          json(r.res, 200, api.offers(r.url.searchParams.get("botId") || undefined));
          return true;
        }
        if (id && sub === "answer" && !more && method === "POST") {
          json(r.res, 200, api.answer(id, (await r.body()).choice));
          return true;
        }
      } catch (e) {
        http(e);
      }
      throw new HttpError(405, "method not allowed");
    },
  };
}

type Op = ["chat" | "approve", (a: Record<string, unknown>) => unknown];

const str = (a: Record<string, unknown>, k: string) => {
  const v = a[k];
  if (typeof v !== "string" || !v || v.length > 64) throw new RpcError("bad_request", `${k} is required`);
  return v;
};

const rpc = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AddonError)
      throw new RpcError(
        e.status === 404 ? "not_found" : e.status === 409 ? "conflict" : "bad_request",
        e.message,
      );
    throw e;
  }
};

/** Phone ops: reading needs `chat`; turning an add-on on / off or changing it needs `approve`. */
export function addonOps(agents: AgentSystem | undefined): Record<string, Op> {
  const api = new AddonsApi(agents);
  return {
    "team.bots.addons.list": ["chat", (a) => rpc(() => api.list(str(a, "botId")))],
    "team.bots.addons.set": [
      "approve",
      (a) => {
        const { botId: _b, addonId: _a, ...body } = a;
        return rpc(() => api.set(str(a, "botId"), str(a, "addonId"), body));
      },
    ],
    "offers.list": [
      "chat",
      (a) => rpc(() => api.offers(typeof a.botId === "string" && a.botId ? a.botId : undefined)),
    ],
    "offers.answer": ["approve", (a) => rpc(() => api.answer(str(a, "offerId"), a.choice))],
  };
}
