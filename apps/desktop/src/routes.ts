import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "./app-context.ts";
import { HttpError, json, readJson } from "./http.ts";

/**
 * The desktop's route table (P13): every `/api` endpoint is a row, matched by
 * method + path pattern (`:name` captures one segment). A handler returns the
 * JSON answer (`Reply` for another status), or `undefined` when it wrote the
 * response itself (the event stream). Feature areas whose handlers predate the
 * table are mounted by their first path segment(s) and keep their own parsing.
 */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteReq {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** `["api", ...segments]`. */
  parts: string[];
  params: Record<string, string>;
  ctx: AppContext;
  body(max?: number): Promise<Record<string, unknown>>;
}

/** A non-200 answer. */
export class Reply {
  readonly status: number;
  readonly value: unknown;
  constructor(status: number, value: unknown) {
    this.status = status;
    this.value = value;
  }
}

export interface Route {
  method: Method;
  /** e.g. `/api/threads/:id/messages`. */
  path: string;
  handle(r: RouteReq): unknown | Promise<unknown>;
}

/** A feature area mounted by its first segment(s); `handle` answers false when the path is not its own. */
export interface Mount {
  areas: readonly string[];
  handle(r: RouteReq): Promise<boolean>;
}

interface Compiled extends Route {
  segs: string[];
}

export class RouteTable {
  private readonly routes: Compiled[] = [];
  private readonly mounts: Mount[] = [];

  add(...routes: Route[]): this {
    for (const r of routes) this.routes.push({ ...r, segs: r.path.split("/").filter(Boolean) });
    return this;
  }

  mount(...mounts: Mount[]): this {
    this.mounts.push(...mounts);
    return this;
  }

  /** Every row, for docs and tests. */
  list(): Array<{ method: Method; path: string }> {
    return this.routes.map((r) => ({ method: r.method, path: r.path }));
  }

  private match(method: string, parts: string[]): { route: Compiled; params: Record<string, string> } | null {
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segs.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const s = route.segs[i] as string;
        const p = parts[i] as string;
        if (s.startsWith(":")) params[s.slice(1)] = decodeURIComponent(p);
        else if (s !== p) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    if (pathMatched) throw new HttpError(405, "method not allowed");
    return null;
  }

  /**
   * Dispatch one `/api` request: the mounted area first (as the feature
   * modules always came first), then the table; 405 for a known path under
   * another method, 404 for anything else.
   */
  async dispatch(req: IncomingMessage, res: ServerResponse, url: URL, ctx: AppContext): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    const r: RouteReq = { req, res, url, parts, ctx, params: {}, body: (max?: number) => readJson(req, max) };
    if (await this.tryMounts(parts, r)) return;
    const hit = this.match(method, parts);
    if (!hit) throw new HttpError(404, "not found");
    const out = await hit.route.handle({ ...r, params: hit.params });
    if (out === undefined) return;
    if (out instanceof Reply) return json(res, out.status, out.value);
    json(res, 200, out);
  }

  private async tryMounts(parts: string[], r: RouteReq): Promise<boolean> {
    const area = parts[1] ?? "";
    for (const m of this.mounts) if (m.areas.includes(area) && (await m.handle(r))) return true;
    return false;
  }
}
