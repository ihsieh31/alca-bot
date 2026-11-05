import { BOT_LEVEL_CHOICES, isApprovalLevel, TEAM_LEVEL } from "@alca/config";
import {
  type AgentSystem,
  type AlcaCore,
  type BotWorkDirs,
  describeProbe,
  loosens,
  mergeBotSandbox,
  parseBotSandbox,
  parseQuietHours,
} from "@alca/core";
import { tSource } from "@alca/design/i18n";
import type { ConfineProbe } from "@alca/os";
import {
  BOT_COLORS,
  type Bot,
  type BotProfileInput,
  type PeerEvent,
  type PeerRequest,
  type TeamRules,
} from "@alca/store";
import { mergeBotHarness } from "./bot-harness.ts";
import type { EngineChoice, EngineSet } from "./engines.ts";
import type { ProviderService } from "./providers.ts";

/**
 * The team (P7), shared by the loopback routes (desktop) and the Link ops
 * (phone): the roster with what each bot is doing, bot create / edit /
 * archive, the lead, the team rules, model services, and the bot-to-bot
 * trail. Settings stay simple: a name is enough to add a bot; everything
 * else has a default.
 */

export class TeamApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const bad = (m: string) => new TeamApiError(400, m);
const missing = (m: string) => new TeamApiError(404, m);

export interface BotView extends Bot {
  /** What the bot is doing right now. */
  activity: {
    workers: number;
    waiting: number;
    peersOpen: number;
    /** Titles of what it is working on (workers and open peer requests), newest first. */
    working: Array<{ kind: "worker" | "peer"; id: string; title: string; threadId: string; status: string }>;
  };
  threads: number;
  /** P13: the folder the bot works in now. */
  workDirNow?: string;
  /** P13: why the bot's own folder setting is not used. */
  workDirProblem?: string;
  /** Next-round §5: this computer's OS sandbox, in words (「bubblewrap 可用」「Seatbelt 不可用：…」). */
  sandboxProbe?: { ok: boolean; kind: string; text: string };
}

export interface PeerView extends PeerRequest {
  fromName: string;
  toName: string;
  events?: PeerEvent[];
  messages?: Array<{ id: string; role: string; content: string; botId: string | null; createdAt: string }>;
}

const str = (v: unknown, max: number): string | null | undefined => {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

/** First grapheme-ish chunk of a name: the default avatar. */
export const initialOf = (name: string) => [...name.trim()][0]?.toUpperCase() ?? "?";

export class TeamApi {
  readonly core: AlcaCore;
  readonly agents: AgentSystem | undefined;
  readonly engines: EngineSet | undefined;
  /** 模型與供應商 (P11). */
  readonly providers: ProviderService | undefined;
  readonly changed: (
    op: "created" | "updated" | "archived" | "restored" | "lead" | "rules" | "providers",
    botId?: string,
  ) => void;

  constructor(
    core: AlcaCore,
    agents: AgentSystem | undefined,
    engines: EngineSet | undefined,
    providers?: ProviderService,
  ) {
    this.core = core;
    this.agents = agents;
    this.engines = engines;
    this.providers = providers;
    this.changed = (op, botId) => agents?.announce("team.changed", { op, ...(botId ? { botId } : {}) });
  }

  private get store() {
    return this.core.store;
  }

  private bot(id: string): Bot {
    const b = this.store.bots.get(id);
    if (!b) throw missing(tSource("core.common.noBot"));
    return b;
  }

  view(b: Bot): BotView {
    const store = this.store;
    const live = store.workers.active(b.id);
    const peers = store.team.running().filter((r) => r.toBotId === b.id);
    const waiting = store.db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE bot_id = ? AND status = 'pending'")
      .get(b.id) as { n: number };
    const threads = store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM threads WHERE bot_id = ? AND peer_request_id IS NULL AND archived_at IS NULL",
      )
      .get(b.id) as { n: number };
    return {
      ...b,
      ...this.folderOf(b.id),
      ...(this.probe
        ? { sandboxProbe: { ok: this.probe.ok, kind: this.probe.kind, text: describeProbe(this.probe) } }
        : {}),
      avatar: b.avatar ?? initialOf(b.name),
      activity: {
        workers: live.length,
        waiting: waiting.n,
        peersOpen: peers.length,
        working: [
          ...peers.map((r) => ({
            kind: "peer" as const,
            id: r.id,
            title: r.text.split("\n")[0]?.slice(0, 60) ?? "",
            threadId: r.rootThreadId,
            status: r.status,
          })),
          ...live.map((w) => ({
            kind: "worker" as const,
            id: w.id,
            title: w.title,
            threadId: this.rootOf(w.threadId),
            status: w.status,
          })),
        ].slice(0, 6),
      },
      threads: threads.n,
    };
  }

  /** P13: where the bot works now, and why its own setting is not used (if so). */
  private folderOf(id: string): { workDirNow?: string; workDirProblem?: string } {
    if (!this.workDirs) return {};
    try {
      const problem = this.workDirs.problem(id);
      return { workDirNow: this.workDirs.resolve(id), ...(problem ? { workDirProblem: problem } : {}) };
    } catch {
      return {};
    }
  }

  private rootOf(threadId: string): string {
    return this.agents?.peers.rootOf(threadId) ?? threadId;
  }

  team(): {
    bots: BotView[];
    archived: Bot[];
    rules: TeamRules;
    leadId: string | null;
    defaultBotId: string;
    engines: EngineChoice[];
    colors: readonly string[];
  } {
    const store = this.store;
    return {
      bots: store.bots.list().map((b) => this.view(b)),
      archived: store.bots.all().filter((b) => b.archivedAt),
      rules: store.team.rules(),
      leadId: store.bots.lead()?.id ?? null,
      defaultBotId: this.core.defaultBotId,
      engines: this.engines?.choices() ?? [
        { id: "default", label: "預設引擎", kind: "default", model: null },
      ],
      colors: BOT_COLORS,
    };
  }

  private profile(body: Record<string, unknown>, creating: boolean): BotProfileInput {
    const out: BotProfileInput = {};
    const name = str(body.name, 40);
    if (name !== undefined) {
      if (!name) throw bad(tSource("core.team.nameBlank"));
      if (
        this.store.bots.list().some((b) => b.name.toLowerCase() === name.toLowerCase() && b.id !== body.__id)
      )
        throw bad(tSource("core.team.nameTaken", { name }));
      out.name = name;
    } else if (creating) throw bad(tSource("core.team.nameRequired"));
    const avatar = str(body.avatar, 4);
    if (avatar !== undefined) out.avatar = avatar;
    if (body.color !== undefined) {
      if (body.color !== null && !(BOT_COLORS as readonly unknown[]).includes(body.color))
        throw bad(tSource("core.team.noColor"));
      out.color = body.color as NonNullable<BotProfileInput["color"]> | null;
    }
    const role = str(body.role, 120);
    if (role !== undefined) out.role = role;
    const instructions = str(body.instructions, 4000);
    if (instructions !== undefined) out.instructions = instructions;
    if (body.engineId !== undefined) {
      const e = body.engineId === null || body.engineId === "default" ? null : String(body.engineId);
      if (e && !this.store.team.provider(e) && !this.engines?.has(e))
        throw bad(tSource("core.team.noProvider"));
      out.engineId = e;
    }
    const model = str(body.model, 200);
    if (model !== undefined) out.model = model;
    if (body.approvalLevel !== undefined) {
      const l = body.approvalLevel;
      if (l !== null && l !== TEAM_LEVEL && !isApprovalLevel(l))
        throw bad(tSource("core.team.level", { choices: BOT_LEVEL_CHOICES.join(" / ") }));
      out.approvalLevel = isApprovalLevel(l) ? l : null;
    }
    if (body.browserProfile !== undefined) {
      if (!["shared", "isolated", "isolated_keep"].includes(String(body.browserProfile)))
        throw bad(tSource("core.team.browserBad"));
      out.browserProfile = body.browserProfile as NonNullable<BotProfileInput["browserProfile"]>;
    }
    if (body.memoryExtract !== undefined) {
      if (body.memoryExtract !== "rules" && body.memoryExtract !== "model")
        throw bad(tSource("core.team.memoryMode"));
      out.memoryExtract = body.memoryExtract;
    }
    if (body.memoryMode !== undefined) {
      if (!["team", "own", "off"].includes(String(body.memoryMode)))
        throw bad(tSource("core.team.memoryBad"));
      out.memoryMode = body.memoryMode as NonNullable<BotProfileInput["memoryMode"]>;
    }
    Object.assign(out, this.p13(body));
    return out;
  }

  /** P13 fields: the working folder (checked), the shell review and 提前做 switches, quiet hours. */
  private p13(body: Record<string, unknown>): BotProfileInput {
    const out: BotProfileInput = {};
    const dir = str(body.workDir, 1000);
    if (dir !== undefined) {
      if (dir !== null) {
        const c = this.workDirs?.check(typeof body.__id === "string" ? body.__id : "bot_new", dir);
        if (c && !c.ok) throw bad(tSource("core.team.workdir", { reason: c.reason }));
        out.workDir = c?.ok ? c.path : dir;
      } else out.workDir = null;
    }
    for (const k of ["shellReview", "earlyWork"] as const) {
      if (body[k] === undefined) continue;
      if (body[k] !== "on" && body[k] !== "off") throw bad(tSource("core.team.onOff", { key: k }));
      out[k] = body[k];
    }
    if (body.shellReviewEngine !== undefined) {
      const e =
        body.shellReviewEngine === null || body.shellReviewEngine === ""
          ? null
          : String(body.shellReviewEngine);
      if (e && e !== "default" && !this.engines?.has(e)) throw bad(tSource("core.team.noReviewProvider"));
      out.shellReviewEngine = e;
    }
    const reviewModel = str(body.shellReviewModel, 200);
    if (reviewModel !== undefined) out.shellReviewModel = reviewModel;
    if (body.harness !== undefined) {
      // Phase 6: default harness, reviewer switch and budget caps (bot-harness.ts).
      const stored = typeof body.__id === "string" ? this.store.bots.get(body.__id)?.harness : null;
      try {
        out.harness = mergeBotHarness(stored, body.harness);
      } catch (e) {
        throw bad(e instanceof Error ? e.message : String(e));
      }
    }
    if (body.sandbox !== undefined) {
      // Next-round §5.4: mode / network / extra writable folders (loosening is guarded in guardSandbox).
      const stored = typeof body.__id === "string" ? this.store.bots.get(body.__id)?.sandbox : null;
      try {
        out.sandbox = mergeBotSandbox(stored, body.sandbox);
      } catch (e) {
        throw bad(e instanceof Error ? e.message : String(e));
      }
    }
    if (body.language !== undefined) {
      // R9.6: the language of the bot's router and worker rules.
      if (body.language !== "auto" && body.language !== "zh" && body.language !== "en")
        throw bad(tSource("core.team.language"));
      out.language = body.language;
    }
    const quiet = str(body.quietHours, 11);
    if (quiet !== undefined) {
      if (quiet !== null && !parseQuietHours(quiet)) throw bad(tSource("core.team.quietHours"));
      out.quietHours = quiet;
    }
    return out;
  }

  /** Next-round §5: this computer's sandbox probe (set once by the desktop). */
  private probe: ConfineProbe | undefined;
  useSandboxProbe(p: ConfineProbe): void {
    this.probe = p;
  }

  /**
   * Next-round §5.4: loosening a bot's sandbox (a weaker mode, opening the
   * network, a new writable folder) is a raise of a permission, like turning
   * 完全授權 on: only a caller that saw the approve key may do it.
   * Tightening needs nothing. The phone cannot send `sandbox` at all.
   */
  private guardSandbox(id: string | null, body: Record<string, unknown>, approved: boolean): void {
    if (body.sandbox === undefined || approved) return;
    const stored = id ? this.store.bots.get(id)?.sandbox : null;
    let next: string | null;
    try {
      next = mergeBotSandbox(stored, body.sandbox);
    } catch {
      return; // the profile check reports the bad value
    }
    const why = loosens(parseBotSandbox(stored ?? null), parseBotSandbox(next));
    if (why) throw new TeamApiError(403, tSource("core.team.sandboxNeedsWindow", { why }));
  }

  /** P13: bot folders are checked against the data folder (set once by the desktop). */
  private workDirs: BotWorkDirs | undefined;
  useWorkDirs(w: BotWorkDirs): void {
    this.workDirs = w;
  }

  /**
   * Turning 完全授權 on is a raise of a permission: only a caller that saw the
   * approve key may do it (the loopback route with `x-alca-approve`). Turning
   * it off, or keeping it on, needs nothing. The phone never turns it on
   * (link-team-ops.ts refuses first).
   */
  private guardFullAccess(id: string | null, body: Record<string, unknown>, approved: boolean): void {
    if (body.approvalLevel !== "full_access" || approved) return;
    if (id && this.store.bots.get(id)?.approvalLevel === "full_access") return;
    throw new TeamApiError(403, tSource("core.team.fullAccessNeedsWindow"));
  }

  create(body: Record<string, unknown>, o: { fullAccessApproved?: boolean } = {}): BotView {
    if (this.store.bots.list().length >= 12) throw bad(tSource("core.team.max"));
    this.guardFullAccess(null, body, o.fullAccessApproved === true);
    this.guardSandbox(null, body, o.fullAccessApproved === true);
    const p = this.profile(body, true);
    const b = this.store.bots.create(p.name as string, {
      ...p,
      color: p.color ?? nextColor(this.store.bots.list()),
    });
    this.changed("created", b.id);
    return this.view(b);
  }

  update(id: string, body: Record<string, unknown>, o: { fullAccessApproved?: boolean } = {}): BotView {
    this.bot(id);
    this.guardFullAccess(id, body, o.fullAccessApproved === true);
    this.guardSandbox(id, body, o.fullAccessApproved === true);
    const b = this.store.bots.update(id, this.profile({ ...body, __id: id }, false));
    this.changed("updated", id);
    return this.view(b);
  }

  archive(id: string): { ok: true } {
    const b = this.bot(id);
    if (b.isDefault) throw bad(tSource("core.team.firstBot"));
    if (this.store.workers.active(id).length || this.store.team.running().some((r) => r.toBotId === id))
      throw new TeamApiError(409, tSource("core.team.botBusy"));
    this.store.bots.archive(id);
    this.changed("archived", id);
    return { ok: true };
  }

  restore(id: string): BotView {
    this.bot(id);
    this.store.bots.restore(id);
    this.changed("restored", id);
    return this.view(this.bot(id));
  }

  setLead(body: Record<string, unknown>): { leadId: string | null } {
    const id =
      body.botId === null || body.botId === undefined || body.botId === "" ? null : String(body.botId);
    if (id && this.bot(id).archivedAt) throw bad(tSource("core.team.archivedLead"));
    this.store.bots.setLead(id);
    this.changed("lead", id ?? undefined);
    return { leadId: id };
  }

  setRules(body: Record<string, unknown>): TeamRules {
    try {
      const r = this.store.team.setRules({
        ...(body.peerApproval !== undefined
          ? { peerApproval: body.peerApproval as TeamRules["peerApproval"] }
          : {}),
        ...(body.maxDepth !== undefined ? { maxDepth: Number(body.maxDepth) } : {}),
        ...(body.maxOpen !== undefined ? { maxOpen: Number(body.maxOpen) } : {}),
      });
      this.changed("rules");
      return r;
    } catch (err) {
      throw bad(String((err as Error).message));
    }
  }

  // ── bot-to-bot trail ──
  private peerView(r: PeerRequest, full = false): PeerView {
    const name = (id: string) => this.store.bots.get(id)?.name ?? id;
    const v: PeerView = { ...r, fromName: name(r.fromBotId), toName: name(r.toBotId) };
    if (full) {
      v.events = this.store.team.events(r.id);
      if (r.peerThreadId) {
        const bots = this.store.threads.runBots(r.peerThreadId);
        v.messages = this.core.messages(r.peerThreadId).map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content.slice(0, 4000),
          botId: m.runId ? (bots.get(m.runId) ?? null) : null,
          createdAt: m.createdAt,
        }));
      }
    }
    return v;
  }

  peers(q: Record<string, string>): PeerView[] {
    const list = q.thread
      ? this.store.team.byRoot(q.thread)
      : this.store.team.recent({ ...(q.bot ? { botId: q.bot } : {}), limit: Number(q.limit) || 50 });
    return list.map((r) => this.peerView(r, q.full === "1"));
  }

  peer(id: string): PeerView {
    const r = this.store.team.request(id);
    if (!r) throw missing(tSource("core.team.noRequest"));
    return this.peerView(r, true);
  }

  async stopPeer(id: string): Promise<{ stopped: boolean }> {
    if (!this.agents) throw new TeamApiError(409, tSource("core.team.routerOff"));
    if (!this.store.team.request(id)) throw missing(tSource("core.team.noRequest"));
    return { stopped: await this.agents.peers.stop(id) };
  }

  /** Who answers a message: an explicit bot, an @mention at the start, or the thread's own bot. */
  addressee(threadId: string, text: string, botId?: unknown): string | undefined {
    if (typeof botId === "string" && botId) {
      const b = this.store.bots.get(botId);
      if (!b || b.archivedAt) throw bad(tSource("core.common.noBot"));
      return b.id;
    }
    const m = mentionOf(text, this.store.bots.list());
    const thread = this.store.threads.get(threadId);
    return m && m.id !== thread?.botId ? m.id : undefined;
  }

  /** The bot a new conversation goes to: the one named, else the lead, else the default. */
  newThreadBot(botId?: unknown): string {
    if (typeof botId === "string" && botId) {
      const b = this.store.bots.get(botId);
      if (!b || b.archivedAt) throw bad(tSource("core.common.noBot"));
      return b.id;
    }
    return this.store.bots.lead()?.id ?? this.core.defaultBotId;
  }
}

/** `@name …` at the start of a message (longest matching name wins). */
export function mentionOf(text: string, bots: readonly Bot[]): Bot | undefined {
  const t = text.trimStart();
  if (!t.startsWith("@") && !t.startsWith("＠")) return undefined;
  const rest = t.slice(1).toLowerCase();
  const hits = bots
    .filter((b) => {
      const n = b.name.toLowerCase();
      if (!rest.startsWith(n)) return false;
      const next = rest.charAt(n.length);
      return next === "" || /[\s,，:：、!！?？。.]/.test(next);
    })
    .sort((a, b) => b.name.length - a.name.length);
  return hits[0];
}

function nextColor(bots: readonly Bot[]): Bot["color"] {
  const used = new Set(bots.map((b) => b.color));
  return BOT_COLORS.find((c) => !used.has(c)) ?? BOT_COLORS[bots.length % BOT_COLORS.length] ?? "ink";
}
