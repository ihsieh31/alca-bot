import type { TelegramService } from "@alca/channel-telegram";
import type { Settings } from "@alca/config";
import type { AgentSystem, AlcaCore, Learning } from "@alca/core";
import type { BrowserSetup } from "./browser.ts";
import type { ConnectorsApi } from "./connectors-api.ts";
import type { SealApi } from "./data-seal.ts";
import type { LinkSetup } from "./link.ts";
import type { MemoryApi } from "./memory-api.ts";
import type { SettingsApi } from "./settings-api.ts";
import type { SystemApi } from "./settings-system.ts";
import type { TeamApi } from "./team-api.ts";
import type { UiSessions } from "./ui-session.ts";
import type { WebSearchApi } from "./web-search.ts";
import type { WorkspaceApi } from "./workspace.ts";

/**
 * Everything a desktop request can reach (P13), assembled once by
 * `startDesktop` and handed to the route table. The core, the token and the
 * settings are always there; a feature service is absent only when that
 * feature is off in this process (no browser, direct mode without the
 * router, no Link without a relay), and its routes then answer 404.
 */
export interface AppContext {
  core: AlcaCore;
  /** The local API token (every `/api` call needs it). */
  token: string;
  /**
   * Review 2026-11-04b S2.2: the in-memory approve key and launch codes.
   * Approving, pairing and widening a device's scopes need it as well as the token.
   */
  ui: UiSessions;
  /** Open a URL in the person's browser (default: the OS opener; tests record it). */
  openWindow?: (url: string) => boolean;
  /** The live settings (the 設定 screen changes them while running). */
  settings: () => Settings;
  /** Secrets for the startup safety check (defaults to just the token). */
  secrets?: Record<string, string>;
  /** Override the settings' bindHost (still must be loopback). */
  host?: string;
  /** 0 = pick a free port (tests). Defaults to settings.engineering.port. */
  port?: number;
  info?: Record<string, unknown>;
  browser?: BrowserSetup | undefined;
  /** Router mode (P3): workers, triggers, the agents channel. */
  agents?: AgentSystem | undefined;
  /** Alca Link (P4): pairing, devices, hands. */
  link?: LinkSetup | undefined;
  /** Memory + learning (P5). */
  learning?: Learning | undefined;
  memory?: MemoryApi | undefined;
  /** Connected apps + routines (P6). */
  connectors?: ConnectorsApi | undefined;
  /** The team: bots, the lead, rules, bot-to-bot, providers (P7, P11). */
  team?: TeamApi | undefined;
  /** Telegram as a reply channel (P13); approvals stay on paired devices. */
  telegram?: TelegramService | undefined;
  /** P13: undo of file edits, 提前做. */
  workspace?: WorkspaceApi | undefined;
  /** P13: the 設定 screen (writes config.json). */
  settingsApi?: SettingsApi | undefined;
  /** Next round R1: 設定 → 網路搜尋 (web_search provider and key). */
  webSearch?: WebSearchApi | undefined;
  /** P13: 設定 → 備份 / 關於. */
  system?: SystemApi | undefined;
  /** R7 (Phase F2): 設定 → 資料 → 加密 (status, the old plaintext backups). */
  seal?: SealApi | undefined;
}
