import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, json, readJson } from "./http.ts";
import { type TeamApi, TeamApiError } from "./team-api.ts";
import { carriedApproveKey } from "./ui-session.ts";

/**
 * The team (P7), loopback only:
 *
 *   GET    /api/team                        roster (with activity), archived bots, rules, lead, engines
 *   GET    /api/bots                        the roster
 *   POST   /api/bots                        {name, role?, avatar?, color?, instructions?, engineId?, model?,
 *                                            approvalLevel?, browserProfile?, memoryMode?}
 *   PATCH  /api/bots/:id                    same fields
 *   POST   /api/bots/:id/archive | /restore
 *   POST   /api/team/lead                   {botId | null}
 *   PATCH  /api/team/rules                  {peerApproval?, maxDepth?, maxOpen?}
 *   GET    /api/peers?thread=&bot=&full=1   bot-to-bot requests (a conversation's, or a bot's)
 *   GET    /api/peers/:id                   one request + its trail + its peer conversation
 *   POST   /api/peers/:id/stop
 *
 * Turning a bot's 完全授權 on (`approvalLevel: "full_access"` on a bot that
 * does not have it) needs the approve key, like every other raise of a
 * permission; turning it off does not. Loosening a bot's OS sandbox
 * (`sandbox`: a weaker mode, the network opened, a new writable folder)
 * needs it too.
 *
 * Custom model services are added through /api/providers (P11, provider-routes.ts).
 */
export async function teamRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  api: TeamApi | undefined,
): Promise<boolean> {
  const [, a, b, c] = parts;
  if (a !== "team" && a !== "bots" && a !== "peers") return false;
  if (!api) return false;
  const method = req.method ?? "GET";
  const ok = (status: number, value: unknown) => {
    json(res, status, value);
    return true;
  };
  try {
    if (a === "team") {
      if (!b && method === "GET") return ok(200, api.team());
      if (b === "lead" && method === "POST") return ok(200, api.setLead(await readJson(req)));
      if (b === "rules" && method === "PATCH") return ok(200, api.setRules(await readJson(req)));
    }
    if (a === "bots") {
      if (!b && method === "GET") return ok(200, api.team().bots);
      const keyed = { fullAccessApproved: carriedApproveKey(req) };
      if (!b && method === "POST") return ok(201, api.create(await readJson(req), keyed));
      if (b && !c && method === "PATCH") return ok(200, api.update(b, await readJson(req), keyed));
      if (b && c === "archive" && method === "POST") return ok(200, api.archive(b));
      if (b && c === "restore" && method === "POST") return ok(200, api.restore(b));
    }
    if (a === "peers") {
      if (!b && method === "GET") return ok(200, api.peers(Object.fromEntries(url.searchParams)));
      if (b && !c && method === "GET") return ok(200, api.peer(b));
      if (b && c === "stop" && method === "POST") return ok(200, await api.stopPeer(b));
    }
  } catch (e) {
    if (e instanceof TeamApiError) throw new HttpError(e.status, e.message);
    throw e;
  }
  throw new HttpError(404, "not found");
}
