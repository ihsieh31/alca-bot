import { HttpError } from "./http.ts";
import type { Route } from "./routes.ts";
import { type WorkspaceApi, WorkspaceApiError } from "./workspace.ts";

/**
 * P13 rows of the route table (loopback only). A bot's folder, review and
 * 提前做 switches are bot fields (PATCH /api/bots/:id, team-api.ts).
 *
 *
 *   GET  /api/undo/:threadId              turns of the conversation that edited files (newest first)
 *   POST /api/undo/:threadId/:turnRunId   put that turn's files back (409 with the reason when it cannot)
 *   GET  /api/early?bot=&thread=          提前做 items
 *   POST /api/early                       {threadId, goal, title?, botId?}
 */
const api = (w: WorkspaceApi | undefined): WorkspaceApi => {
  if (!w) throw new HttpError(404, "not found");
  return w;
};

const wrap = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof WorkspaceApiError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

export function workspaceRoutes(): Route[] {
  return [
    {
      method: "GET",
      path: "/api/undo/:thread",
      handle: ({ ctx, params }) => wrap(() => api(ctx.workspace).edits(params.thread as string)),
    },
    {
      method: "POST",
      path: "/api/undo/:thread/:turn",
      handle: ({ ctx, params }) =>
        wrap(() => api(ctx.workspace).undo(params.thread as string, params.turn as string)),
    },
    {
      method: "GET",
      path: "/api/early",
      handle: ({ ctx, url }) =>
        wrap(() =>
          api(ctx.workspace).early({
            ...(url.searchParams.get("bot") ? { botId: url.searchParams.get("bot") as string } : {}),
            ...(url.searchParams.get("thread") ? { threadId: url.searchParams.get("thread") as string } : {}),
          }),
        ),
    },
    {
      method: "POST",
      path: "/api/early",
      handle: async ({ ctx, body }) => {
        const b = await body();
        return wrap(() => api(ctx.workspace).offerEarly(b));
      },
    },
  ];
}
