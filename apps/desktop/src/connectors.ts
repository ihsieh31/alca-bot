import type { Settings } from "@alca/config";
import {
  AppEventSource,
  appInfo,
  ConnectorService,
  connectorTools,
  HookPuller,
  McpProvider,
  pick,
  pollArguments,
  type SpawnFn,
  type Vault,
} from "@alca/connectors";
import {
  type AgentSystem,
  type AlcaCore,
  AppSource,
  type HostTool,
  ReadCheck,
  type RoutineItem,
} from "@alca/core";
import type { Store, TriggerSource } from "@alca/store";
import { appReader } from "./proactive-reader.ts";

/**
 * Desktop wiring for connected apps and routines (P6): the vault in the data
 * directory, the Composio service, the model's connector tools, the `app`
 * routine check (a read tool polled by plain code), and, when a relay is
 * configured, the webhook mailbox the core pulls app triggers from.
 */

export interface ConnectorSetup {
  vault: Vault;
  service: ConnectorService;
  /** Next round R8: the person's own MCP servers. */
  mcp: McpProvider;
  tools: HostTool[];
  /** Routine check `app`: poll a connected app's read tool. */
  appCheck: ReadCheck;
  /** P14: 主動留意's calendar and mail sources (read tools only; mail as subject, sender, date, preview). */
  proactiveSources: AppSource[];
  /** Trigger sources for app events (email, im, github, webhook). */
  sources: AppEventSource[];
  puller: () => HookPuller | undefined;
  /** Bind to the running core / agents (after they exist). */
  bind(core: AlcaCore, agents: AgentSystem | undefined): void;
  close(): Promise<void>;
}

/** Where the removed Google-direct connection (next round R8) kept each account's refresh token. */
export const GOOGLE_DIRECT_SECRET_PREFIX = "integration.google.";

/**
 * Google direct was removed on 2026-11-05 (Gmail / Calendar go through
 * Composio only). Migration 27 marks those accounts removed; their refresh
 * tokens live in the vault, not the database, so they are deleted here at
 * start. Nothing is sent to Google (the token is not revoked there; the
 * person can do that at myaccount.google.com/permissions). A vault that
 * cannot be read is left alone: this never stops the core from starting.
 */
export async function dropGoogleDirectTokens(vault: Pick<Vault, "names" | "deleteMany">): Promise<string[]> {
  try {
    const stale = (await vault.names()).filter((n) => n.startsWith(GOOGLE_DIRECT_SECRET_PREFIX));
    if (stale.length) await vault.deleteMany(stale);
    return stale;
  } catch {
    return [];
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export async function createConnectors(o: {
  /** The data folder's one vault, made by openDataDir (Phase D1); never a second instance here. */
  vault: Vault;
  store: Store;
  settings: () => Settings;
  composioBaseUrl?: string;
  relayUrl?: string;
  /** Tests: MCP servers' HTTP, and how a stdio MCP server starts. */
  fetch?: typeof fetch;
  spawn?: SpawnFn;
}): Promise<ConnectorSetup> {
  const vault = o.vault;
  const settings = o.composioBaseUrl
    ? () => {
        const s = o.settings();
        return {
          ...s,
          engineering: {
            ...s.engineering,
            connectors: { ...s.engineering.connectors, composioBaseUrl: o.composioBaseUrl as string },
          },
        };
      }
    : o.settings;
  const mcp = new McpProvider({
    store: o.store,
    secrets: vault,
    ...(o.spawn ? { spawn: o.spawn } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const service = new ConnectorService({ store: o.store, vault, settings, providers: [mcp] });
  await dropGoogleDirectTokens(vault);
  let puller: HookPuller | undefined;
  let fire: ((triggerId: string, ev: import("@alca/core").TriggerEventInput) => Promise<unknown>) | undefined;
  if (o.relayUrl)
    puller = new HookPuller({
      store: o.store,
      vault,
      service,
      relayUrl: o.relayUrl,
      fire: async (id, ev) => fire?.(id, ev),
    });
  const every = settings().engineering.connectors.relayPollSec;
  const kinds: TriggerSource[] = ["webhook", "email", "im", "github"];
  // Only one source pulls (the others exist so the hub accepts their kind).
  const sources = kinds.map((k, i) => new AppEventSource(k, i === 0 ? () => puller : undefined, every));
  const appCheck = new ReadCheck(
    "app",
    async (spec, ctx): Promise<RoutineItem[]> => {
      const app = str(spec.app);
      const poll = appInfo(app).poll;
      const tool = str(spec.tool) || poll?.tool;
      if (!tool) throw new Error(`${appInfo(app).name} 沒有可以輪詢的讀取工具`);
      const data = await service.readRaw({
        botId: ctx.routine.botId,
        slug: tool,
        account: spec.account,
        // Calendar polls get the upcoming window (gap P1); the routine's own arguments win.
        arguments:
          tool === poll?.tool
            ? pollArguments(app, ctx.now, spec.arguments as Record<string, unknown> | undefined)
            : ((spec.arguments as Record<string, unknown> | undefined) ?? {}),
      });
      const list = pick(data, str(spec.itemsPath) || poll?.itemsPath || "items");
      if (!Array.isArray(list)) throw new Error("讀到的資料裡沒有清單（格式和預期不同）");
      const idF = str(spec.idField) || poll?.idField || "id";
      const titleF = str(spec.titleField) || poll?.titleField || "title";
      const fromF = str(spec.fromField) || poll?.fromField || "";
      const textF = str(spec.textField) || poll?.textField || "";
      return list
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          id: str(pick(x, idF)),
          title: str(pick(x, titleF)),
          ...(fromF && str(pick(x, fromF)) ? { from: str(pick(x, fromF)) } : {}),
          ...(textF && str(pick(x, textF)) ? { text: str(pick(x, textF)) } : {}),
        }))
        .filter((i) => i.id);
    },
    (spec) => {
      const app = appInfo(str(spec.app));
      return `${app.name}${spec.account ? `「${str(spec.account)}」` : ""}有沒有新的`;
    },
  );
  const proactiveSources = [
    new AppSource("calendar", appReader(service, "googlecalendar")),
    new AppSource("mail", appReader(service, "gmail")),
  ];
  return {
    vault,
    service,
    mcp,
    tools: connectorTools(service, o.store),
    appCheck,
    proactiveSources,
    sources,
    puller: () => puller,
    bind(core, agents) {
      if (agents) fire = (id, ev) => agents.triggers.fire(id, ev);
      void core;
    },
    close: () => mcp.close(),
  };
}
