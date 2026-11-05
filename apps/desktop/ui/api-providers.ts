// 模型與供應商 (P11) over the loopback API. A key goes in once and never comes
// back: views only say `hasKey`.
import type { Api } from "./api.ts";
import { t } from "./i18n/index.ts";

export type ProviderStatus = "ready" | "needs_login" | "needs_key" | "not_installed";
export type ApiFamily = "openai-chat" | "openai-responses" | "anthropic" | "gemini";

export interface ProviderView {
  id: string;
  label: string;
  kind: "cli" | "acp" | "api";
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
  caps: { tools: boolean; vision: boolean; reasoning: boolean };
  nativeApproval: string;
  families?: ApiFamily[];
}

export interface ModelInfo {
  id: string;
  label?: string;
  contextTokens?: number;
  inputPrice?: number;
  outputPrice?: number;
}

export interface ModelList {
  source: "api" | "cli" | "builtin";
  models: ModelInfo[];
  note?: string;
}

export interface CustomInput {
  kind: "acp" | "openai" | "anthropic";
  label: string;
  command?: string;
  baseUrl?: string;
  key?: string;
  keyEnv?: string;
  models?: string;
}

export const STATUS_WORD: Record<ProviderStatus, string> = {
  ready: t("desktop.apiProviders.available"),
  needs_login: t("desktop.apiProviders.signInNeeded"),
  needs_key: t("desktop.apiProviders.keyNeeded"),
  not_installed: t("desktop.apiProviders.notInstalled"),
};

export const KIND_WORD: Record<ProviderView["kind"], string> = { cli: "CLI", acp: "ACP", api: "API" };

export interface ProvidersClient {
  list(fresh?: boolean): Promise<ProviderView[]>;
  setKey(id: string, key: string): Promise<ProviderView>;
  clearKey(id: string): Promise<ProviderView>;
  update(
    id: string,
    patch: {
      baseUrl?: string | null;
      command?: string | null;
      family?: ApiFamily;
      defaultModel?: string | null;
    },
  ): Promise<ProviderView>;
  models(id: string, refresh?: boolean): Promise<ModelList>;
  addCustom(input: CustomInput): Promise<ProviderView>;
  remove(id: string): Promise<{ removed: boolean }>;
}

export function providersApi(api: Api): ProvidersClient {
  const enc = encodeURIComponent;
  return {
    list: async (fresh) =>
      (await api.call<{ providers: ProviderView[] }>("GET", `/api/providers${fresh ? "?fresh=1" : ""}`))
        .providers,
    setKey: (id, key) => api.call("PUT", `/api/providers/${enc(id)}/key`, { key }),
    clearKey: (id) => api.call("DELETE", `/api/providers/${enc(id)}/key`),
    update: (id, patch) => api.call("PATCH", `/api/providers/${enc(id)}`, patch),
    models: (id, refresh) =>
      api.call("GET", `/api/providers/${enc(id)}/models${refresh ? "?refresh=1" : ""}`),
    addCustom: (input) => api.call("POST", "/api/providers", input),
    remove: (id) => api.call("DELETE", `/api/providers/${enc(id)}`),
  };
}

/** "128K" / "1M" context. */
export function contextWord(n: number | undefined): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  return `${Math.round(n / 1000)}K`;
}

/** "$0.5 / $1.5" per million tokens. */
export function priceWord(m: ModelInfo): string {
  if (m.inputPrice === undefined && m.outputPrice === undefined) return "";
  const f = (v: number | undefined) =>
    v === undefined
      ? "?"
      : v === 0
        ? t("desktop.apiProviders.free")
        : `$${Number(v.toFixed(v < 1 ? 3 : 2)).toString()}`;
  if (m.inputPrice === 0 && m.outputPrice === 0) return t("desktop.apiProviders.free");
  return `${f(m.inputPrice)} / ${f(m.outputPrice)}`;
}
