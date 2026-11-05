import type { AgentSystem, AlcaCore } from "@alca/core";
import { tSource } from "@alca/design/i18n";
import { addonMount, offerMount } from "./addons-api.ts";
import { agentsRoute } from "./agents-routes.ts";
import type { AppContext } from "./app-context.ts";
import { browserRoute } from "./browser.ts";
import { connectorRoute } from "./connector-routes.ts";
import { HttpError } from "./http.ts";
import { linkRoute } from "./link-routes.ts";
import { log } from "./log.ts";
import { memoryRoute } from "./memory-routes.ts";
import { providerRoute } from "./provider-routes.ts";
import { Reply, RouteTable } from "./routes.ts";
import { settingsRoutes } from "./settings-routes.ts";
import { snapshotRoutes } from "./snapshot-routes.ts";
import { sse } from "./sse.ts";
import { teamRoute } from "./team-routes.ts";
import { telegramRoute } from "./telegram.ts";
import { workspaceRoutes } from "./workspace-routes.ts";

/** One row of the thread list: the thread plus what it is doing right now. */
/**
 * `?limit=&before=<updatedAt>~<id>&archived=1` → the core's list options
 * (P13 A6). A page shorter than `limit` is the last one.
 */
export function listQuery(q: { get(k: string): string | null }): {
  limit: number;
  archived?: boolean;
  before?: { updatedAt: string; id: string };
} {
  const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200);
  const raw = q.get("before") ?? "";
  const cut = raw.lastIndexOf("~");
  const before =
    cut > 0 && /^thr[\w-]{1,80}$/.test(raw.slice(cut + 1)) && !Number.isNaN(Date.parse(raw.slice(0, cut)))
      ? { updatedAt: raw.slice(0, cut), id: raw.slice(cut + 1) }
      : undefined;
  return { limit, ...(q.get("archived") === "1" ? { archived: true } : {}), ...(before ? { before } : {}) };
}

export function threadSummary(core: AlcaCore, id: string, agents?: AgentSystem) {
  const s = core.threadState(id);
  const workers = agents?.workerStates(id) ?? [];
  const live = workers.filter(
    (w) => w.status === "queued" || w.status === "running" || w.status === "waiting",
  );
  return {
    ...s.thread,
    busy: s.activeRunId !== null,
    waiting:
      s.pendingApprovals.length + s.pendingQuestions.length > 0 || live.some((w) => w.status === "waiting"),
    workers: live.length,
  };
}

/**
 * The desktop API (loopback, token required). Feature areas are mounted by
 * their first segment; the core's own endpoints are rows:
 *
 *   GET  /api/status                 the shell's tray: waiting count, Link, pid
 *   GET  /api/session                engine, level, default bot, which features are on
 *   GET  /api/events?thread=         event stream (SSE)
 *   GET  /api/bots                   the roster (without the team feature)
 *   GET  /api/threads                thread list (?limit, ?before=<updatedAt>~<id>, ?archived=1)
 *   POST /api/threads                {title?, botId?}
 *   POST /api/threads/:id/archive    {archived?: boolean} (default true)
 *   DELETE /api/threads/:id          delete (409 while running or still used by routines / workers)
 *   GET  /api/threads/:id            messages, the open run, workers, cards, proposals
 *   POST /api/threads/:id/messages   {text, botId?}
 *   POST /api/threads/:id/interrupt
 *   POST /api/approvals/:id          {decision: approved | denied}
 *   POST /api/questions/:id          {answer}
 *   GET  /api/runs/:id/events?after=
 */
export function desktopRoutes(): RouteTable {
  return new RouteTable()
    .mount(
      {
        areas: ["browser"],
        handle: (r) => browserRoute(r.req, r.res, r.parts, r.url, r.ctx.browser, r.ctx.core),
      },
      {
        areas: ["workers", "triggers", "threads", "dispatches"],
        handle: (r) => agentsRoute(r.req, r.res, r.parts, r.url, r.ctx.core, r.ctx.agents),
      },
      { areas: ["link"], handle: (r) => linkRoute(r.req, r.res, r.parts, r.ctx.link) },
      { areas: ["memory", "skills"], handle: (r) => memoryRoute(r.req, r.res, r.parts, r.url, r.ctx.memory) },
      {
        areas: ["connectors", "routines", "drafts"],
        handle: (r) => connectorRoute(r.req, r.res, r.parts, r.url, r.ctx.connectors),
      },
      { areas: ["providers"], handle: (r) => providerRoute(r.req, r.res, r.parts, r.url, r.ctx.team) },
      { areas: ["telegram"], handle: (r) => telegramRoute(r, r.ctx.telegram) },
      // P14: /api/bots/:id/addons… (ahead of the team area, which owns the rest of /api/bots).
      addonMount(),
      offerMount(),
      {
        areas: ["team", "bots", "peers"],
        handle: (r) => teamRoute(r.req, r.res, r.parts, r.url, r.ctx.team),
      },
    )
    .add(...workspaceRoutes())
    .add(...settingsRoutes())
    .add(...snapshotRoutes())
    .add(
      { method: "GET", path: "/api/bots", handle: ({ ctx }) => ctx.core.store.bots.list() },
      {
        method: "GET",
        path: "/api/status",
        // P8: what the desktop shell's tray shows (running / waiting on you N), polled on loopback.
        handle: ({ ctx: { core, link } }) => ({
          ok: true,
          waiting: {
            approvals: core.store.human.pendingApprovals().length,
            questions: core.store.human.pendingQuestions().length,
          },
          link: link
            ? { status: link.host.status, phonesOnline: link.devices().filter((d) => d.online).length }
            : null,
          pid: process.pid,
        }),
      },
      {
        method: "GET",
        path: "/api/session",
        handle: ({ ctx }) => ({
          engine: ctx.core.engine.id,
          capabilities: ctx.core.engine.capabilities,
          level: ctx.settings().permissions.level,
          bot: ctx.core.store.bots.get(ctx.core.defaultBotId),
          team: !!ctx.team,
          browser: !!ctx.browser,
          mode: ctx.core.mode,
          memory: !!ctx.memory,
          connectors: !!ctx.connectors,
          ...ctx.info,
        }),
      },
      {
        method: "GET",
        path: "/api/events",
        handle: ({ req, res, url, ctx }) =>
          sse(req, res, ctx.core, url.searchParams.get("thread"), ctx.agents, ctx.learning),
      },
      {
        method: "GET",
        path: "/api/threads",
        handle: ({ ctx, url }) =>
          ctx.core
            .listThreads(listQuery(url.searchParams))
            .map((t) => threadSummary(ctx.core, t.id, ctx.agents)),
      },
      {
        method: "POST",
        path: "/api/threads",
        handle: async ({ ctx, body }) => {
          const b = await body();
          const title =
            typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 80) : undefined;
          return new Reply(201, ctx.core.createThread(title, ctx.team?.newThreadBot(b.botId)));
        },
      },
      {
        method: "GET",
        path: "/api/threads/:id",
        handle: ({ ctx, params: { id } }) => {
          const { core, agents, team, memory } = ctx;
          const tid = id as string;
          const s = core.threadState(tid);
          const bots = core.store.threads.runBots(tid);
          return {
            thread: threadSummary(core, tid, agents),
            // Which bot spoke (P7: a thread hears from every bot the person @mentions).
            messages: core
              .messages(tid)
              .map((m) => ({ ...m, botId: m.runId ? (bots.get(m.runId) ?? null) : null })),
            peers: team?.peers({ thread: tid }) ?? [],
            activeRunId: s.activeRunId,
            activeEvents: s.activeRunId ? core.runEvents(s.activeRunId) : [],
            workers: agents?.workerStates(tid) ?? [],
            workerCards: agents?.pendingCards(tid) ?? [],
            skillProposals: memory?.proposalsFor(tid) ?? [],
          };
        },
      },
      {
        method: "POST",
        path: "/api/threads/:id/messages",
        handle: async ({ ctx, params: { id }, body }) => {
          const b = await body();
          const text = typeof b.text === "string" ? b.text.trim() : "";
          if (!text) throw new HttpError(400, "text is required");
          if (text.length > 32_000) throw new HttpError(413, "message too long");
          const tid = id as string;
          const to = ctx.team?.addressee(tid, text, b.botId);
          const { runId, done } = ctx.core.send(tid, text, {
            initiator: { kind: "user", id: "desktop" },
            ...(to ? { botId: to } : {}),
          });
          done.catch(() => undefined);
          return new Reply(202, { runId, ...(to ? { botId: to } : {}) });
        },
      },
      {
        method: "POST",
        path: "/api/threads/:id/archive",
        handle: async ({ ctx, params: { id }, body }) => {
          const b = await body();
          return threadSummary(
            ctx.core,
            ctx.core.archiveThread(id as string, b.archived !== false).id,
            ctx.agents,
          );
        },
      },
      {
        method: "DELETE",
        path: "/api/threads/:id",
        // R5.4: ?memories=1 also forgets what was learned there; ?backups=0 keeps the backups as they are.
        handle: ({ ctx, url, params: { id } }) =>
          ctx.core.deleteThread(
            id as string,
            deleteOptions(
              ctx,
              url.searchParams.get("memories") === "1",
              flag(url.searchParams.get("backups")),
            ),
          ),
      },
      {
        method: "POST",
        path: "/api/threads/:id/interrupt",
        handle: async ({ ctx, params: { id } }) => ({ interrupted: await ctx.core.interrupt(id as string) }),
      },
      {
        method: "POST",
        path: "/api/approvals/:id",
        handle: async ({ ctx, params: { id }, body }) => {
          const b = await body();
          if (b.decision !== "approved" && b.decision !== "denied")
            throw new HttpError(400, "decision must be approved or denied");
          return ctx.core.answerApproval(id as string, b.decision, { kind: "user", id: "desktop" });
        },
      },
      {
        method: "POST",
        path: "/api/questions/:id",
        handle: async ({ ctx, params: { id }, body }) => {
          const b = await body();
          if (typeof b.answer !== "string") throw new HttpError(400, "answer is required");
          return ctx.core.answerQuestion(id as string, b.answer.slice(0, 4000));
        },
      },
      {
        method: "GET",
        path: "/api/runs/:id/events",
        handle: ({ ctx, url, params: { id } }) => {
          const after = Number(url.searchParams.get("after") ?? -1);
          // Design §0.2.3: a cursor whose rows were pruned cannot resume — say where to restart.
          const gone = ctx.core.store.runs.cursorGone(id as string, after);
          if (gone)
            return new Reply(410, {
              error: "gone",
              minSeq: gone.minSeq,
              refetch: tSource("core.steps.expired"),
            });
          const events = ctx.core.runEvents(id as string, after);
          // Next round §4: a finished run whose steps are gone (past retention,
          // or its conversation was deleted) says so instead of an empty list.
          if (!events.length && after < 0 && ctx.core.store.runs.get(id as string)?.status === "finished")
            return { expired: true };
          return events;
        },
      },
    );
}

const flag = (v: string | null): boolean | undefined => (v === null ? undefined : v === "1" || v === "true");

/**
 * R5.4 (user defaults): a conversation delete keeps the memories learned in
 * it and takes it out of the backups too (`engineering.retention.
 * scrubBackupsOnDelete`); a backup that could not be scrubbed is logged.
 */
export function deleteOptions(
  ctx: Partial<Pick<AppContext, "settings">>,
  memories: boolean,
  backups: boolean | undefined,
) {
  return {
    memories,
    scrubBackups: backups ?? ctx.settings?.().engineering.retention.scrubBackupsOnDelete ?? true,
    onBackups: (r: Array<{ file: string; ok: boolean; error?: string }>) => {
      const bad = r.filter((b) => !b.ok);
      if (bad.length)
        log.warn(
          `the deleted conversation was not removed from ${bad.length} backups: ${bad.map((b) => b.error).join("; ")}`,
        );
    },
  };
}
