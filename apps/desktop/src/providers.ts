import type { Vault } from "@alca/connectors";
import { tSource } from "@alca/design/i18n";
import {
  type ApiFamily,
  type Detection,
  detectProvider,
  listModels,
  type ModelList,
  PROVIDERS,
  type ProviderCaps,
  type ProviderDef,
  type ProviderStatus,
  providerDef,
  type Runner,
} from "@alca/engines";
import type { EngineProvider, ProviderSettings, Store } from "@alca/store";

/**
 * 模型與供應商 (P11): the registry as the desktop sees it — every built-in
 * provider plus the person's custom ones, each with its detected status and
 * one-line fix, its settings, and its model list. Keys go to the local
 * encrypted vault as `engine:<id>` and are never returned: views only say
 * whether one is set.
 */

export const vaultKeyFor = (providerId: string) => `engine:${providerId}`;

export interface ProviderView {
  id: string;
  label: string;
  kind: ProviderDef["kind"];
  family?: ApiFamily;
  pinned: boolean;
  custom: boolean;
  blurb: string;
  status: ProviderStatus;
  hint: string;
  version?: string;
  hasKey: boolean;
  keyRequired: boolean;
  keyUrl?: string;
  baseUrl?: string;
  command?: string[];
  defaultModel?: string;
  caps: ProviderCaps;
  nativeApproval: string;
  /** For API providers: "openai-responses" | "openai-chat" etc. the person may switch (OpenAI only). */
  families?: ApiFamily[];
}

export class ProviderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const bad = (m: string) => new ProviderError(400, m);
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/;
const DETECT_TTL_MS = 60_000;

/** A custom provider as a catalog entry. */
export function customDef(p: EngineProvider): ProviderDef {
  const models = (p.config.models ?? (p.model ? [p.model] : [])).map((id) => ({ id }));
  if (p.kind === "acp")
    return {
      id: p.id,
      label: p.label,
      kind: "acp",
      blurb: "自訂 ACP 代理",
      binary: p.config.command?.[0] ?? "",
      acpArgs: p.config.command?.slice(1) ?? [],
      modes: {
        confirm_each_step: ["default"],
        autonomous: ["auto_edit", "autoEdit", "acceptEdits"],
      },
      nativeApproval: "代理要動手前都會問，Alca 的閘門依 bot 的權限回答；付款、寄送、刪除、發布一律問你。",
      models,
      ...(p.model ? { defaultModel: p.model } : {}),
      caps: { tools: true, vision: false, reasoning: false },
    };
  return {
    id: p.id,
    label: p.label,
    kind: "api",
    blurb:
      p.kind === "gemini"
        ? "自訂 Gemini 相容服務"
        : p.kind === "anthropic"
          ? "自訂 Anthropic 相容服務"
          : "自訂 OpenAI 相容服務",
    family: p.kind === "gemini" ? "gemini" : p.kind === "anthropic" ? "anthropic" : "openai-chat",
    baseUrl: p.baseUrl,
    keyRequired: !LOCAL.test(p.baseUrl) && !PRIVATE.test(`${p.baseUrl}/`),
    liveModels: true,
    nativeApproval: "工具由 Alca 主機執行，每一步都經過閘門；付款、寄送、刪除、發布一律問你。",
    models,
    ...(p.model ? { defaultModel: p.model } : {}),
    caps: { tools: true, vision: false, reasoning: false },
  };
}

export interface ProviderServiceOptions {
  store: Store;
  vault: Vault;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  fetch?: typeof fetch;
  /** Provider ids to leave out (e.g. "claude-code" when it is the default engine). */
  hide?: readonly string[];
}

export interface Resolved {
  def: ProviderDef;
  settings: ProviderSettings;
  custom?: EngineProvider;
}

export class ProviderService {
  private readonly o: ProviderServiceOptions;
  private readonly detected = new Map<string, { at: number; d: Detection }>();
  private readonly modelCache = new Map<string, { at: number; list: ModelList }>();

  constructor(o: ProviderServiceOptions) {
    this.o = o;
  }

  /** A provider by id: built-in (with the person's settings) or custom. */
  resolve(id: string): Resolved | undefined {
    const def = providerDef(id);
    if (def) return { def, settings: this.o.store.team.providerSettings(id).settings };
    const p = this.o.store.team.provider(id);
    return p ? { def: customDef(p), settings: {}, custom: p } : undefined;
  }

  hasKey(id: string): boolean {
    const p = this.o.store.team.provider(id);
    return p ? p.hasKey : this.o.store.team.providerSettings(id).hasKey;
  }

  async apiKey(id: string): Promise<string | undefined> {
    return (await this.o.vault.get(vaultKeyFor(id)).catch(() => undefined)) ?? undefined;
  }

  private command(r: Resolved): string[] | undefined {
    if (r.custom) return r.custom.config.command;
    return r.settings.command?.length ? r.settings.command : undefined;
  }

  private async detect(r: Resolved, fresh: boolean): Promise<Detection> {
    const hit = this.detected.get(r.def.id);
    if (!fresh && hit && Date.now() - hit.at < DETECT_TTL_MS) return hit.d;
    const command = this.command(r);
    const keyEnv = r.custom?.config.keyEnv;
    const d = await detectProvider(
      r.def,
      {
        hasKey: (id) => this.hasKey(id),
        ...(this.o.env ? { env: this.o.env } : {}),
        ...(this.o.run ? { run: this.o.run } : {}),
      },
      { ...(command ? { command } : {}), ...(keyEnv ? { keyEnv } : {}) },
    );
    this.detected.set(r.def.id, { at: Date.now(), d });
    return d;
  }

  private async view(r: Resolved, fresh = false): Promise<ProviderView> {
    const d = await this.detect(r, fresh);
    const { def, settings } = r;
    const command =
      def.kind === "api" ? undefined : (this.command(r) ?? [def.binary ?? "", ...(def.acpArgs ?? [])]);
    const baseUrl = settings.baseUrl ?? def.baseUrl;
    const family = (settings.family as ApiFamily | undefined) ?? def.family;
    return {
      id: def.id,
      label: def.label,
      kind: def.kind,
      ...(family ? { family } : {}),
      pinned: !!def.pinned,
      custom: !!r.custom,
      blurb: def.blurb,
      status: d.status,
      hint: d.hint,
      ...(d.version ? { version: d.version } : {}),
      hasKey: this.hasKey(def.id),
      keyRequired: def.kind === "api" ? def.keyRequired !== false : !!r.custom?.config.keyEnv,
      ...(def.keyUrl ? { keyUrl: def.keyUrl } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(command ? { command } : {}),
      ...((settings.defaultModel ?? def.defaultModel)
        ? { defaultModel: settings.defaultModel ?? def.defaultModel }
        : {}),
      caps: def.caps,
      nativeApproval: def.nativeApproval,
      ...(def.id === "openai" ? { families: ["openai-responses", "openai-chat"] as ApiFamily[] } : {}),
    };
  }

  async list(o: { fresh?: boolean } = {}): Promise<ProviderView[]> {
    const hide = new Set(this.o.hide ?? []);
    const all: Resolved[] = [
      ...PROVIDERS.filter((p) => !hide.has(p.id)).map((def) => ({
        def,
        settings: this.o.store.team.providerSettings(def.id).settings,
      })),
      ...this.o.store.team.providers().map((p) => ({ def: customDef(p), settings: {}, custom: p })),
    ];
    return await Promise.all(all.map((r) => this.view(r, o.fresh)));
  }

  async one(id: string, fresh = false): Promise<ProviderView> {
    const r = this.resolve(id);
    if (!r) throw new ProviderError(404, tSource("core.providers.none"));
    return await this.view(r, fresh);
  }

  /** Save a key in the vault (never echoed back). */
  async setKey(id: string, key: unknown): Promise<ProviderView> {
    const r = this.resolve(id);
    if (!r) throw new ProviderError(404, tSource("core.providers.none"));
    const k = typeof key === "string" ? key.trim() : "";
    if (!k) throw bad(tSource("core.providers.needKey"));
    if (k.length > 500 || /\s/.test(k)) throw bad(tSource("core.providers.keyFormat"));
    // A key never goes over plain http to another machine (P13: keyless LAN services may use http).
    const url = r.custom?.baseUrl ?? r.settings.baseUrl ?? r.def.baseUrl ?? "";
    if (url.startsWith("http://") && !LOCAL.test(`${url}/`)) throw bad(tSource("core.providers.httpNoKey"));
    await this.o.vault.set(vaultKeyFor(id), k);
    if (r.custom) this.o.store.team.setProviderHasKey(id, true);
    else this.o.store.team.setProviderSettings(id, { hasKey: true });
    this.forget(id);
    return await this.view(r, true);
  }

  async clearKey(id: string): Promise<ProviderView> {
    const r = this.resolve(id);
    if (!r) throw new ProviderError(404, tSource("core.providers.none"));
    await this.o.vault.delete(vaultKeyFor(id)).catch(() => undefined);
    if (r.custom) this.o.store.team.setProviderHasKey(id, false);
    else this.o.store.team.setProviderSettings(id, { hasKey: false });
    this.forget(id);
    return await this.view(r, true);
  }

  /** Base URL / command / OpenAI wire / default model for a built-in provider. */
  async update(id: string, body: Record<string, unknown>): Promise<ProviderView> {
    const r = this.resolve(id);
    if (!r || r.custom) throw new ProviderError(404, tSource("core.providers.noBuiltin"));
    const next: ProviderSettings = { ...r.settings };
    if (body.baseUrl !== undefined) {
      if (r.def.kind !== "api") throw bad(tSource("core.providers.noUrl"));
      if (body.baseUrl === null || body.baseUrl === "") delete next.baseUrl;
      else next.baseUrl = checkBaseUrl(body.baseUrl, r.def.keyRequired !== false || this.hasKey(id));
    }
    if (body.command !== undefined) {
      if (r.def.kind === "api") throw bad(tSource("core.providers.noCommand"));
      if (body.command === null || body.command === "") delete next.command;
      else next.command = checkCommand(body.command);
    }
    if (body.family !== undefined) {
      if (id !== "openai" || (body.family !== "openai-responses" && body.family !== "openai-chat"))
        throw bad(tSource("core.providers.apiChoice"));
      next.family = body.family;
    }
    if (body.defaultModel !== undefined) {
      if (body.defaultModel === null || body.defaultModel === "") delete next.defaultModel;
      else next.defaultModel = checkModel(body.defaultModel);
    }
    this.o.store.team.setProviderSettings(id, { settings: next });
    this.forget(id);
    return await this.view({ ...r, settings: next }, true);
  }

  async models(id: string, refresh = false): Promise<ModelList> {
    const r = this.resolve(id);
    if (!r) throw new ProviderError(404, tSource("core.providers.none"));
    const hit = this.modelCache.get(id);
    if (!refresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
    const apiKey = r.def.kind === "api" ? await this.apiKey(id) : undefined;
    const command = this.command(r);
    const baseUrl = r.settings.baseUrl ?? r.def.baseUrl;
    const list = await listModels(r.def, {
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(command ? { command } : {}),
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
      ...(this.o.run ? { run: this.o.run } : {}),
    });
    // A note from the vendor never carries the key (it is not in the URL), but be sure.
    if (apiKey && list.note) list.note = list.note.split(apiKey).join("•••");
    this.modelCache.set(id, { at: Date.now(), list });
    return list;
  }

  /** 新增自訂供應商: an ACP agent (command) or an OpenAI-compatible / Anthropic-compatible API (base URL). */
  async addCustom(body: Record<string, unknown>): Promise<ProviderView> {
    const kind = body.kind;
    if (kind !== "acp" && kind !== "openai" && kind !== "anthropic" && kind !== "gemini")
      throw bad(tSource("core.providers.kind"));
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
    if (!label) throw bad(tSource("core.providers.needName"));
    const models = Array.isArray(body.models)
      ? body.models.map((m) => checkModel(m)).slice(0, 100)
      : typeof body.models === "string"
        ? body.models
            .split(/[\n,]/)
            .map((m) => m.trim())
            .filter(Boolean)
            .map(checkModel)
            .slice(0, 100)
        : [];
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (key && (key.length > 500 || /\s/.test(key))) throw bad(tSource("core.providers.keyFormat"));
    let p: EngineProvider;
    if (kind === "acp") {
      const command = checkCommand(body.command);
      const keyEnv = typeof body.keyEnv === "string" && body.keyEnv.trim() ? body.keyEnv.trim() : undefined;
      if (keyEnv && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(keyEnv)) throw bad(tSource("core.providers.envName"));
      if (key && !keyEnv) throw bad(tSource("core.providers.envNeeded"));
      p = this.o.store.team.addProvider({
        kind: "acp",
        label,
        baseUrl: "",
        model: models[0] ?? "",
        hasKey: !!key,
        config: { command, ...(keyEnv ? { keyEnv } : {}), ...(models.length ? { models } : {}) },
      });
    } else {
      const baseUrl = checkBaseUrl(body.baseUrl, !!key);
      if (!models.length) throw bad(tSource("core.providers.needModel"));
      p = this.o.store.team.addProvider({
        kind,
        label,
        baseUrl,
        model: models[0] as string,
        hasKey: !!key,
        config: { models },
      });
    }
    if (key) await this.o.vault.set(vaultKeyFor(p.id), key);
    return await this.view({ def: customDef(p), settings: {}, custom: p }, true);
  }

  async removeCustom(id: string): Promise<boolean> {
    if (!this.o.store.team.provider(id)) throw new ProviderError(404, tSource("core.providers.noCustom"));
    const ok = this.o.store.team.removeProvider(id);
    await this.o.vault.delete(vaultKeyFor(id)).catch(() => undefined);
    for (const b of this.o.store.bots.all())
      if (b.engineId === id) this.o.store.bots.update(b.id, { engineId: null, model: null });
    this.forget(id);
    return ok;
  }

  private forget(id: string): void {
    this.detected.delete(id);
    this.modelCache.delete(id);
  }
}

/**
 * A provider's base URL. https anywhere; plain http to this computer; and
 * plain http to a private address (LAN 10/8, 172.16/12, 192.168/16, Tailscale
 * 100.64/10, *.local) only for a keyless service such as Ollama or LM Studio
 * on another machine at home: a key never travels unencrypted.
 */
export function checkBaseUrl(v: unknown, withKey = true): string {
  const s = typeof v === "string" ? v.trim().replace(/\/+$/, "") : "";
  if (!/^https?:\/\/[^\s/]+/.test(s) || s.length > 500) throw bad(tSource("core.providers.urlScheme"));
  if (s.startsWith("http://") && !LOCAL.test(`${s}/`)) {
    if (withKey || !PRIVATE.test(`${s}/`)) throw bad(tSource("core.providers.keyInsecure"));
  }
  return s;
}

/** Private-network hosts (RFC 1918, CGNAT / Tailscale 100.64/10, mDNS *.local). */
export const PRIVATE =
  /^http:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|[a-z0-9-]+\.local)[:/]/i;

/** A command line: an array, or a string split on spaces (no shell; quotes are not interpreted). */
export function checkCommand(v: unknown): string[] {
  const parts = Array.isArray(v)
    ? v.map((x) => String(x))
    : typeof v === "string"
      ? v.trim().split(/\s+/).filter(Boolean)
      : [];
  if (!parts.length || !parts[0]) throw bad(tSource("core.providers.needCommand"));
  if (parts.length > 32 || parts.some((p) => p.length > 300 || /[\n\0]/.test(p)))
    throw bad(tSource("core.providers.commandBad"));
  return parts;
}

function checkModel(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > 200 || /\s/.test(s)) throw bad(tSource("core.providers.modelId"));
  return s;
}
