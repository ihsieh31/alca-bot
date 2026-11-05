import { effectiveLevel, nativeLevel, type PermissionLevelT } from "@alca/config";
import { type HarnessKind, parseBotHarness, storeSessions } from "@alca/core";
import {
  type ApiFamily,
  createAcpEngine,
  createApiEngine,
  type Engine,
  PROVIDERS,
  type ProviderStatus,
} from "@alca/engines";
import type { Bot, ProviderKind, Store } from "@alca/store";
import { type ProviderService, type Resolved, vaultKeyFor } from "./providers.ts";

export { vaultKeyFor };

/**
 * Engines per bot (P7). A bot runs on the team's default engine unless it
 * names another: a model service the person added (OpenAI-compatible or
 * Gemini; its key in the local vault as `engine:<id>`, read at call time),
 * or the default engine with another model. Instances are cached by
 * (engine, model) so bots on the same model share one; conversation history
 * of the HTTP engines is kept in the store, so a restart continues it.
 */

/** The built-in choice for the Codex CLI (P9); its engines come from `codex` in the options. */
export const CODEX_CHOICE_ID = "codex";

export interface EngineChoice {
  id: string;
  label: string;
  kind: "default" | "cli" | "acp" | "api" | ProviderKind;
  model: string | null;
  /** A model service needs a key it does not have. */
  needsKey?: boolean;
  /** P11: one of the six shown first. */
  pinned?: boolean;
  /** P11: the last detected status, when the registry knows it. */
  status?: ProviderStatus;
}

/** A bot's engines: router + worker, and (plan §3.2) the worker per harness where it differs. */
export interface EnginePair {
  router: Engine;
  worker: Engine;
  coding?: Engine;
  general?: Engine;
  /** Phase 5: the coding worker of a bot at 完全授權 (Codex on-request + a snapshot before each turn). */
  codingFullAccess?: Engine;
}

export interface EngineSetOptions {
  store: Store;
  /** Label of the team's default engine (e.g. "Claude Code"). */
  defaultLabel: string;
  /** Default engine with another model (Claude Code); undefined = models are not switchable. */
  withModel?: (model: string) => EnginePair;
  /** Codex CLI engines for a bot (P9), with its model or Codex's own default; unset = no Codex choice. */
  codex?: (model: string | undefined) => EnginePair;
  /** Claude Code engines for a bot (P11) when it is not the default engine. */
  claude?: (model: string | undefined) => EnginePair;
  /** The P11 registry: every built-in and custom provider (the only way a bot gets another engine). */
  providers: ProviderService;
  /** The team's approval level (settings `permissions.level`), read when a bot's engine is made. */
  teamLevel?: () => PermissionLevelT;
  /** Work directory for ACP agents. */
  cwd?: string;
  fetch?: typeof fetch;
}

export class EngineSet {
  private readonly o: EngineSetOptions;
  private readonly cache = new Map<string, EnginePair>();

  constructor(o: EngineSetOptions) {
    this.o = o;
  }

  choices(): EngineChoice[] {
    const out: EngineChoice[] = [{ id: "default", label: this.o.defaultLabel, kind: "default", model: null }];
    const reg = this.o.providers;
    for (const { id } of PROVIDERS) {
      if (id === "claude-code" && !this.o.claude) continue;
      if (id === "codex" && !this.o.codex) continue;
      const r = reg.resolve(id);
      if (!r) continue;
      out.push({
        id,
        label: r.def.label,
        kind: r.def.kind,
        model: r.settings.defaultModel ?? r.def.defaultModel ?? null,
        ...(r.def.pinned ? { pinned: true } : {}),
        ...(r.def.kind === "api" && r.def.keyRequired !== false && !reg.hasKey(id) ? { needsKey: true } : {}),
      });
    }
    for (const p of this.o.store.team.providers())
      out.push({
        id: p.id,
        label: p.label,
        kind: p.kind,
        model: p.model || null,
        ...(p.hasKey || !reg.resolve(p.id)?.def.keyRequired ? {} : { needsKey: true }),
      });
    return out;
  }

  /** The engines a bot runs on; undefined = the team's default ones. */
  forBot(botId: string): EnginePair | undefined {
    const bot = this.o.store.bots.get(botId);
    if (!bot) return undefined;
    return this.forChoice(bot);
  }

  /** The engines for an engine choice + model (a bot's, or P13 the one picked for its shell review). */
  forChoice(bot: {
    engineId: string | null;
    model: string | null;
    approvalLevel?: Bot["approvalLevel"] | "team";
  }): EnginePair | undefined {
    const engineId = bot.engineId && bot.engineId !== "default" ? bot.engineId : null;
    if (!engineId) {
      if (!bot.model || !this.o.withModel) return undefined;
      return this.cached(`default|${bot.model}`, () => this.o.withModel?.(bot.model as string));
    }
    if (engineId === CODEX_CHOICE_ID) {
      const make = this.o.codex;
      return make ? this.cached(`codex|${bot.model ?? ""}`, () => make(bot.model ?? undefined)) : undefined;
    }
    if (engineId === "claude-code") {
      const make = this.o.claude;
      if (!make) return bot.model && this.o.withModel ? this.forDefaultModel(bot.model) : undefined;
      return this.cached(`claude|${bot.model ?? ""}`, () => make(bot.model ?? undefined));
    }
    const r = this.o.providers.resolve(engineId);
    if (r && (r.def.kind === "acp" || r.def.kind === "api" || r.custom)) {
      const model = bot.model ?? r.settings.defaultModel ?? r.def.defaultModel ?? r.custom?.model ?? "";
      // One vocabulary (P13): a bot that follows the team runs at the team's level.
      const level = effectiveLevel(bot.approvalLevel, this.o.teamLevel?.() ?? "confirm_each_step");
      const key = `${engineId}|${model}|${level}|${JSON.stringify(r.settings)}|${JSON.stringify(r.custom?.config ?? {})}|${r.custom?.baseUrl ?? ""}`;
      // The router only talks and dispatches (P13): its own instance, and an ACP router always
      // in the agent's asking mode, so a native edit or shell command can never run unasked there.
      // Plan §3.4: an ACP agent gets a coding worker kept in its asking mode (never auto-edit,
      // strict) and a general worker whose native edit / execute kinds are refused.
      return this.cached(key, () => ({
        router: this.registryEngine(r, model, "confirm_each_step"),
        worker: this.registryEngine(r, model, level),
        ...(r.def.kind === "acp"
          ? {
              coding: this.registryEngine(r, model, level, "coding"),
              general: this.registryEngine(r, model, level, "general"),
            }
          : {}),
      }));
    }
    return undefined;
  }

  /**
   * Plan §3.2 (P15 A4): the engine a bot's worker runs on for one harness — the
   * bot's own choice for that harness (engine and / or model), else the bot's
   * engine; that engine's harness launch when it has one. Undefined = the
   * team's default engine (the supervisor then uses its default per harness).
   */
  forHarness(botId: string, kind: HarnessKind): Engine | undefined {
    const bot = this.o.store.bots.get(botId);
    if (!bot) return undefined;
    const cfg = parseBotHarness(bot.harness)[kind];
    const own = cfg?.engineId || cfg?.model;
    const pair = own
      ? this.forChoice({
          engineId: cfg?.engineId ?? bot.engineId,
          model: cfg?.model ?? (cfg?.engineId ? null : bot.model),
          approvalLevel: bot.approvalLevel,
        })
      : this.forBot(botId);
    if (!pair) return undefined;
    // Phase 5: only the person's own 完全授權 picks the faster coding launch; the host still checks the fit.
    if (kind === "coding" && bot.approvalLevel === "full_access" && pair.codingFullAccess)
      return pair.codingFullAccess;
    return pair[kind] ?? pair.worker;
  }

  private forDefaultModel(model: string) {
    return this.cached(`default|${model}`, () => this.o.withModel?.(model));
  }

  /** An engine from the P11 registry: an ACP agent or a model API. */
  private registryEngine(r: Resolved, model: string, level: PermissionLevelT, harness?: HarnessKind): Engine {
    const reg = this.o.providers;
    const id = r.def.id;
    const apiKey = () => reg.apiKey(id);
    if (r.def.kind === "acp") {
      const command = r.custom?.config.command ?? r.settings.command;
      const keyEnv = r.custom?.config.keyEnv;
      return createAcpEngine(r.def, {
        id,
        ...(command?.length ? { command } : {}),
        ...(model ? { model } : {}),
        cwd: this.o.cwd ?? process.cwd(),
        sessions: storeSessions(this.o.store, id),
        // Phase 5: 完全授權 is Alca's gate only; the agent's own mode stays at 自主's at most.
        approvalMode: nativeLevel(level),
        ...(harness ? { harness } : {}),
        ...(keyEnv ? { keyEnv, apiKey } : {}),
        ...(r.custom?.config.env ? { baseEnv: r.custom.config.env } : {}),
      });
    }
    const baseUrl = r.custom?.baseUrl ?? r.settings.baseUrl ?? r.def.baseUrl;
    return createApiEngine(r.def, {
      id,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(r.settings.family ? { family: r.settings.family as ApiFamily } : {}),
      apiKey,
      history: storeSessions(this.o.store, id),
      ...(r.settings.reasoningEffort ? { reasoningEffort: r.settings.reasoningEffort } : {}),
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
  }

  private cached(key: string, make: () => EnginePair | undefined) {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const made = make();
    if (made) this.cache.set(key, made);
    return made;
  }

  /** Is this a known engine id (a model service or a built-in CLI choice)? */
  /**
   * P14: the models an add-on (回覆檢查) may pick for a bot — the configured
   * model services that can run now (no missing key), the bot's own first,
   * each with its default model and up to eight models of its built-in list.
   */
  modelChoices(botId: string): Array<{ engine: string; model: string | null; label: string }> {
    const own = this.o.store.bots.get(botId)?.engineId ?? null;
    const usable = this.choices().filter((c) => c.id !== "default" && !c.needsKey);
    usable.sort((a, b) => Number(b.id === own) - Number(a.id === own));
    const out: Array<{ engine: string; model: string | null; label: string }> = [];
    for (const c of usable) {
      out.push({
        engine: c.id,
        model: null,
        label: `${c.label} · 預設模型${c.model ? `（${c.model}）` : ""}`,
      });
      const listed = this.o.providers.resolve(c.id)?.def.models ?? [];
      for (const m of listed.slice(0, 8))
        out.push({ engine: c.id, model: m.id, label: `${c.label} · ${m.label ?? m.id}` });
    }
    return out;
  }

  /** P14: the router engine for an add-on's picked model; undefined = cannot build it (the caller falls back). */
  forAddonModel(engine: string | null, model: string | null): Engine | undefined {
    if (!engine) return undefined;
    return this.forChoice({ engineId: engine, model, approvalLevel: "confirm_each_step" })?.router;
  }

  has(id: string): boolean {
    if (id === "claude-code" && (this.o.claude || this.o.withModel)) return true;
    return this.choices().some((c) => c.id === id);
  }

  async dispose(): Promise<void> {
    const seen = new Set<Engine>();
    for (const p of this.cache.values())
      for (const e of [p.router, p.worker, p.coding, p.general]) if (e) seen.add(e);
    this.cache.clear();
    await Promise.all([...seen].map((e) => e.dispose().catch(() => undefined)));
  }
}
