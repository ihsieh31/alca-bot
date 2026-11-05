import type { AgentsEventData } from "@alca/protocol";
import type { Store } from "@alca/store";
import { ADDONS, type AddonManifest, addonManifest, EARLY_WORK_ID, REQUIREMENT_WORDS } from "./manifest.ts";

export class AddonError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AddonUsageView {
  day: string;
  runs: number;
  tokens: number;
  runCap: number | null;
  tokenCap: number | null;
  /** Today's cap was reached: the add-on does not run again until the next local day. */
  capped: boolean;
}

export interface AddonView {
  id: string;
  name: string;
  description: string;
  costClass: AddonManifest["costClass"];
  enabled: boolean;
  settings: Record<string, unknown>;
  defaults: Record<string, unknown>;
  /** Requirements this bot does not meet now, in words (cannot be turned on while any is left). */
  unmet: string[];
  usage: AddonUsageView | null;
  /** Extra lines the add-on wants under its settings (e.g. accept rates). */
  notes: string[];
  /**
   * Numbers the add-on measures about itself (主動留意: precision over 30
   * days — accept / dismiss / ignored rates, candidates per drop reason), for
   * a settings view to show. Absent when the add-on measures nothing.
   */
  metrics?: Record<string, unknown>;
  /** Add-ons that pick a model (回覆檢查): what `engine` + `model` may be; the first is the default. */
  modelChoices?: AddonModelChoice[];
}

/** One model an add-on may run on. `engine` null = the bot's own router model. */
export interface AddonModelChoice {
  engine: string | null;
  model: string | null;
  label: string;
}

/** The choice that is always there: the bot's own router model. */
export const ROUTER_MODEL_CHOICE: AddonModelChoice = {
  engine: null,
  model: null,
  label: "跟這個 bot 的總機模型一樣（預設）",
};

export interface AddonEnv {
  /** The bot's engine can answer one tool-less prompt. */
  canComplete?(botId: string): boolean;
  /** Connected apps the bot may read. */
  connectedApps?(botId: string): number;
  /** Extra checks on settings (e.g. that a picked engine exists); a string is the refusal. */
  validate?(botId: string, addonId: string, settings: Record<string, unknown>): string | undefined;
  /** Models an add-on may pick for this bot (besides its router model): the bot's configured model services. */
  modelChoices?(botId: string): AddonModelChoice[];
}

export interface AddonServiceOptions {
  store: Store;
  /** Zone of the local day the caps count in (default Asia/Taipei). */
  timeZone?: string;
  now?: () => Date;
  env?: AddonEnv;
  /** `addon.capped` on the agents channel. */
  emit?: (d: AgentsEventData<"addon.capped">) => void;
  /** 提前做's own per-day cap (shown as its usage). */
  earlyMaxPerDay?: () => number;
}

export type AddonListener = (e: { botId: string; addonId: string; enabled: boolean; was: boolean }) => void;
export type AddonNotes = (botId: string) => string[];
export type AddonMetrics = (botId: string) => Record<string, unknown>;

/** Local calendar day `YYYY-MM-DD` in a zone. */
export function localDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Deep-merge a settings patch over the current values (objects merge, the rest replaces). */
function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

/**
 * Add-ons per bot (P14): the switch, the settings (validated by the add-on's
 * own schema), the requirements, and the daily usage with its caps. An
 * add-on that spends asks `allowance` before each run and `charge`s what it
 * spent; past a cap it stops for the rest of the local day and `addon.capped`
 * goes out once. The P13 features (提前做, shell review) are add-ons through
 * adapters that read and write their original bot columns.
 */
export class AddonService {
  private readonly o: AddonServiceOptions;
  private readonly now: () => Date;
  private readonly listeners = new Set<AddonListener>();
  private readonly notes = new Map<string, AddonNotes>();
  private readonly metrics = new Map<string, AddonMetrics>();

  constructor(o: AddonServiceOptions) {
    this.o = o;
    this.now = o.now ?? (() => new Date());
  }

  get store(): Store {
    return this.o.store;
  }

  get timeZone(): string {
    return this.o.timeZone ?? "Asia/Taipei";
  }

  manifests(): readonly AddonManifest[] {
    return ADDONS;
  }

  /** Called after an add-on is turned on or off (the add-on stops its schedule, clears its queue). */
  onToggle(fn: AddonListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** An add-on adds lines under its settings (accept rates …). */
  useNotes(addonId: string, fn: AddonNotes): void {
    this.notes.set(addonId, fn);
  }

  /** An add-on reports numbers about itself (gap analysis 2026-11: 主動留意's precision). */
  useMetrics(addonId: string, fn: AddonMetrics): void {
    this.metrics.set(addonId, fn);
  }

  day(d = this.now()): string {
    return localDay(d, this.timeZone);
  }

  private manifest(id: string): AddonManifest {
    const m = addonManifest(id);
    if (!m) throw new AddonError(404, "沒有這個擴充");
    return m;
  }

  private bot(botId: string) {
    const b = this.store.bots.get(botId);
    if (!b) throw new AddonError(404, "沒有這個 bot");
    return b;
  }

  private raw(botId: string, m: AddonManifest): { enabled: boolean; settings: Record<string, unknown> } {
    if (m.adapter) return m.adapter.read(this.bot(botId));
    const r = this.store.addons.get(botId, m.id);
    return { enabled: r?.enabled ?? m.defaultEnabled, settings: r?.settings ?? {} };
  }

  /** The add-on's settings for a bot, defaults filled in (a stored value that no longer parses falls back). */
  settingsOf<T = Record<string, unknown>>(botId: string, id: string): T {
    const m = this.manifest(id);
    const r = m.settings.safeParse(this.raw(botId, m).settings);
    return (r.success ? r.data : m.settings.parse({})) as T;
  }

  isEnabled(botId: string, id: string): boolean {
    try {
      const b = this.store.bots.get(botId);
      if (!b || b.archivedAt) return false;
      return this.raw(botId, this.manifest(id)).enabled;
    } catch {
      return false;
    }
  }

  /** Bots that have this add-on on now. */
  enabledBots(id: string): string[] {
    const m = this.manifest(id);
    const ids = m.adapter
      ? this.store.bots.list().map((b) => b.id)
      : this.store.addons.enabledFor(id).map((r) => r.botId);
    return ids.filter((b) => this.isEnabled(b, id));
  }

  private unmet(botId: string, m: AddonManifest): string[] {
    const env = this.o.env ?? {};
    const out: string[] = [];
    for (const r of m.requires) {
      const ok =
        r === "engine_completion"
          ? (env.canComplete?.(botId) ?? true)
          : r === "connected_app"
            ? (env.connectedApps?.(botId) ?? 0) > 0
            : false;
      if (!ok) out.push(REQUIREMENT_WORDS[r]);
    }
    return out;
  }

  private caps(botId: string, m: AddonManifest): { tokenCap: number | null; runCap: number | null } {
    if (m.dailyTokenCap === null && m.dailyRunCap === null) return { tokenCap: null, runCap: null };
    const s = this.settingsOf<{ dailyTokenCap?: number; dailyRunCap?: number }>(botId, m.id);
    return { tokenCap: s.dailyTokenCap ?? m.dailyTokenCap, runCap: s.dailyRunCap ?? m.dailyRunCap };
  }

  usage(botId: string, id: string): AddonUsageView | null {
    const m = this.manifest(id);
    const day = this.day();
    if (m.id === EARLY_WORK_ID) {
      const cap = this.o.earlyMaxPerDay?.();
      const runs = this.store.early.startedSince(botId, new Date(this.now().getTime() - 24 * 3600_000));
      return {
        day,
        runs,
        tokens: 0,
        runCap: cap ?? null,
        tokenCap: null,
        capped: cap !== undefined && runs >= cap,
      };
    }
    const { tokenCap, runCap } = this.caps(botId, m);
    if (tokenCap === null && runCap === null) return null;
    const u = this.store.addons.usage(botId, id, day);
    const tokens = u.inputTokens + u.outputTokens;
    const capped =
      !!u.cappedAt || (tokenCap !== null && tokens >= tokenCap) || (runCap !== null && u.runs >= runCap);
    return { day, runs: u.runs, tokens, runCap, tokenCap, capped };
  }

  /** The models a `pickModel` add-on may run on for this bot: the router model first. */
  modelChoices(botId: string): AddonModelChoice[] {
    let more: AddonModelChoice[] = [];
    try {
      more = this.o.env?.modelChoices?.(botId) ?? [];
    } catch {
      more = [];
    }
    return [ROUTER_MODEL_CHOICE, ...more.filter((c) => c.engine !== null)];
  }

  view(botId: string, id: string): AddonView {
    const m = this.manifest(id);
    this.bot(botId);
    const raw = this.raw(botId, m);
    let notes: string[] = [];
    try {
      notes = this.notes.get(id)?.(botId) ?? [];
    } catch {
      notes = [];
    }
    let metrics: Record<string, unknown> | undefined;
    try {
      metrics = this.metrics.get(id)?.(botId);
    } catch {
      metrics = undefined;
    }
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      costClass: m.costClass,
      enabled: raw.enabled,
      settings: this.settingsOf(botId, id),
      defaults: m.settings.parse({}) as Record<string, unknown>,
      unmet: this.unmet(botId, m),
      usage: this.usage(botId, id),
      notes,
      ...(metrics ? { metrics } : {}),
      ...(m.pickModel ? { modelChoices: this.modelChoices(botId) } : {}),
    };
  }

  list(botId: string): AddonView[] {
    this.bot(botId);
    return ADDONS.map((m) => this.view(botId, m.id));
  }

  /** Turn on / off and / or change settings. Turning on checks the requirements; settings are validated whole. */
  set(botId: string, id: string, patch: { enabled?: unknown; settings?: unknown }): AddonView {
    const m = this.manifest(id);
    const bot = this.bot(botId);
    if (bot.archivedAt) throw new AddonError(409, "這個 bot 已經封存");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean")
      throw new AddonError(400, "enabled 要是 true 或 false");
    if (patch.settings !== undefined && !isObj(patch.settings))
      throw new AddonError(400, "settings 要是物件");
    const was = this.raw(botId, m).enabled;
    const enabled = patch.enabled as boolean | undefined;
    if (enabled && !was) {
      const missing = this.unmet(botId, m);
      if (missing.length) throw new AddonError(409, `還不能開啟：${missing.join("；")}`);
    }
    let settings: Record<string, unknown> | undefined;
    if (patch.settings) {
      const parsed = m.settings.safeParse(merge(this.settingsOf(botId, id), patch.settings));
      if (!parsed.success)
        throw new AddonError(
          400,
          parsed.error.issues.map((i) => `${i.path.join(".")}：${i.message}`).join("；"),
        );
      settings = parsed.data as Record<string, unknown>;
      if (m.pickModel) {
        const engine = (settings.engine as string | null) ?? null;
        const model = engine === null ? null : ((settings.model as string | null) ?? null);
        settings = { ...settings, engine, model };
        if (!this.modelChoices(botId).some((c) => c.engine === engine && c.model === model))
          throw new AddonError(400, "這個 bot 沒有設定這個模型；請從清單裡選");
      }
      const refusal = this.o.env?.validate?.(botId, id, settings);
      if (refusal) throw new AddonError(400, refusal);
    }
    if (m.adapter) {
      this.store.bots.update(
        botId,
        m.adapter.write({ ...(enabled !== undefined ? { enabled } : {}), ...(settings ? { settings } : {}) }),
        this.now(),
      );
    } else {
      this.store.addons.set(
        botId,
        id,
        { ...(enabled !== undefined ? { enabled } : {}), ...(settings ? { settings } : {}) },
        this.now(),
      );
    }
    const now = this.raw(botId, m).enabled;
    if (now !== was)
      for (const fn of this.listeners) {
        try {
          fn({ botId, addonId: id, enabled: now, was });
        } catch {
          // a listener must not undo the switch the person made
        }
      }
    return this.view(botId, id);
  }

  /**
   * May the add-on run for this bot now? Off, archived bot, or today's cap
   * reached → no (the first time a cap is seen today, `addon.capped` goes out).
   */
  allowance(botId: string, id: string): { ok: true } | { ok: false; reason: "off" | "capped" } {
    if (!this.isEnabled(botId, id)) return { ok: false, reason: "off" };
    const u = this.usage(botId, id);
    if (u?.capped) {
      this.capped(botId, id, u);
      return { ok: false, reason: "capped" };
    }
    return { ok: true };
  }

  private capped(botId: string, id: string, u: AddonUsageView): void {
    if (!this.store.addons.markCapped(botId, id, u.day, this.now())) return;
    const reason = u.runCap !== null && u.runs >= u.runCap ? "runs" : "tokens";
    try {
      this.o.emit?.({ botId, addonId: id, day: u.day, reason });
    } catch {
      // the event is a notice; the cap holds either way
    }
  }

  /** Add what one run spent. Returns whether the add-on is now capped for today. */
  charge(
    botId: string,
    id: string,
    spent: { runs?: number; inputTokens?: number; outputTokens?: number },
  ): boolean {
    this.store.addons.charge(botId, id, this.day(), spent);
    const u = this.usage(botId, id);
    if (u?.capped) this.capped(botId, id, u);
    return !!u?.capped;
  }

  /** The add-on's own state (stored rows only). */
  state(botId: string, id: string): Record<string, unknown> {
    return this.store.addons.get(botId, id)?.state ?? {};
  }

  setState(botId: string, id: string, state: Record<string, unknown>): void {
    this.store.addons.setState(botId, id, state, this.now());
  }

  /** When the add-on was last turned on (it starts from then, never catches up). */
  enabledAt(botId: string, id: string): string | null {
    return this.store.addons.get(botId, id)?.enabledAt ?? null;
  }
}
