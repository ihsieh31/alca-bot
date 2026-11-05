import type { AgentSystem } from "@alca/core";
import { HttpError } from "./http.ts";
import type { Route } from "./routes.ts";

/**
 * Phase 6 rows of the route table (loopback only): the hidden git snapshots
 * taken before coding turns at 完全授權 (Phase 5), for the worker panel.
 * A restore only takes a snapshot the ledger knows (repository + ref), and
 * keeps what is there now as one more snapshot first.
 *
 *   GET  /api/snapshots?dispatch=&repo=   a dispatch's (or a folder's) snapshots, newest first
 *   POST /api/snapshots/restore           {repo, ref} put that snapshot's files back
 *   POST /api/snapshots/purge             {dispatchId? | repo? [, ref]} delete them; how many
 */

const need = (a: AgentSystem | undefined): AgentSystem => {
  if (!a) throw new HttpError(404, "router mode is off");
  return a;
};

const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined;

/** Git errors (a folder gone, a ref deleted) come back as 409 with their reason. */
const wrap = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(409, e instanceof Error ? e.message.slice(0, 400) : String(e));
  }
};

export function snapshotRoutes(): Route[] {
  return [
    {
      method: "GET",
      path: "/api/snapshots",
      handle: ({ ctx, url }) => {
        const dispatchId = text(url.searchParams.get("dispatch"), 64);
        const repo = text(url.searchParams.get("repo"), 4096);
        if (!dispatchId && !repo) throw new HttpError(400, "dispatch or repo is required");
        const list = wrap(() =>
          need(ctx.agents).snapshotList({
            ...(dispatchId ? { dispatchId } : {}),
            ...(repo ? { repo } : {}),
          }),
        );
        return [...list].sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
      },
    },
    {
      method: "POST",
      path: "/api/snapshots/restore",
      handle: async ({ ctx, body }) => {
        const b = await body();
        const repo = text(b.repo, 4096);
        const ref = text(b.ref, 300);
        if (!repo || !ref) throw new HttpError(400, "repo and ref are required");
        return wrap(() => need(ctx.agents).snapshotRestore(repo, ref));
      },
    },
    {
      method: "POST",
      path: "/api/snapshots/purge",
      handle: async ({ ctx, body }) => {
        const b = await body();
        const dispatchId = text(b.dispatchId, 64);
        const repo = text(b.repo, 4096);
        const ref = text(b.ref, 300);
        if (!dispatchId && !repo) throw new HttpError(400, "dispatchId or repo is required");
        if (ref && !repo) throw new HttpError(400, "a ref needs its repo");
        const purged = wrap(() =>
          need(ctx.agents).snapshotPurge({
            ...(dispatchId ? { dispatchId } : {}),
            ...(repo ? { repo } : {}),
            ...(ref ? { ref } : {}),
          }),
        );
        return { purged };
      },
    },
  ];
}
