import {
  APPS,
  appInfo,
  ConnectorError,
  enableAppTrigger,
  McpError,
  type ServerInput,
} from "@alca/connectors";
import { type AgentSystem, type AlcaCore, describeCron, RoutineError, type RoutineInput } from "@alca/core";
import { tSource } from "@alca/design/i18n";
import type { ConnectorAccess, RoutineRecord } from "@alca/store";
import type { ConnectorSetup } from "./connectors.ts";
import { SiteLoginsApi } from "./site-logins-api.ts";

/**
 * The connectors + routines API shared by the loopback routes and the
 * phone's Link ops. The Composio key is accepted here (desktop only) and
 * never returned: status shows only whether it is set and its last four.
 */

export class ConnectorsApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function wrap(err: unknown): never {
  if (err instanceof ConnectorsApiError) throw err;
  if (err instanceof ConnectorError)
    throw new ConnectorsApiError(
      err.code === "not_found" ? 404 : err.code === "no_key" ? 409 : 400,
      err.message,
    );
  if (err instanceof RoutineError) throw new ConnectorsApiError(400, err.message);
  // Next round R8: the person's MCP servers.
  if (err instanceof McpError)
    throw new ConnectorsApiError(
      err.code === "not_found"
        ? 404
        : typeof err.code === "string" && err.code.startsWith("bad_")
          ? 400
          : 502,
      tSource("core.connectors.mcpError", { message: err.message }),
    );
  const status = (err as { status?: number }).status;
  if (typeof status === "number" && status > 0)
    throw new ConnectorsApiError(
      502,
      tSource("core.connectors.composioError", { message: String((err as Error).message) }),
    );
  throw new ConnectorsApiError(502, String((err as Error)?.message ?? err));
}

export interface RoutineView {
  id: string;
  botId: string;
  threadId: string;
  threadTitle: string;
  name: string;
  kind: RoutineRecord["kind"];
  schedule: string;
  check: string;
  instructions: string;
  speculative: boolean;
  enabled: boolean;
  state: "ok" | "error" | "working" | "off";
  lastError: string | null;
  lastCheckedAt: string | null;
  nextAt: string | null;
  backoffUntil: string | null;
  aiRunsToday: number;
  runs: Array<{
    id: string;
    outcome: string;
    items: number;
    detail: string;
    at: string;
    workerId: string | null;
  }>;
}

export class ConnectorsApi {
  readonly setup: ConnectorSetup;
  private readonly core: AlcaCore;
  private readonly agents: AgentSystem | undefined;
  private lastRefresh = 0;

  constructor(setup: ConnectorSetup, core: AlcaCore, agents: AgentSystem | undefined) {
    this.setup = setup;
    this.core = core;
    this.agents = agents;
  }

  private siteLogins: SiteLoginsApi | undefined;
  /** Design §0.2.7: website passwords for the general harness's browser (in the same vault). */
  get logins(): SiteLoginsApi {
    this.siteLogins ??= new SiteLoginsApi(this.setup.vault, this.core);
    return this.siteLogins;
  }

  private changed(
    op: "key" | "connecting" | "active" | "failed" | "removed" | "renamed" | "grants" | "trigger",
    accountId?: string,
  ) {
    this.agents?.announce("connector.changed", { op, ...(accountId ? { accountId } : {}) });
  }

  async status(o: { refresh?: boolean } = {}) {
    let error: string | undefined;
    if (o.refresh !== false && Date.now() - this.lastRefresh > 3000) {
      this.lastRefresh = Date.now();
      try {
        const r = await this.setup.service.refresh();
        if (r.changed) this.changed("active");
      } catch (err) {
        error = String((err as Error)?.message ?? err);
      }
    }
    const st = await this.setup.service.status();
    const p = this.setup.puller();
    return {
      ...st,
      integrations: {
        mcp: { servers: this.servers() },
      },
      ...(error ? { error } : {}),
      relay: p
        ? { hookUrl: p.hookUrl(), lastPullAt: p.lastPullAt ?? null, lastError: p.lastError ?? null }
        : null,
      routinesOn: !!this.agents,
    };
  }

  async setKey(body: Record<string, unknown>) {
    try {
      await this.setup.service.setKey(str(body.key));
    } catch (err) {
      wrap(err);
    }
    this.changed("key");
    return this.status({ refresh: false });
  }

  async clearKey() {
    await this.setup.service.clearKey();
    this.changed("key");
    return this.status({ refresh: false });
  }

  async connect(body: Record<string, unknown>) {
    try {
      const r = await this.setup.service.connect({
        toolkit: str(body.toolkit),
        label: str(body.label),
        ...(str(body.botId) ? { botId: str(body.botId) } : {}),
        ...(str(body.callbackUrl) ? { callbackUrl: str(body.callbackUrl) } : {}),
      });
      this.changed("connecting", r.account.id);
      return r;
    } catch (err) {
      wrap(err);
    }
  }

  async refresh() {
    try {
      await this.setup.service.refresh();
    } catch (err) {
      wrap(err);
    }
    this.lastRefresh = Date.now();
    this.changed("active");
    return this.status({ refresh: false });
  }

  async disconnect(id: string) {
    try {
      await this.setup.service.disconnect(id);
    } catch (err) {
      wrap(err);
    }
    this.changed("removed", id);
    return { ok: true };
  }

  rename(id: string, body: Record<string, unknown>) {
    try {
      this.setup.service.rename(id, str(body.label));
    } catch (err) {
      wrap(err);
    }
    this.changed("renamed", id);
    return { ok: true };
  }

  grant(accountId: string, botId: string, body: Record<string, unknown>) {
    const access = body.access === "read" || body.access === "act" ? (body.access as ConnectorAccess) : null;
    try {
      this.setup.service.setGrant(botId, accountId, access);
    } catch (err) {
      wrap(err);
    }
    this.changed("grants", accountId);
    return { ok: true };
  }

  /**
   * The phone's grant (next round R8): on an MCP account the
   * phone may only lower a bot's access (act → read → none); widening is the
   * desktop 連接 page's. Composio accounts keep P6's rule (approve scope).
   */
  grantFromPhone(accountId: string, botId: string, body: Record<string, unknown>) {
    const store = this.core.store;
    const acc = store.connectors.account(accountId);
    if (acc && acc.provider !== "composio") {
      const rank = (a: unknown) => (a === "act" ? 2 : a === "read" ? 1 : 0);
      const now = store.connectors.grants({ accountId }).find((g) => g.botId === botId)?.access ?? null;
      const want = body.access === "read" || body.access === "act" ? body.access : null;
      if (rank(want) > rank(now))
        throw new ConnectorsApiError(409, tSource("core.connectors.phoneTightenOnly"));
    }
    return this.grant(accountId, botId, body);
  }

  /** Turn on an app trigger: events come back through the relay and the trigger filter. */
  async enableTrigger(accountId: string, body: Record<string, unknown>) {
    const p = this.setup.puller();
    if (!this.agents) throw new ConnectorsApiError(409, tSource("core.connectors.triggersNeedRouter"));
    if (!p) throw new ConnectorsApiError(409, tSource("core.connectors.triggersNeedRelay"));
    const threadId =
      str(body.threadId) || this.core.listThreads()[0]?.id || this.core.createThread("連接的 app").id;
    try {
      const r = await enableAppTrigger(
        {
          store: this.core.store,
          service: this.setup.service,
          puller: p,
          createTrigger: (t) =>
            this.agents?.triggers.create(t) as ReturnType<AgentSystem["triggers"]["create"]>,
        },
        {
          accountId,
          slug: str(body.slug),
          threadId,
          ...(body.config && typeof body.config === "object"
            ? { config: body.config as Record<string, unknown> }
            : {}),
          rule: { mode: body.mode === "explicit" || body.mode === "ignore" ? body.mode : "candidate" },
          semantic: str(body.semantic) || null,
        },
      );
      this.changed("trigger", accountId);
      const routine = body.routine as Record<string, unknown> | undefined;
      if (routine)
        this.agents.routines.create({
          threadId,
          name: str(routine.name) || "新事件",
          kind: "trigger",
          triggerId: r.triggerId,
          check: { kind: "queue" },
          instructions: str(routine.instructions),
          speculative: routine.speculative === true,
        });
      return r;
    } catch (err) {
      wrap(err);
    }
  }

  // ── next round R8: the person's MCP servers ────────────────
  /** Servers as the UI shows them: secret names only, never their values. */
  servers() {
    return this.core.store.connectors.servers().map((s) => ({
      id: s.id,
      label: s.label,
      transport: s.transport,
      command: s.command,
      args: s.args,
      cwd: s.cwd,
      url: s.url,
      secretNames: s.secretNames,
      enabled: s.enabled,
      accountId: this.core.store.connectors.byRemote(s.id, "mcp")?.id ?? null,
    }));
  }

  /** Add or change a server (the route asks for the approve key: a new program / endpoint widens what runs). */
  async saveServer(id: string, body: Record<string, unknown>) {
    const secrets: Record<string, string> = {};
    if (body.secrets && typeof body.secrets === "object")
      for (const [k, v] of Object.entries(body.secrets as Record<string, unknown>))
        secrets[k] = typeof v === "string" ? v : "";
    const input: ServerInput = {
      id,
      label: str(body.label),
      // Checked by saveServer (stdio | http).
      transport: str(body.transport) as ServerInput["transport"],
      command: str(body.command) || null,
      args: Array.isArray(body.args) ? body.args.map(String) : [],
      cwd: str(body.cwd) || null,
      url: str(body.url) || null,
      secrets,
      enabled: body.enabled !== false,
    };
    try {
      await this.setup.mcp.saveServer(input, str(body.botId) || undefined);
    } catch (err) {
      wrap(err);
    }
    const check = await this.setup.mcp.check(input.id.trim().toLowerCase());
    const acc = this.core.store.connectors.byRemote(input.id.trim().toLowerCase(), "mcp");
    this.changed(check.ok ? "active" : "failed", acc?.id);
    return { server: this.servers().find((s) => s.id === input.id.trim().toLowerCase()), check };
  }

  async checkServer(id: string) {
    if (!this.core.store.connectors.server(id))
      throw new ConnectorsApiError(404, tSource("core.connectors.noMcp"));
    const r = await this.setup.mcp.check(id);
    this.changed(r.ok ? "active" : "failed", this.core.store.connectors.byRemote(id, "mcp")?.id);
    return r;
  }

  async removeServer(id: string) {
    const accountId = this.core.store.connectors.byRemote(id, "mcp")?.id;
    try {
      await this.setup.mcp.removeServer(id);
    } catch (err) {
      wrap(err);
    }
    this.changed("removed", accountId);
    return { ok: true };
  }

  // ── routines ────────────────────────────────────────────────
  private routines() {
    if (!this.agents) throw new ConnectorsApiError(409, tSource("core.connectors.routinesNeedRouter"));
    return this.agents.routines;
  }

  view(r: RoutineRecord): RoutineView {
    const runner = this.routines();
    const store = this.core.store;
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const schedule =
      r.kind === "interval"
        ? (r.intervalSec ?? 0) % 3600 === 0
          ? `每 ${(r.intervalSec ?? 0) / 3600} 小時`
          : `每 ${Math.round((r.intervalSec ?? 0) / 60)} 分鐘`
        : r.kind === "cron"
          ? `${describeCron(r.cron ?? "")}（${r.tz}）`
          : r.kind === "once"
            ? `一次：${new Date(r.runAt ?? 0).toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" })}`
            : `有事件時（${store.triggers.get(r.triggerId ?? "")?.name ?? "觸發器"}）`;
    return {
      id: r.id,
      botId: r.botId,
      threadId: r.threadId,
      threadTitle: store.threads.get(r.threadId)?.title ?? "",
      name: r.name,
      kind: r.kind,
      schedule,
      check: runner.describeCheck(r),
      instructions: r.instructions,
      speculative: r.speculative,
      enabled: r.enabled,
      state: !r.enabled ? "off" : r.pendingWorker ? "working" : r.lastError ? "error" : "ok",
      lastError: r.lastError,
      lastCheckedAt: r.lastCheckedAt,
      nextAt: r.nextDueAt,
      backoffUntil: r.backoffUntil,
      aiRunsToday: store.routines.aiRunsSince(r.botId, since),
      runs: store.routines.runs(r.id, 8).map((x) => ({
        id: x.id,
        outcome: x.outcome,
        items: x.items,
        detail: x.detail,
        at: x.createdAt,
        workerId: x.workerId,
      })),
    };
  }

  listRoutines(botId?: string) {
    const list = this.core.store.routines.list(botId);
    return {
      routines: list.map((r) => this.view(r)),
      drafts: this.core.store.routines.drafts({ status: "ready" }).map((d) => ({
        id: d.id,
        threadId: d.threadId,
        title: d.title,
        kind: d.kind,
        body: d.body.slice(0, 600),
        target: d.target,
        createdAt: d.createdAt,
      })),
      apps: APPS.filter((a) => a.poll).map((a) => ({ toolkit: a.toolkit, name: a.name })),
    };
  }

  createRoutine(body: Record<string, unknown>) {
    const runner = this.routines();
    const check = (body.check as Record<string, unknown> | undefined) ?? {};
    const kind = str(body.kind) as RoutineInput["kind"];
    const threadId =
      str(body.threadId) || this.core.createThread(str(body.name).slice(0, 40) || "例行工作").id;
    try {
      const r = runner.create({
        threadId,
        name: str(body.name),
        kind,
        ...(body.intervalSec !== undefined ? { intervalSec: Number(body.intervalSec) } : {}),
        ...(str(body.cron) ? { cron: str(body.cron) } : {}),
        ...(str(body.tz) ? { tz: str(body.tz) } : {}),
        ...(str(body.runAt) ? { runAt: str(body.runAt) } : {}),
        ...(str(body.triggerId) ? { triggerId: str(body.triggerId) } : {}),
        check: { ...check, kind: str(check.kind) || "app" },
        instructions: str(body.instructions),
        speculative: body.speculative === true,
      });
      return this.view(r);
    } catch (err) {
      wrap(err);
    }
  }

  setRoutineEnabled(id: string, enabled: boolean) {
    try {
      return this.view(this.routines().setEnabled(id, enabled));
    } catch (err) {
      wrap(err);
    }
  }

  async runRoutine(id: string) {
    try {
      await this.routines().runNow(id);
    } catch (err) {
      wrap(err);
    }
    const r = this.core.store.routines.get(id);
    if (!r) throw new ConnectorsApiError(404, tSource("core.connectors.noRoutine"));
    return this.view(r);
  }

  removeRoutine(id: string) {
    if (!this.core.store.routines.get(id))
      throw new ConnectorsApiError(404, tSource("core.connectors.noRoutine"));
    this.core.store.routines.remove(id);
    return { ok: true };
  }

  // ── drafts (提前做) ──────────────────────────────────────────
  drafts(threadId?: string) {
    return this.core.store.routines.drafts({ ...(threadId ? { threadId } : {}), status: "ready" });
  }

  /** Using a draft is a new request in its chat: the router dispatches it, and sending still asks. */
  useDraft(id: string) {
    const d = this.core.store.routines.draft(id);
    if (d?.status !== "ready") throw new ConnectorsApiError(404, tSource("core.connectors.noDraft"));
    this.core.store.routines.setDraftStatus(id, "used");
    const to = typeof d.target.to === "string" ? `給 ${d.target.to}` : "";
    const app = typeof d.target.app === "string" ? appInfo(d.target.app).name : "";
    return {
      threadId: d.threadId,
      text: `請用${app || "對應的 app"}把草稿 ${d.id}（${d.title}）寄出${to}。內容：\n${d.body}`,
    };
  }

  discardDraft(id: string) {
    const d = this.core.store.routines.draft(id);
    if (d?.status !== "ready") throw new ConnectorsApiError(404, tSource("core.connectors.noDraft"));
    this.core.store.routines.setDraftStatus(id, "discarded");
    return { ok: true };
  }
}
