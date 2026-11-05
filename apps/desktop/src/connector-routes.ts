import type { IncomingMessage, ServerResponse } from "node:http";
import { type ConnectorsApi, ConnectorsApiError } from "./connectors-api.ts";
import { HttpError, json, readJson } from "./http.ts";

/**
 * Connected apps + routines (P6), loopback only:
 *
 *   GET    /api/connectors                              status: key set?, apps, accounts by app, bots, usage, relay
 *   PUT    /api/connectors/key           {key}          check with Composio, then keep in the vault (never returned)
 *   DELETE /api/connectors/key
 *   POST   /api/connectors/refresh
 *   POST   /api/connectors/accounts      {toolkit, label, botId?}  → {account, redirectUrl} (open it to authorize)
 *   PATCH  /api/connectors/accounts/:id  {label}
 *   DELETE /api/connectors/accounts/:id                 disconnect (at Composio and here)
 *   PUT    /api/connectors/accounts/:id/bots/:botId {access: read|act|null}
 *   POST   /api/connectors/accounts/:id/triggers {slug, threadId?, mode?, semantic?, routine?, config?}
 *   Next round R8:
 *   GET    /api/connectors/mcp                                     the person's MCP servers (secret names only)
 *   PUT    /api/connectors/mcp/:id       {label, transport, command?, args?, cwd?, url?, secrets?, enabled?, botId?}
 *                                                                  add or change a server — needs the approve key
 *   POST   /api/connectors/mcp/:id/check
 *   DELETE /api/connectors/mcp/:id
 *   GET    /api/connectors/logins                       website logins (never a password)
 *   POST   /api/connectors/logins        {origin, password, username?, label?, botIds?}  approve key
 *   DELETE /api/connectors/logins/:id                   approve key
 *   GET    /api/routines                                routines + ready drafts
 *   POST   /api/routines                 {threadId?, name, kind, intervalSec|cron+tz|runAt|triggerId, check, instructions?, speculative?}
 *   POST   /api/routines/:id/enable | /disable | /run
 *   DELETE /api/routines/:id
 *   POST   /api/drafts/:id/use | /discard
 */
export async function connectorRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  api: ConnectorsApi | undefined,
): Promise<boolean> {
  const [, a, b, c, d, e] = parts;
  if (a !== "connectors" && a !== "routines" && a !== "drafts") return false;
  if (!api) throw new HttpError(404, "connectors are off");
  const method = req.method ?? "GET";
  const ok = (status: number, value: unknown) => {
    json(res, status, value);
    return true;
  };
  try {
    if (a === "connectors") {
      if (!b && method === "GET")
        return ok(200, await api.status({ refresh: url.searchParams.get("refresh") !== "0" }));
      if (b === "key" && method === "PUT") return ok(200, await api.setKey(await readJson(req, 8 * 1024)));
      if (b === "key" && method === "DELETE") return ok(200, await api.clearKey());
      if (b === "refresh" && method === "POST") return ok(200, await api.refresh());
      // Design §0.2.7: website logins; the body (with the password) is read here and never echoed.
      if (b === "logins" && !c && method === "GET") return ok(200, await api.logins.list());
      if (b === "logins" && !c && method === "POST")
        return ok(201, await api.logins.save(await readJson(req, 8 * 1024)));
      if (b === "logins" && c && !d && method === "DELETE") return ok(200, await api.logins.remove(c));
      if (b === "accounts" && !c && method === "POST") return ok(201, await api.connect(await readJson(req)));
      if (b === "accounts" && c && !d && method === "PATCH")
        return ok(200, api.rename(c, await readJson(req)));
      if (b === "accounts" && c && !d && method === "DELETE") return ok(200, await api.disconnect(c));
      if (b === "accounts" && c && d === "bots" && e && method === "PUT")
        return ok(200, api.grant(c, e, await readJson(req)));
      if (b === "accounts" && c && d === "triggers" && !e && method === "POST")
        return ok(201, await api.enableTrigger(c, await readJson(req)));
      if (b === "mcp" && !c && method === "GET") return ok(200, { servers: api.servers() });
      if (b === "mcp" && c && !d && method === "PUT")
        return ok(200, await api.saveServer(c, await readJson(req, 64 * 1024)));
      if (b === "mcp" && c && d === "check" && method === "POST") return ok(200, await api.checkServer(c));
      if (b === "mcp" && c && !d && method === "DELETE") return ok(200, await api.removeServer(c));
    } else if (a === "routines") {
      if (!b && method === "GET") return ok(200, api.listRoutines(url.searchParams.get("bot") ?? undefined));
      if (!b && method === "POST") return ok(201, api.createRoutine(await readJson(req)));
      if (b && c === "enable" && method === "POST") return ok(200, api.setRoutineEnabled(b, true));
      if (b && c === "disable" && method === "POST") return ok(200, api.setRoutineEnabled(b, false));
      if (b && c === "run" && method === "POST") return ok(200, await api.runRoutine(b));
      if (b && !c && method === "DELETE") return ok(200, api.removeRoutine(b));
    } else {
      if (!b && method === "GET") return ok(200, api.drafts(url.searchParams.get("thread") ?? undefined));
      if (b && c === "use" && method === "POST") return ok(200, api.useDraft(b));
      if (b && c === "discard" && method === "POST") return ok(200, api.discardDraft(b));
    }
  } catch (err) {
    if (err instanceof ConnectorsApiError) throw new HttpError(err.status, err.message);
    throw err;
  }
  throw new HttpError(404, "not found");
}
