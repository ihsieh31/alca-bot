// Connected apps + routines (P6) over the loopback API. The Composio key goes
// in once (PUT) and never comes back: status says only whether it is set.
import type { Api } from "./api.ts";
import { t } from "./i18n/index.ts";
import type { LoginBody, SiteLoginView } from "./site-logins-model.ts";

export type Access = "read" | "act" | null;

export interface AccountView {
  id: string;
  /** Next round R8: composio or mcp (one of the person's servers). */
  provider?: "composio" | "mcp";
  toolkit: string;
  app: string;
  mark: string;
  label: string;
  status: "pending" | "active" | "failed" | "expired" | "removed";
  identity: string;
  bots: Array<{ botId: string; name: string; access: Access }>;
  triggers: Array<{ id: string; slug: string; name: string; status: string }>;
  createdAt: string;
}

export interface AppCard {
  toolkit: string;
  name: string;
  mark: string;
  blurb: string;
  triggers: Array<{ slug: string; name: string }>;
}

export interface ConnectorsStatus {
  keySet: boolean;
  keyPreview: string | null;
  keyStore: string;
  apps: AppCard[];
  groups: Array<{ toolkit: string; app: string; mark: string; accounts: AccountView[] }>;
  bots: Array<{ id: string; name: string }>;
  usageToday: Record<string, number>;
  quota: Record<string, number>;
  relay: { hookUrl: string; lastPullAt: string | null; lastError: string | null } | null;
  routinesOn: boolean;
  error?: string;
  /** Next round R8: the person's MCP servers. */
  integrations?: {
    mcp: { servers: McpServerView[] };
  };
}

export interface McpServerView {
  id: string;
  label: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  /** Names only: the values stay in the vault. */
  secretNames: string[];
  enabled: boolean;
  accountId: string | null;
}

export interface McpServerInput {
  label: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  /** name → value; an empty value removes that secret. */
  secrets?: Record<string, string>;
  enabled?: boolean;
}

export interface RoutineRun {
  id: string;
  outcome: "quiet" | "new" | "read_failed" | "capped" | "ai_done" | "ai_invalid" | "ai_failed";
  items: number;
  detail: string;
  at: string;
  workerId: string | null;
}

export interface RoutineView {
  id: string;
  botId: string;
  threadId: string;
  threadTitle: string;
  name: string;
  kind: "interval" | "cron" | "once" | "trigger";
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
  runs: RoutineRun[];
}

export interface DraftView {
  id: string;
  threadId: string;
  title: string;
  kind: "reply" | "message" | "note";
  body: string;
  target: { to?: string; subject?: string; app?: string };
  createdAt: string;
}

/** 提前做 (P13): something a bot prepares ahead; finished work only ever becomes drafts. */
export interface EarlyView {
  id: string;
  botId: string;
  threadId: string;
  source: "trigger" | "request";
  title: string;
  status: "queued" | "running" | "ready" | "skipped" | "failed";
  notBefore: string | null;
  draftIds: string[];
  detail: string;
  updatedAt: string;
}

export interface RoutineList {
  routines: RoutineView[];
  drafts: DraftView[];
  /** 提前做 items (empty when the desktop has no 總機模式). */
  early?: EarlyView[];
  apps: Array<{ toolkit: string; name: string }>;
}

export interface NewRoutine {
  name: string;
  kind: "interval" | "cron" | "once";
  intervalSec?: number;
  cron?: string;
  tz?: string;
  runAt?: string;
  check: { kind: "app"; app: string; account?: string };
  instructions?: string;
  speculative?: boolean;
  threadId?: string;
}

export function connectApi(api: Api) {
  return {
    status: (refresh = true) =>
      api.call<ConnectorsStatus>("GET", `/api/connectors${refresh ? "" : "?refresh=0"}`),
    setKey: (key: string) => api.call<ConnectorsStatus>("PUT", "/api/connectors/key", { key }),
    clearKey: () => api.call<ConnectorsStatus>("DELETE", "/api/connectors/key"),
    refresh: () => api.call<ConnectorsStatus>("POST", "/api/connectors/refresh"),
    connect: (toolkit: string, label: string) =>
      api.call<{ account: AccountView; redirectUrl: string }>("POST", "/api/connectors/accounts", {
        toolkit,
        label,
      }),
    rename: (id: string, label: string) => api.call("PATCH", `/api/connectors/accounts/${id}`, { label }),
    disconnect: (id: string) => api.call("DELETE", `/api/connectors/accounts/${id}`),
    grant: (id: string, botId: string, access: Access) =>
      api.call("PUT", `/api/connectors/accounts/${id}/bots/${botId}`, { access }),
    trigger: (
      id: string,
      slug: string,
      routine?: { name: string; instructions?: string; speculative?: boolean },
    ) =>
      api.call("POST", `/api/connectors/accounts/${id}/triggers`, { slug, ...(routine ? { routine } : {}) }),
    routines: async () => {
      const [list, early] = await Promise.all([
        api.call<RoutineList>("GET", "/api/routines"),
        api.call<EarlyView[]>("GET", "/api/early").catch(() => [] as EarlyView[]),
      ]);
      return { ...list, early: Array.isArray(early) ? early : [] };
    },
    createRoutine: (r: NewRoutine) => api.call<RoutineView>("POST", "/api/routines", r),
    setRoutine: (id: string, enabled: boolean) =>
      api.call<RoutineView>("POST", `/api/routines/${id}/${enabled ? "enable" : "disable"}`),
    runRoutine: (id: string) => api.call<RoutineView>("POST", `/api/routines/${id}/run`),
    removeRoutine: (id: string) => api.call("DELETE", `/api/routines/${id}`),
    // Next round R8
    saveServer: (id: string, input: McpServerInput) =>
      api.call<{ server: McpServerView; check: { ok: boolean; tools: number; error?: string } }>(
        "PUT",
        `/api/connectors/mcp/${encodeURIComponent(id)}`,
        input,
      ),
    checkServer: (id: string) =>
      api.call<{ ok: boolean; tools: number; error?: string }>(
        "POST",
        `/api/connectors/mcp/${encodeURIComponent(id)}/check`,
      ),
    removeServer: (id: string) => api.call("DELETE", `/api/connectors/mcp/${encodeURIComponent(id)}`),
    useDraft: (id: string) => api.call<{ threadId: string; text: string }>("POST", `/api/drafts/${id}/use`),
    discardDraft: (id: string) => api.call("POST", `/api/drafts/${id}/discard`),
    // Design §0.2.7: website logins; the list never carries a password.
    logins: () => api.call<SiteLoginView[]>("GET", "/api/connectors/logins"),
    saveLogin: (body: LoginBody) => api.call<SiteLoginView[]>("POST", "/api/connectors/logins", body),
    removeLogin: (id: string) =>
      api.call<SiteLoginView[]>("DELETE", `/api/connectors/logins/${encodeURIComponent(id)}`),
  };
}

export type ConnectApi = ReturnType<typeof connectApi>;

export const CLASS_WORD: Record<string, string> = {
  send: t("common.send"),
  publish: t("common.publish2"),
  delete: t("common.delete"),
  payment: t("common.pay"),
  write: t("common.write"),
};

export const KEY_STORE: Record<string, string> = {
  "keychain-macos": t("desktop.apiConnect.macosKeychain"),
  "secret-service": t("desktop.apiConnect.systemKeychain"),
  file: t("desktop.apiConnect.localEncryptedFile"),
};
