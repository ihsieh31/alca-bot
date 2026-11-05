import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, json, readJson } from "./http.ts";
import { ProviderError } from "./providers.ts";
import type { TeamApi } from "./team-api.ts";

/**
 * 模型與供應商 (P11), loopback only. Keys go in, never out: every answer is a
 * view that says `hasKey`, nothing more.
 *
 *   GET    /api/providers?fresh=1          every provider with status + one-line fix
 *   POST   /api/providers                  {kind: acp|openai|anthropic, label, command? | baseUrl?, key?, keyEnv?, models?}
 *   GET    /api/providers/:id
 *   PATCH  /api/providers/:id              {baseUrl?, command?, family?, defaultModel?}  (built-in)
 *   DELETE /api/providers/:id              (custom)
 *   PUT    /api/providers/:id/key          {key}  → local vault
 *   DELETE /api/providers/:id/key
 *   GET    /api/providers/:id/models?refresh=1
 */
export async function providerRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  team: TeamApi | undefined,
): Promise<boolean> {
  const [, a, id, sub, extra] = parts;
  if (a !== "providers") return false;
  const svc = team?.providers;
  if (!svc) return false;
  const method = req.method ?? "GET";
  const ok = (status: number, value: unknown) => {
    json(res, status, value);
    return true;
  };
  const changed = () => team?.changed("providers");
  try {
    if (!id) {
      if (method === "GET")
        return ok(200, { providers: await svc.list({ fresh: url.searchParams.get("fresh") === "1" }) });
      if (method === "POST") {
        const v = await svc.addCustom(await readJson(req, 16 * 1024));
        changed();
        return ok(201, v);
      }
    } else if (!sub) {
      if (method === "GET") return ok(200, await svc.one(id, url.searchParams.get("fresh") === "1"));
      if (method === "PATCH") {
        const v = await svc.update(id, await readJson(req, 16 * 1024));
        changed();
        return ok(200, v);
      }
      if (method === "DELETE") {
        const removed = await svc.removeCustom(id);
        changed();
        return ok(200, { removed });
      }
    } else if (sub === "key" && !extra) {
      if (method === "PUT" || method === "POST") {
        const body = await readJson(req, 4 * 1024);
        const v = await svc.setKey(id, body.key);
        changed();
        return ok(200, v);
      }
      if (method === "DELETE") {
        const v = await svc.clearKey(id);
        changed();
        return ok(200, v);
      }
    } else if (sub === "models" && !extra && method === "GET")
      return ok(200, await svc.models(id, url.searchParams.get("refresh") === "1"));
  } catch (e) {
    if (e instanceof ProviderError) throw new HttpError(e.status, e.message);
    throw e;
  }
  throw new HttpError(404, "not found");
}
