import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, json, readJson, send } from "./http.ts";
import { type MemoryApi, MemoryApiError } from "./memory-api.ts";

/**
 * Memory + skills (P5), loopback only:
 *
 *   GET    /api/memory?bot=&q=&kind=&origin=&scope=   items the bot can read (+ counts)
 *   POST   /api/memory                    {body, kind?, scope?, botId?}  the person adds one (confirmed)
 *   GET    /api/memory/export?bot=        JSON download (provenance + history + skills)
 *   POST   /api/memory/forgotten/clear    let Alca learn again what was forgotten
 *   GET    /api/memory/:id                one item + its versions
 *   PATCH  /api/memory/:id                {body?, kind?, scope?}  edit = a new version
 *   POST   /api/memory/:id/confirm        inferred → confirmed
 *   DELETE /api/memory/:id                forget: hard delete of every version + tombstone
 *   GET    /api/skills?bot=&status=proposed
 *   GET    /api/skills/:id
 *   POST   /api/skills/:id/approve        {version?, edit?}
 *   POST   /api/skills/:id/reject         {version?}
 *   PATCH  /api/skills/:id                {name?, description?, triggers?, steps?}  a new version
 *   POST   /api/skills/:id/enable | /disable
 *   DELETE /api/skills/:id
 */
export async function memoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  api: MemoryApi | undefined,
): Promise<boolean> {
  const [, a, b, c] = parts;
  if (a !== "memory" && a !== "skills") return false;
  if (!api) throw new HttpError(404, "memory is off");
  const method = req.method ?? "GET";
  const q = Object.fromEntries(url.searchParams);
  const ok = (status: number, value: unknown) => {
    json(res, status, value);
    return true;
  };
  try {
    if (a === "memory") {
      if (!b && method === "GET") return ok(200, await api.list(q));
      if (!b && method === "POST") return ok(201, api.add(await readJson(req)));
      if (b === "export" && method === "GET") {
        const body = JSON.stringify(api.export(q.bot), null, 2);
        send(res, 200, body, "application/json; charset=utf-8", {
          "content-disposition": `attachment; filename="alca-memory-${new Date().toISOString().slice(0, 10)}.json"`,
        });
        return true;
      }
      if (b === "forgotten" && c === "clear" && method === "POST") return ok(200, api.clearForgotten());
      if (b && !c && method === "GET") return ok(200, api.detail(b, q.bot));
      if (b && !c && method === "PATCH") return ok(200, api.update(b, await readJson(req)));
      if (b && c === "confirm" && method === "POST") return ok(200, api.confirm(b));
      if (b && !c && method === "DELETE") return ok(200, api.forget(b));
    } else {
      if (!b && method === "GET") return ok(200, api.skills(q));
      if (b && !c && method === "GET") return ok(200, api.skillDetail(b));
      if (b && c === "approve" && method === "POST") return ok(200, api.approve(b, await readJson(req)));
      if (b && c === "reject" && method === "POST") return ok(200, api.reject(b, await readJson(req)));
      if (b && !c && method === "PATCH") return ok(200, api.edit(b, await readJson(req)));
      if (b && (c === "enable" || c === "disable") && method === "POST")
        return ok(200, api.setEnabled(b, c === "enable"));
      if (b && !c && method === "DELETE") return ok(200, api.remove(b));
    }
  } catch (e) {
    if (e instanceof MemoryApiError) throw new HttpError(e.status, e.message);
    throw e;
  }
  throw new HttpError(404, "not found");
}
