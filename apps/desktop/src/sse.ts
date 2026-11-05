import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentSystem, AlcaCore, Learning } from "@alca/core";
import type { AlcaEvent } from "@alca/protocol";
import { sseOut } from "./sse-out.ts";

/** The event stream: alca (run events), agents (worker states) and learning channels. */
export function sse(
  req: IncomingMessage,
  res: ServerResponse,
  core: AlcaCore,
  thread: string | null,
  agents: AgentSystem | undefined,
  learning: Learning | undefined,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  // A client that stops reading is cut off past a cap and resyncs on reconnect (sse-out.ts);
  // the replay below is not counted (review 2026-11-05 #5).
  const out = sseOut(res, { replay: true });
  out.write(": alca event stream\n\n");
  const write = (e: AlcaEvent) =>
    out.write(`event: alca\nid: ${e.runId}:${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  // Replay the open runs first so a reconnecting UI sees pending cards and partial text.
  const threads = thread ? [thread] : core.listThreads().map((t) => t.id);
  for (const t of threads) {
    const active = core.isBusy(t) ? core.threadState(t).activeRunId : null;
    if (active) for (const e of core.runEvents(active)) write(e);
    // Cards of the thread's workers (they live in the workers' runs).
    for (const e of agents?.pendingCards(t) ?? []) write(e);
  }
  out.arm();
  const unsubscribe = core.bus.subscribe(thread ?? "*", write);
  // The agents channel: which workers exist and how they are doing (never their text).
  const offAgents = agents?.subscribe((e) => {
    if (thread && e.type === "worker.updated" && e.data.worker.threadId !== thread) return;
    out.write(`event: agents\ndata: ${JSON.stringify(e)}\n\n`);
  });
  // The learning channel: memory changed, skill proposed / updated (ids and names, never memory text).
  const offLearning = learning?.subscribe((e) =>
    out.write(`event: learning\ndata: ${JSON.stringify(e)}\n\n`),
  );
  const ping = setInterval(() => out.write(": ping\n\n"), 15_000);
  ping.unref();
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
    offAgents?.();
    offLearning?.();
  });
}
