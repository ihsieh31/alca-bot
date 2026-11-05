import type { IncomingMessage, ServerResponse } from "node:http";
import { type AgentSystem, type AlcaCore, resumeDispatch, type TriggerRule } from "@alca/core";
import type { AlcaEvent } from "@alca/protocol";
import type { TriggerSource } from "@alca/store";
import { HttpError, json, readJson } from "./http.ts";
import { sseOut } from "./sse-out.ts";

/**
 * Router / worker routes (P3). A worker's live stream is its own SSE
 * channel (`/api/workers/:id/events`): the UI watches it directly, and the
 * router's context never sees it.
 *
 *   GET  /api/threads/:id/workers      the thread's workers (WorkerState[])
 *   GET  /api/workers/:id              one worker
 *   POST /api/workers/:id/stop         stop it (as the person)
 *   POST /api/workers/:id/continue     續做 a task whose step budget ran out (design §0.2.5; approve key;
 *                                      409 with the reason: the limit of 6, no progress twice, nothing waiting)
 *   POST /api/workers/:id/answer       {answers: string[]} the person answers its NEEDS_INPUT (Phase 6;
 *                                      needs the approve key: person-only questions are answered here)
 *   GET  /api/workers/:id/events       SSE: its runs' events replayed, then live
 *   GET  /api/dispatches/:id/events?after=<seq>   the ledger after a cursor (design §0.2.3);
 *                                      410 {minSeq, refetch} when the cursor was pruned
 *   GET  /api/triggers?thread=…        triggers
 *   POST /api/triggers                 {threadId, name, source: timer|manual, config?, rule?, semantic?}
 *   POST /api/triggers/:id/fire        {text, from?, streamKey?, explicit?} (manual source)
 */

const SOURCES: readonly TriggerSource[] = ["timer", "manual"];

function workerSse(
  req: IncomingMessage,
  res: ServerResponse,
  core: AlcaCore,
  agents: AgentSystem,
  id: string,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  // Bounded per client (PERF-2026-11), counted after the history replay (review 2026-11-05 #5).
  const out = sseOut(res, { replay: true });
  out.write(": alca worker stream\n\n");
  const write = (e: AlcaEvent) =>
    out.write(`event: alca\nid: ${e.runId}:${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  // Subscribe first, replay second, de-duplicate by (run, seq): nothing is lost in between.
  const sent = new Set<string>();
  const once = (e: AlcaEvent) => {
    const k = `${e.runId}:${e.seq}`;
    if (sent.has(k)) return;
    sent.add(k);
    write(e);
  };
  const buffered: AlcaEvent[] = [];
  let replaying = true;
  const off = core.bus.subscribe(`worker:${id}`, (e) => (replaying ? buffered.push(e) : once(e)));
  for (const e of agents.workerEvents(id)) once(e);
  replaying = false;
  for (const e of buffered) once(e);
  out.arm();
  const ping = setInterval(() => out.write(": ping\n\n"), 15_000);
  ping.unref();
  req.on("close", () => {
    clearInterval(ping);
    off();
  });
}

export async function agentsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  core: AlcaCore,
  agents: AgentSystem | undefined,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const [, a, b, c] = parts;
  const need = (): AgentSystem => {
    if (!agents) throw new HttpError(404, "router mode is off");
    return agents;
  };

  if (a === "threads" && b && c === "workers" && method === "GET") {
    if (!core.store.threads.get(b)) throw new HttpError(404, "thread not found");
    json(res, 200, agents ? agents.workerStates(b) : []);
    return true;
  }
  if (a === "workers" && b) {
    const ag = need();
    const w = ag.workers.get(b);
    if (!w) throw new HttpError(404, "worker not found");
    if (method === "GET" && !c) {
      json(res, 200, ag.workers.state(w));
      return true;
    }
    if (method === "GET" && c === "events") {
      workerSse(req, res, core, ag, b);
      return true;
    }
    if (method === "POST" && c === "answer") {
      const body = await readJson(req);
      const answers = Array.isArray(body.answers)
        ? body.answers.slice(0, 3).map((x) => (typeof x === "string" ? x.slice(0, 4000) : ""))
        : [];
      if (!answers.length) throw new HttpError(400, "answers is required");
      try {
        json(res, 200, { worker: ag.answerWorker(b, answers) });
      } catch (e) {
        throw new HttpError(409, e instanceof Error ? e.message : String(e));
      }
      return true;
    }
    // Design §0.2.5: 續做 a task whose step budget ran out (approve key; never automatic).
    if (method === "POST" && c === "continue") {
      try {
        json(res, 200, { worker: ag.continueWorker(b) });
      } catch (e) {
        throw new HttpError(409, e instanceof Error ? e.message : String(e));
      }
      return true;
    }
    if (method === "POST" && c === "stop") {
      const stopped = await ag.workers.stop(b, "user");
      json(res, 200, { stopped, worker: ag.workers.state(ag.workers.get(b) ?? w) });
      return true;
    }
  }
  if (a === "dispatches" && b && c === "events" && method === "GET") {
    const r = resumeDispatch(core.store, b, Number(url.searchParams.get("after") ?? 0));
    if (r.kind === "not_found") throw new HttpError(404, "dispatch not found");
    if (r.kind === "gone") json(res, 410, { error: "gone", minSeq: r.minSeq, refetch: r.refetch });
    else json(res, 200, { events: r.events, next: r.next });
    return true;
  }
  if (a === "triggers") {
    const ag = need();
    if (method === "GET" && !b) {
      const thread = url.searchParams.get("thread");
      json(
        res,
        200,
        core.store.triggers.list().filter((t) => !thread || t.threadId === thread),
      );
      return true;
    }
    if (method === "POST" && !b) {
      const body = await readJson(req);
      const source = SOURCES.find((s) => s === body.source);
      if (!source) throw new HttpError(400, "source must be timer or manual");
      if (typeof body.threadId !== "string" || !core.store.threads.get(body.threadId))
        throw new HttpError(400, "threadId is required");
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "觸發器";
      const obj = (v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      json(
        res,
        201,
        ag.triggers.create({
          threadId: body.threadId,
          name,
          source,
          config: obj(body.config),
          rule: obj(body.rule) as TriggerRule,
          semantic: typeof body.semantic === "string" ? body.semantic.slice(0, 1000) : null,
        }),
      );
      return true;
    }
    if (method === "POST" && b && c === "fire") {
      const t = core.store.triggers.get(b);
      if (!t) throw new HttpError(404, "trigger not found");
      if (t.source !== "manual") throw new HttpError(409, "only manual triggers can be fired by hand");
      const body = await readJson(req);
      if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text is required");
      const ev = await ag.triggers.fire(b, {
        text: body.text.slice(0, 20_000),
        ...(typeof body.from === "string" ? { from: body.from } : {}),
        ...(typeof body.streamKey === "string" ? { streamKey: body.streamKey } : {}),
        ...(body.explicit === true ? { explicit: true } : {}),
      });
      json(res, 200, ev);
      return true;
    }
  }
  return false;
}
