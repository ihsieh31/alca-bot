import { BrowserNotFoundError, ControlError, NavigationError, SpaceNotFoundError } from "@alca/browser";
import {
  type AgentSystem,
  type AlcaCore,
  NotFoundError,
  resumeDispatch,
  ThreadBusyError,
  ThreadInUseError,
} from "@alca/core";
import { tSource } from "@alca/design/i18n";
import { type HostSession, LinkError, type LinkHost, RpcError, type RtcHost } from "@alca/link";
import type { AlcaEvent } from "@alca/protocol";
import { addonOps } from "./addons-api.ts";
import { type BrowserSetup, parseInput } from "./browser.ts";
import type { ConnectorsApi } from "./connectors-api.ts";
import { deleteOptions, listQuery, threadSummary } from "./core-routes.ts";
import { HttpError } from "./http.ts";
import type { LinkSetup } from "./link.ts";
import { connectorOps } from "./link-connector-ops.ts";
import { once, recoveryWindow } from "./link-once.ts";
import { pushOps } from "./link-push-ops.ts";
import { phoneAddressee, teamOps } from "./link-team-ops.ts";
import { type MemoryApi, MemoryApiError } from "./memory-api.ts";
import type { PushNotifier } from "./push.ts";
import type { TeamApi } from "./team-api.ts";

/**
 * What a paired phone may do, op by op (default deny: an op not listed here
 * does not exist). Each op names the device scope it needs; the person on the
 * phone acts as `user:device:<id>`, so audit rows and resolved cards say which
 * device said yes.
 *
 * Pushed events: `alca` (main protocol, the watched thread), `agents`
 * (worker states), `worker` ({workerId, e}: the watched worker's stream),
 * `browser` (browser channel + `space.snapshot`), `frame` (watched Space,
 * dropped under load), `link` (device list changed), `learning` (memory
 * changed / skill proposed or updated; ids and names only).
 *
 * Memory and skills (P5): reading, confirming and exporting memory need
 * `chat` (the phone already sees the conversations it came from); changing
 * or forgetting a memory needs `approve` (review 2026-11-04b L7: like
 * `threads.delete`, a chat-only device cannot rewrite or erase what the bots
 * know); approving, editing, disabling or deleting a skill needs `approve`.
 *
 * The team (P7): `team.get` / `peers.*` (link-team-ops.ts); a message can name
 * who answers (`botId`, or `@name` at the start) and a new thread can be
 * started with a bot, as on the desktop.
 *
 * Web Push (P8): `push.*` and `cards.locate` (link-push-ops.ts); a phone whose
 * app is in front gets a `notify` event ({t, id}) instead of a push.
 */

type Scope = "chat" | "approve" | "view_screen" | "control_computer" | "any";

interface Ctx {
  core: AlcaCore;
  agents: AgentSystem | undefined;
  browser: BrowserSetup | undefined;
  memory?: MemoryApi | undefined;
  connectors?: ConnectorsApi | undefined;
  team?: TeamApi | undefined;
  /** Web Push (P8). */
  push?: PushNotifier | undefined;
  link: () => LinkSetup;
  linkHost: LinkHost;
  /** P13: answers a device's WebRTC offer (signaling rides this sealed session). */
  rtc?: RtcHost | undefined;
}

const s = (args: Record<string, unknown>, k: string, max = 200): string => {
  const v = args[k];
  if (typeof v !== "string" || !v || v.length > max) throw new RpcError("bad_request", `${k} is required`);
  return v;
};

function mapError(e: unknown): never {
  if (e instanceof RpcError) throw e;
  if (e instanceof MemoryApiError)
    throw new RpcError(
      e.status === 404 ? "not_found" : e.status === 409 ? "conflict" : "bad_request",
      e.message,
    );
  if (e instanceof HttpError) throw new RpcError(e.status === 404 ? "not_found" : "bad_request", e.message);
  if (e instanceof NotFoundError || e instanceof SpaceNotFoundError)
    throw new RpcError("not_found", e.message);
  if (e instanceof ThreadBusyError) throw new RpcError("busy", tSource("core.thread.busy"));
  if (e instanceof ThreadInUseError) throw new RpcError("conflict", e.message);
  if (e instanceof ControlError || e instanceof NavigationError) throw new RpcError("conflict", e.message);
  if (e instanceof BrowserNotFoundError) throw new RpcError("unavailable", e.message);
  throw e;
}

export function phoneHandler(session: HostSession, ctx: Ctx): void {
  const { core, agents, browser } = ctx;
  const peer = session.peer;
  const device = session.device;
  const actor = { kind: "user" as const, id: `device:${device.id}` };
  const watches = {
    thread: undefined as undefined | (() => void),
    worker: undefined as undefined | (() => void),
    browser: undefined as undefined | (() => void),
  };
  const stop = (k: keyof typeof watches) => {
    watches[k]?.();
    watches[k] = undefined;
  };
  peer.onClose(() => {
    // A closed session is not looking at the app any more: pings go by push again.
    if (!ctx.linkHost.sessions(device.id).some((x) => x !== session)) ctx.push?.presence(device.id, false);
    stop("thread");
    stop("worker");
    stop("browser");
  });

  // PERF-2026-11: the device row, re-read only when a device write happened
  // (DeviceRepo.revision): `still()` runs for every event sent to this phone,
  // and a SQLite read per streamed chunk per phone was most of its cost.
  let known: { rev: number; d: ReturnType<typeof core.store.devices.get> } | undefined;
  const current = () => {
    const rev = core.store.devices.revision;
    if (known?.rev !== rev) known = { rev, d: core.store.devices.get(device.id) };
    return known.d;
  };
  const need = (scope: Scope) => {
    // Live: a scope change or a revoke on the desktop applies to the very next request.
    const d = current();
    if (!d || d.revokedAt !== null) throw new RpcError("revoked", "這台裝置已被撤銷");
    if (scope === "any") return;
    if (!d.scopes.includes(scope)) throw new RpcError("forbidden", `這台裝置沒有「${scope}」權限`);
  };
  // A standing watch is checked on every event too: taking a scope away (or a
  // revoke) on the desktop stops what is already streaming, not only new requests.
  const still = (scope: Scope, k: keyof typeof watches): boolean => {
    const d = current();
    if (d && d.revokedAt === null && d.scopes.includes(scope)) return true;
    queueMicrotask(() => stop(k));
    return false;
  };
  const needBrowser = () => {
    if (!browser) throw new RpcError("unavailable", "瀏覽器未啟用");
    return browser.host;
  };

  const watchThread = (threadId: string | null) => {
    stop("thread");
    const send = (e: AlcaEvent) => {
      if (still("chat", "thread")) peer.emit("alca", e);
    };
    const threads = threadId ? [threadId] : core.listThreads().map((t) => t.id);
    for (const t of threads) {
      const active = core.isBusy(t) ? core.threadState(t).activeRunId : null;
      if (active) for (const e of core.runEvents(active)) send(e);
      for (const e of agents?.pendingCards(t) ?? []) send(e);
    }
    const off = core.bus.subscribe(threadId ?? "*", send);
    const offAgents = agents?.subscribe((e) => {
      if (threadId && e.type === "worker.updated" && e.data.worker.threadId !== threadId) return;
      if (still("chat", "thread")) peer.emit("agents", e);
    });
    // From the memory API, not the agents desk: direct mode has learning too.
    const offLearning = ctx.memory?.subscribe((e) => {
      if (still("chat", "thread")) peer.emit("learning", e);
    });
    watches.thread = () => {
      off();
      offAgents?.();
      offLearning?.();
    };
  };

  const watchWorker = (workerId: string | null) => {
    stop("worker");
    if (!workerId || !agents) return;
    const sent = new Set<string>();
    const once = (e: AlcaEvent) => {
      const k = `${e.runId}:${e.seq}`;
      if (sent.has(k) || !still("chat", "worker")) return;
      sent.add(k);
      peer.emit("worker", { workerId, e });
    };
    const buffered: AlcaEvent[] = [];
    let replaying = true;
    const off = core.bus.subscribe(`worker:${workerId}`, (e) => (replaying ? buffered.push(e) : once(e)));
    for (const e of agents.workerEvents(workerId)) once(e);
    replaying = false;
    for (const e of buffered) once(e);
    watches.worker = off;
  };

  const watchBrowser = (spaceId: string | null) => {
    stop("browser");
    const host = needBrowser();
    for (const space of host.list()) peer.emit("browser", { type: "space.snapshot", data: { space } });
    const off = host.subscribe((e) => {
      if (still("view_screen", "browser")) peer.emit("browser", e);
    });
    let offFrames: (() => void) | undefined;
    if (spaceId) {
      try {
        offFrames = host.watch(spaceId, (f) => {
          // Video is optional traffic: drop a frame while the last ones are still on their way.
          if (peer.backlog > 1 || ctx.linkHost.congested() || !still("view_screen", "browser")) return;
          peer.emit("frame", f);
        });
      } catch {
        // unknown Space: channel events only
      }
    }
    watches.browser = () => {
      off();
      offFrames?.();
    };
  };

  const ops: Record<string, [Scope, (a: Record<string, unknown>) => unknown]> = {
    ping: ["any", () => "pong"],
    // 診斷 (P9): how the core sees its own reachability; addresses only, nothing secret.
    "link.health": [
      "any",
      () => ({ ...ctx.linkHost.health, status: ctx.linkHost.status, ...ctx.linkHost.endpoints() }),
    ],
    session: [
      "any",
      () => ({
        device: { id: device.id, name: device.name, scopes: core.store.devices.get(device.id)?.scopes ?? [] },
        engine: core.engine.id,
        mode: core.mode,
        bot: core.store.bots.get(core.defaultBotId),
        browser: !!browser,
        agents: !!agents,
      }),
    ],
    // Paged (P13 A6): {limit?, before?: "<updatedAt>~<id>", archived?: true}.
    "threads.list": [
      "chat",
      (a) =>
        core
          .listThreads(
            listQuery({
              get: (k) =>
                k === "archived"
                  ? a.archived === true
                    ? "1"
                    : null
                  : typeof a[k] === "string" || typeof a[k] === "number"
                    ? String(a[k])
                    : null,
            }),
          )
          .map((t) => threadSummary(core, t.id, agents)),
    ],
    "threads.archive": [
      "chat",
      (a) => threadSummary(core, core.archiveThread(s(a, "threadId"), a.archived !== false).id, agents),
    ],
    // Deleting is for good: it needs `approve`, like the other irreversible phone ops.
    "threads.delete": [
      "approve",
      (a) =>
        core.deleteThread(
          s(a, "threadId"),
          // The phone has no 設定; the user's default (scrub the backups) holds unless it says otherwise.
          deleteOptions({}, a.memories === true, typeof a.backups === "boolean" ? a.backups : undefined),
        ),
    ],
    "threads.create": [
      "chat",
      (a) => {
        let bot: string | undefined;
        try {
          bot = ctx.team?.newThreadBot(a.botId);
        } catch (e) {
          throw new RpcError("bad_request", (e as Error).message);
        }
        // P13: a queued new conversation carries a client key, so a retried flush makes one thread.
        return once(
          core.store,
          device.id,
          a.clientKey,
          "threads.create",
          () => {
            const t = core.createThread(
              typeof a.title === "string" && a.title.trim() ? a.title.trim().slice(0, 80) : undefined,
              bot,
            );
            return { ...t } as unknown as Record<string, unknown>;
          },
          { atomic: true },
        );
      },
    ],
    "threads.get": [
      "chat",
      (a) => {
        const id = s(a, "threadId");
        const st = core.threadState(id);
        const bots = core.store.threads.runBots(id);
        return {
          thread: threadSummary(core, id, agents),
          // Which bot spoke (P7), as on the desktop.
          messages: core
            .messages(id)
            .map((m) => ({ ...m, botId: m.runId ? (bots.get(m.runId) ?? null) : null })),
          activeRunId: st.activeRunId,
          activeEvents: st.activeRunId ? core.runEvents(st.activeRunId) : [],
          workers: agents?.workerStates(id) ?? [],
          workerCards: agents?.pendingCards(id) ?? [],
          skillProposals: ctx.memory?.proposalsFor(id) ?? [],
        };
      },
    ],
    "threads.send": [
      "chat",
      (a) => {
        const text = s(a, "text", 32_000).trim();
        if (!text) throw new RpcError("bad_request", "text is required");
        const threadId = s(a, "threadId");
        const to = phoneAddressee(ctx.team, threadId, text, a.botId);
        // P13: a queued send carries a client key: sent at most once, however often it is flushed.
        return once(
          core.store,
          device.id,
          a.clientKey,
          "threads.send",
          () => {
            const { runId, done } = core.send(threadId, text, {
              initiator: { kind: "user", id: `device:${device.id}` },
              ...(to ? { botId: to } : {}),
            });
            done.catch(() => undefined);
            return { runId, ...(to ? { botId: to } : {}) } as Record<string, unknown>;
          },
          {
            // A reservation left pending by a crash: was the message written anyway?
            recover: (at) => {
              const w = recoveryWindow(at);
              const runId = core.store.clientOps.sentBetween(
                device.id,
                threadId,
                `device:${device.id}`,
                text,
                w.from,
                w.to,
              );
              return runId ? { runId, ...(to ? { botId: to } : {}) } : undefined;
            },
          },
        );
      },
    ],
    "threads.interrupt": ["chat", async (a) => ({ interrupted: await core.interrupt(s(a, "threadId")) })],
    "watch.thread": [
      "chat",
      (a) => {
        watchThread(typeof a.threadId === "string" ? a.threadId : null);
        return { watching: a.threadId ?? "*" };
      },
    ],
    "approvals.answer": [
      "approve",
      (a) => {
        if (a.decision !== "approved" && a.decision !== "denied")
          throw new RpcError("bad_request", "decision must be approved or denied");
        return core.answerApproval(s(a, "approvalId"), a.decision, actor);
      },
    ],
    "questions.answer": ["chat", (a) => core.answerQuestion(s(a, "questionId"), s(a, "answer", 4000))],
    "workers.list": ["chat", (a) => agents?.workerStates(s(a, "threadId")) ?? []],
    // Design §0.2.3: the ledger after a cursor (`gone` = pruned: re-read the worker, then from the start).
    "dispatches.events": [
      "chat",
      (a) => {
        const r = resumeDispatch(core.store, s(a, "dispatchId"), Number(a.after ?? 0));
        if (r.kind === "not_found") throw new RpcError("not_found", "dispatch not found");
        return r.kind === "gone"
          ? { gone: true, minSeq: r.minSeq, refetch: r.refetch }
          : { events: r.events, next: r.next };
      },
    ],
    "watch.worker": [
      "chat",
      (a) => {
        watchWorker(typeof a.workerId === "string" ? a.workerId : null);
        return { watching: a.workerId ?? null };
      },
    ],
    "workers.stop": [
      "chat",
      async (a) => {
        if (!agents) throw new RpcError("unavailable", "router mode is off");
        const id = s(a, "workerId");
        if (!agents.workers.get(id)) throw new RpcError("not_found", "worker not found");
        return { stopped: await agents.workers.stop(id, "user") };
      },
    ],
    // Phase 6: the person answers a worker's NEEDS_INPUT from the phone's worker sheet. `approve`,
    // not `chat`: person-only questions (sign-in, payment, codes) are answered here as the person.
    "workers.answer": [
      "approve",
      (a) => {
        if (!agents) throw new RpcError("unavailable", "router mode is off");
        const id = s(a, "workerId");
        if (!agents.workers.get(id)) throw new RpcError("not_found", "worker not found");
        const answers = Array.isArray(a.answers)
          ? a.answers.slice(0, 3).map((x) => (typeof x === "string" ? x.slice(0, 4000) : ""))
          : [];
        if (!answers.length) throw new RpcError("bad_request", "answers is required");
        try {
          return { worker: agents.answerWorker(id, answers) };
        } catch (e) {
          throw new RpcError("conflict", e instanceof Error ? e.message : String(e));
        }
      },
    ],
    // Design §0.2.5: 續做 from the phone's worker sheet (another step budget: `approve`).
    "workers.continue": [
      "approve",
      (a) => {
        if (!agents) throw new RpcError("unavailable", "router mode is off");
        const id = s(a, "workerId");
        if (!agents.workers.get(id)) throw new RpcError("not_found", "worker not found");
        try {
          return { worker: agents.continueWorker(id) };
        } catch (e) {
          throw new RpcError("conflict", e instanceof Error ? e.message : String(e));
        }
      },
    ],
    "browser.spaces": ["view_screen", () => needBrowser().list()],
    "watch.browser": [
      "view_screen",
      (a) => {
        watchBrowser(typeof a.spaceId === "string" ? a.spaceId : null);
        return { watching: a.spaceId ?? null };
      },
    ],
    "browser.takeover": [
      "control_computer",
      (a) => needBrowser().takeOver(s(a, "spaceId"), actor, "使用者在手機上接手"),
    ],
    "browser.handback": ["control_computer", (a) => needBrowser().handBack(s(a, "spaceId"), actor)],
    "browser.input": [
      "control_computer",
      async (a) => {
        const input = a.input && typeof a.input === "object" ? (a.input as Record<string, unknown>) : {};
        await needBrowser().userInput(s(a, "spaceId"), parseInput(input));
        return { ok: true };
      },
    ],
    ...memoryOps(ctx.memory),
    ...connectorOps(ctx.connectors, (name, botId) => {
      let bot: string | undefined;
      try {
        bot = ctx.team?.newThreadBot(botId);
      } catch (e) {
        throw new RpcError("bad_request", (e as Error).message);
      }
      return core.createThread(name, bot).id;
    }),
    ...teamOps(ctx.team),
    ...addonOps(agents),
    ...pushOps(ctx.push, device.id),
    // P13: a direct DataChannel. The session that comes up on it runs the full handshake and must be this device.
    "rtc.offer": [
      "any",
      async (a) => {
        if (!ctx.rtc?.enabled) throw new RpcError("unavailable", "direct connection is off");
        try {
          return await ctx.rtc.answer(device.id, a.sdp);
        } catch (e) {
          if (e instanceof LinkError)
            throw new RpcError(e.code === "rate_limited" ? "busy" : "bad_request", e.message);
          throw e;
        }
      },
    ],
    "devices.list": [
      "any",
      () =>
        ctx
          .link()
          .devices()
          .map(({ pubkey: _p, ...d }) => ({ ...d, self: d.id === device.id })),
    ],
    // Any device may remove itself; removing another one (a phone, a hands
    // daemon) needs `approve`, so a chat-only device cannot cut the others off.
    "devices.revoke": [
      "any",
      (a) => {
        const target = s(a, "deviceId");
        if (target !== device.id) need("approve");
        return { revoked: ctx.link().revoke(target) };
      },
    ],
  };

  peer.handle(async (op, args) => {
    const entry = Object.hasOwn(ops, op) ? ops[op] : undefined;
    if (!entry) throw new RpcError("unknown_op", `no such operation: ${op}`);
    const [scope, fn] = entry;
    need(scope);
    try {
      return await fn(args);
    } catch (e) {
      mapError(e);
    }
  });
}

type Op = [Scope, (a: Record<string, unknown>) => unknown];

/** Memory + skill ops for the phone (see the scope rule at the top). */
function memoryOps(api: MemoryApi | undefined): Record<string, Op> {
  const m = () => {
    if (!api) throw new RpcError("unavailable", "memory is off");
    return api;
  };
  const id = (a: Record<string, unknown>, k: string) => s(a, k, 64);
  return {
    "memory.list": ["chat", (a) => m().list(a)],
    "memory.get": ["chat", (a) => m().detail(id(a, "memoryId"), a.bot)],
    "memory.update": ["approve", (a) => m().update(id(a, "memoryId"), a)],
    "memory.confirm": ["chat", (a) => m().confirm(id(a, "memoryId"))],
    "memory.forget": ["approve", (a) => m().forget(id(a, "memoryId"))],
    "memory.export": ["chat", (a) => m().export(a.bot)],
    "skills.list": ["chat", (a) => m().skills(a)],
    "skills.get": ["chat", (a) => m().skillDetail(id(a, "skillId"))],
    "skills.approve": ["approve", (a) => m().approve(id(a, "skillId"), a)],
    "skills.reject": ["approve", (a) => m().reject(id(a, "skillId"), a)],
    "skills.edit": ["approve", (a) => m().edit(id(a, "skillId"), a)],
    "skills.enable": ["approve", (a) => m().setEnabled(id(a, "skillId"), a.enabled !== false)],
    "skills.delete": ["approve", (a) => m().remove(id(a, "skillId"))],
  };
}
