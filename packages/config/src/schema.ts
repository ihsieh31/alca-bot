import { z } from "zod";

/**
 * Action classes the HOST always confirms with the user, whatever the
 * permission level. Not part of the settings schema on purpose: there is
 * no key a user, a config file, or an agent could set to turn these off.
 */
export const ALWAYS_CONFIRM_ACTIONS = Object.freeze(["payment", "send", "delete", "publish"] as const);
export type AlwaysConfirmAction = (typeof ALWAYS_CONFIRM_ACTIONS)[number];

/** The levels a team (settings, 權限 page) may run at. */
export const PermissionLevel = z.enum(["autonomous", "confirm_each_step"]);
/**
 * Every level a call may run under. `full_access` (Phase 5, 完全授權) sits above
 * `autonomous` and exists only as a bot's own setting, turned on by the person
 * in the bot editor: never a team level, never raised by a model. Payment and
 * outward sends still ask under it (policy `decide`).
 */
export const RunLevel = z.enum(["full_access", "autonomous", "confirm_each_step"]);
export type PermissionLevelT = z.infer<typeof RunLevel>;
export type TeamLevelT = z.infer<typeof PermissionLevel>;

export const DeviceScope = z.enum(["chat", "approve", "view_screen", "control_computer"]);
export type DeviceScopeT = z.infer<typeof DeviceScope>;

// ── Page 1: 模型 ────────────────────────────────────────────────
// (P13 B1: `defaultEngine` and `suggestFallbackOnQuota` were never read and
// are gone; each bot picks its engine in the team. Old files: see REMOVED_KEYS.)
export const ModelsPage = z.strictObject({
  engines: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        kind: z.enum(["cli", "acp", "api"]),
        enabled: z.boolean().default(true),
        model: z.string().min(1).optional(),
      }),
    )
    .default([{ id: "claude-code", kind: "cli", enabled: true }]),
});

// ── Page 2: 連接 ────────────────────────────────────────────────
// Connected-app accounts, their labels and which bot may use them live in the
// store (P6), edited on 連接; the old `accounts` list here was never read (P13 B1).
export const ConnectionsPage = z.strictObject({});

// ── Page 3: 權限 ────────────────────────────────────────────────
// Strict: unknown keys such as `alwaysConfirm` or `payment` are rejected.
export const PermissionsPage = z.strictObject({
  level: PermissionLevel.default("confirm_each_step"),
});

// ── Page 4: 裝置 ────────────────────────────────────────────────
export const DevicesPage = z.strictObject({
  allowPairing: z.boolean().default(true),
  /** Scopes a newly paired phone starts with. Remote control is never a default. */
  defaultScopes: z
    .array(DeviceScope)
    .default(["chat", "approve"])
    .refine((s) => !s.includes("control_computer"), {
      message: "control_computer must be granted per device, not by default",
    }),
  /**
   * Push payloads never carry content. `notify_only`: a content-free ping when
   * something waits for the person and the app is not open; `none`: no Web
   * Push at all (an open app still shows it).
   */
  pushPreview: z.enum(["none", "notify_only"]).default("notify_only"),
});

// ── Page 5: 進階（預設收起）─────────────────────────────────────
export const AdvancedPage = z.strictObject({
  /** The single learning switch: memory curation, skill review, step notes. */
  learning: z.boolean().default(true),
  /** Self-hosted rendezvous server; unset = the default one. */
  rendezvousUrl: z.url({ protocol: /^https$/ }).optional(),
  /** The core's own log lines (stdout, or <data>/logs/core.log as a service). */
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  /** First-run Chromium download when none is found (P13 設定 → 瀏覽器); `--no-browser-download` overrides. */
  browserAutoDownload: z.boolean().default(true),
  /**
   * R9.3: the interface language of the desktop window and the shell's tray.
   * `auto` follows the system language (zh* → 繁中, anything else → English).
   * Not the bots' language: a bot replies in the language of the message.
   */
  locale: z.enum(["auto", "zh-Hant-TW", "en"]).default("auto"),
});

// ── Engineering params: config.json only, never rendered in the UI ──
export const EngineeringParams = z.strictObject({
  bindHost: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(4317),
  turnTimeoutSec: z.number().int().positive().default(600),
  maxConcurrentRuns: z.number().int().positive().max(64).default(8),
  pairingCodeTtlSec: z.number().int().min(30).max(600).default(120),
  /** Connections a pairing code allows that dropped before any PAKE (G1: a wrong code burns it at once). */
  pairingMaxAttempts: z.number().int().min(1).max(10).default(5),
  loopGuard: z
    .strictObject({
      warnAfterRepeats: z.number().int().positive().default(3),
      hardStopAfterRepeats: z.number().int().positive().default(6),
    })
    .prefault({})
    .refine((g) => g.hardStopAfterRepeats > g.warnAfterRepeats, {
      message: "hardStopAfterRepeats must exceed warnAfterRepeats",
    }),
  /** Router / worker split (P3): budgets, inline-vs-spill size, watchdog thresholds. */
  workers: z
    .strictObject({
      /** Workers of one bot running at once; the rest wait in the queue. */
      maxConcurrent: z.number().int().min(1).max(32).default(4),
      /** Results up to this many characters go into the router's context whole; longer ones are spilled. */
      inlineChars: z.number().int().min(200).max(20_000).default(1200),
      /** Summary length kept in the router's context for a spilled result. */
      summaryChars: z.number().int().min(80).max(2000).default(280),
      /** Default budget per worker: engine passes, running seconds (waiting for a person not counted), tokens. */
      maxSteps: z.number().int().min(1).max(500).default(40),
      maxRunSec: z.number().int().min(5).max(86_400).default(900),
      maxTokens: z.number().int().min(1000).default(400_000),
      /** Watchdog: how often it looks, and when a running worker with no activity counts as stuck. */
      watchdogSec: z.number().int().min(1).max(3600).default(10),
      stuckSec: z.number().int().min(5).max(86_400).default(180),
      /** Watchdog: the same call this many times within the last `loopWindow` calls = looping. */
      loopWindow: z.number().int().min(3).max(200).default(12),
      loopRepeats: z.number().int().min(2).max(200).default(6),
    })
    .prefault({})
    .refine((w) => w.loopRepeats <= w.loopWindow, { message: "loopRepeats must not exceed loopWindow" })
    .refine((w) => w.summaryChars < w.inlineChars, { message: "summaryChars must be below inlineChars" }),
  /** Memory + learning (P5): how much recalled memory a router turn gets, and when a task becomes a skill proposal. */
  memory: z
    .strictObject({
      /** Token budget for recalled memory in one router turn. */
      recallTokens: z.number().int().min(0).max(8000).default(400),
      /** At most this many matching skills are named in a router turn. */
      skillHints: z.number().int().min(0).max(10).default(3),
      /** A finished task needs at least this many successful tool calls to be proposed as a skill. */
      skillMinSteps: z.number().int().min(1).max(50).default(2),
    })
    .prefault({}),
  /** Connected apps (P6): the provider's API, daily limits per action class, result size. */
  connectors: z
    .strictObject({
      composioBaseUrl: z.url({ protocol: /^https?$/ }).default("https://backend.composio.dev/api/v3.1"),
      /** Per bot per day, through connected apps. 0 = never through a connected app. Each one still asks first. */
      dailyQuota: z
        .strictObject({
          send: z.number().int().min(0).max(1000).default(30),
          publish: z.number().int().min(0).max(1000).default(10),
          delete: z.number().int().min(0).max(1000).default(10),
          payment: z.number().int().min(0).max(100).default(0),
          write: z.number().int().min(0).max(5000).default(200),
        })
        .prefault({}),
      /** A tool result is cut to this many characters before the model sees it. */
      resultChars: z.number().int().min(500).max(50_000).default(6000),
      /** How often the core pulls webhook deliveries from the relay (seconds). */
      relayPollSec: z.number().int().min(2).max(3600).default(20),
    })
    .prefault({}),
  /**
   * Next round R1: `web_search` for general workers. With `provider` null
   * (the default) the tool is not offered and searching goes through Alca
   * Browser. Brave / Tavily keys live in the SecretStore
   * (`search.brave.apiKey`, `search.tavily.apiKey`); a self-hosted SearXNG
   * is `searxngUrl` (may be on this computer or the LAN: it is the one
   * endpoint the SSRF rules let through, origin for origin) with an
   * optional bearer token `search.searxng.token`. Set in 設定 › 網路搜尋.
   */
  webSearch: z
    .strictObject({
      provider: z.enum(["brave", "tavily", "searxng"]).nullable().default(null),
      searxngUrl: z
        .url({ protocol: /^https?$/ })
        .nullable()
        .default(null),
      count: z.number().int().min(1).max(10).default(5),
    })
    .prefault({})
    .refine((w) => w.provider !== "searxng" || !!w.searxngUrl, {
      message: "webSearch.provider searxng needs searxngUrl",
    }),
  /**
   * 用 Google 帳號啟用遠端 (P10): the computer signs in with Google through
   * the installed-app flow (loopback redirect + PKCE, RFC 8252 / 7636).
   * `clientId` is the Desktop OAuth client; Google also issues a
   * `clientSecret` for Desktop clients, which its installed-app guide says is
   * not treated as a secret (it ships inside the app), so it is kept here.
   */
  google: z
    .strictObject({
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      authEndpoint: z.url({ protocol: /^https?$/ }).default("https://accounts.google.com/o/oauth2/v2/auth"),
      tokenEndpoint: z.url({ protocol: /^https?$/ }).default("https://oauth2.googleapis.com/token"),
    })
    .prefault({}),
  /**
   * Web push (P8): the VAPID contact (`mailto:` or `https:`) push services
   * see in the JWT. Set it to your own; $ALCA_PUSH_CONTACT overrides it.
   */
  push: z
    .strictObject({
      contact: z
        .string()
        .regex(/^(mailto:|https:)/)
        .default("mailto:admin@example.com"),
    })
    .prefault({}),
  /**
   * Next round §4: how long the append-only event tables keep rows (the
   * agents sweep deletes the rest hourly) and how many daily backups are
   * kept. The audit log is kept forever and has no setting; messages stay
   * until the conversation is deleted.
   */
  retention: z
    .strictObject({
      /** Events of finished runs (replay, resync, history search). */
      runEventsDays: z.number().int().min(7).max(3650).default(90),
      /** Events of finished jobs (tool calls and their results). */
      jobEventsDays: z.number().int().min(7).max(3650).default(90),
      /** Outside content and side logs: trigger events, spills, watchdog, peer events, routine runs. */
      externalDays: z.number().int().min(7).max(3650).default(90),
      /** Daily backups kept (0 = no daily backup). Migration and manual backups keep their own five. */
      dailyBackups: z.number().int().min(0).max(60).default(7),
      /** R5.4: 刪除對話時「也從備份裡清除」的預設（使用者定案：預設勾）。 */
      scrubBackupsOnDelete: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * R2.2: store measurements. Only log lines and the 設定 → 資料 diagnostics
   * read these; nothing changes behaviour.
   */
  perf: z
    .strictObject({
      /** A single SQL call at least this slow goes into the slow-query ring buffer. */
      slowSqlMs: z.number().int().min(1).max(60_000).default(50),
      /** A single SQL call at least this slow is a warning. */
      warnSqlMs: z.number().int().min(1).max(60_000).default(200),
      /** Hourly event-loop delay p99 at or above this is a warning. */
      loopP99Ms: z.number().int().min(1).max(60_000).default(100),
      /** Hourly event-loop delay max at or above this is a warning. */
      loopMaxMs: z.number().int().min(1).max(600_000).default(1000),
      /** Target time of one database-worker batch (prune, vacuum); batch sizes adapt to it. */
      workerBatchMs: z.number().int().min(5).max(1000).default(25),
    })
    .prefault({}),
  /**
   * Phase E: look for a newer release once a day (one GET to GitHub, nothing about you is
   * sent) and only tell — 設定 → 關於 and the log. Installing is always `alca update install`
   * on the terminal, after a yes. "off" = no request at all.
   */
  updates: z
    .strictObject({
      check: z.enum(["notify", "off"]).default("notify"),
      /** "prerelease" also offers pre-releases (never drafts). */
      channel: z.enum(["stable", "prerelease"]).default("stable"),
    })
    .prefault({}),
  /** P13: undo for files bots edit — how much is kept. */
  undo: z
    .strictObject({
      /** Per conversation, the newest turns whose edits can be undone. */
      keepTurns: z.number().int().min(1).max(500).default(20),
      /** A file larger than this is not kept (its edit cannot be undone; the turn says so). */
      maxFileBytes: z.number().int().min(1024).max(100_000_000).default(2_000_000),
      /** All kept file contents together; the oldest turns are dropped first. */
      maxTotalBytes: z.number().int().min(1_000_000).max(10_000_000_000).default(200_000_000),
    })
    .prefault({}),
  /** P13: 提前做 — work a bot prepares in the background from trigger events. */
  earlyWork: z
    .strictObject({
      /** Early-work workers one bot may start in 24 hours. */
      maxPerDay: z.number().int().min(0).max(200).default(6),
      /** Early-work workers of one bot running at once. */
      maxConcurrent: z.number().int().min(1).max(8).default(1),
    })
    .prefault({}),
  /** P13: the optional small-model review of shell commands under 自主 (switched on per bot). */
  shellReview: z
    .strictObject({
      /** No verdict within this time = ask the person (fail closed). */
      timeoutSec: z.number().int().min(2).max(300).default(20),
    })
    .prefault({}),
  /**
   * P13: a direct WebRTC DataChannel between the phone and this computer,
   * signaled over the encrypted Link session. STUN servers only
   * (`stun:host[:port]` / `stuns:`), nothing built in: empty = no WebRTC,
   * the relay carries everything. The Link handshake and sealed frames run on
   * top of the channel, as on every path.
   */
  rtc: z
    .strictObject({
      iceServers: z
        .array(z.string().regex(/^stuns?:(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/))
        .max(4)
        .default([]),
    })
    .prefault({}),
  /** Routines (P6): checks before the model, backoff on read failures, a daily AI-run cap. */
  routines: z
    .strictObject({
      /** AI runs routines may start per bot in 24 hours. */
      maxAiRunsPerDay: z.number().int().min(0).max(500).default(24),
      backoffBaseSec: z.number().int().min(1).max(86_400).default(900),
      backoffMaxSec: z.number().int().min(1).max(86_400).default(14_400),
      /** Items handed to one AI run at most (the rest wait for the next one). */
      maxItemsPerRun: z.number().int().min(1).max(200).default(20),
      /** After start-up, wait this long before the first check. */
      startDelaySec: z.number().int().min(0).max(3600).default(120),
    })
    .prefault({})
    .refine((r) => r.backoffMaxSec >= r.backoffBaseSec, {
      message: "backoffMaxSec must be ≥ backoffBaseSec",
    }),
});

export const SETTINGS_VERSION = 1 as const;

/**
 * Keys earlier versions wrote that are no longer part of the schema (P13 B1).
 * A config.json that still has them opens: they are dropped on load with one
 * warning each. Any other unknown key is still an error (typos, or keys such
 * as `permissions.alwaysConfirm` that must never be settable).
 */
export const REMOVED_KEYS: readonly string[] = Object.freeze([
  "models.defaultEngine",
  "models.suggestFallbackOnQuota",
  "connections.accounts",
  "advanced.dataDir",
  "engineering.engineIdleShutdownSec",
  "engineering.promptCacheKeepWarmSec",
  "engineering.offlineMailboxHours",
  // PAKE v1 was removed (pake-v1-remove): `link` only held the v1 switch.
  "engineering.link",
]);

export const SettingsSchema = z.strictObject({
  version: z.literal(SETTINGS_VERSION).default(SETTINGS_VERSION),
  models: ModelsPage.prefault({}),
  connections: ConnectionsPage.prefault({}),
  permissions: PermissionsPage.prefault({}),
  devices: DevicesPage.prefault({}),
  advanced: AdvancedPage.prefault({}),
  engineering: EngineeringParams.prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsInput = z.input<typeof SettingsSchema>;
export type UserFacingKey = Exclude<keyof Settings, "version" | "engineering">;
