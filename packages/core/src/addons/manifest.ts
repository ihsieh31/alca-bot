import type { Bot, BotProfileInput } from "@alca/store";
import { z } from "zod";
import { parseQuietHours } from "../agents/early.ts";

/**
 * Built-in add-ons (P14, plan v10 §A). An add-on is a feature a bot may turn
 * on for itself because it costs model usage or is only useful to a few
 * bots. The registry is a static list in this file: no add-on code is ever
 * loaded from outside the program, and there are no third-party add-ons.
 *
 * `costClass`:
 * - `none`: never calls a model;
 * - `on_use`: calls a model only while the person (or the bot's own work) uses
 *   the bot — e.g. a check on each reply;
 * - `proactive`: spends on its own schedule, with nobody asking.
 */
export type AddonCostClass = "none" | "on_use" | "proactive";

/** What a bot needs before the add-on can be turned on. */
export type AddonRequirement =
  /** The bot's engine can answer one prompt with no tools (every engine Alca builds can). */
  | "engine_completion"
  /** At least one connected app the bot may read. */
  | "connected_app";

export const REQUIREMENT_WORDS: Record<AddonRequirement, string> = {
  engine_completion: "這個 bot 的模型要能單獨回答一段提示（不用工具）",
  connected_app: "至少要有一個這個 bot 可以讀的連接 app",
};

/** An add-on whose switch and settings live in existing bot columns (P13 features), read and written as they were. */
export interface AddonAdapter {
  read(bot: Bot): { enabled: boolean; settings: Record<string, unknown> };
  write(patch: { enabled?: boolean; settings?: Record<string, unknown> }): BotProfileInput;
}

export interface AddonManifest {
  id: string;
  /** 繁中 name and one line of what it does. */
  name: string;
  description: string;
  costClass: AddonCostClass;
  /** Settings with their defaults (every field has one). */
  settings: z.ZodObject;
  defaultEnabled: false;
  requires: readonly AddonRequirement[];
  /** Default daily caps; null = the add-on has its own limits (adapters) or never calls a model. */
  dailyTokenCap: number | null;
  dailyRunCap: number | null;
  adapter?: AddonAdapter;
  /** Settings carry `engine` + `model`, picked from the host's model choices for the bot. */
  pickModel?: true;
}

const quiet = z
  .string()
  .refine((s) => !!parseQuietHours(s), { message: "安靜時段要寫成 22:00-08:00" })
  .nullable();

const caps = (tokens: number, runs: number) => ({
  dailyTokenCap: z.number().int().min(1000).max(500_000).default(tokens),
  dailyRunCap: z.number().int().min(1).max(500).default(runs),
});

export const PROACTIVE_ID = "proactive";
export const REPLY_CHECK_ID = "reply-check";
export const EARLY_WORK_ID = "early-work";
export const SHELL_REVIEW_ID = "shell-review";

export const proactiveSettings = z.object({
  maxPerDay: z.number().int().min(1).max(5).default(2),
  quietHours: quiet.default("22:00-08:00"),
  minIntervalHours: z.number().min(0.5).max(24).default(3),
  scanMinutes: z.number().int().min(15).max(120).default(30),
  sources: z
    .object({
      calendar: z.boolean().default(true),
      mail: z.boolean().default(true),
      alca: z.boolean().default(true),
      deadlines: z.boolean().default(true),
    })
    .default({ calendar: true, mail: true, alca: true, deadlines: true }),
  ...caps(30_000, 6),
});
export type ProactiveSettings = z.infer<typeof proactiveSettings>;

/**
 * 回覆檢查 may run on another model than the bot's router (a small, cheap
 * one). `engine` null = the bot's own router model (the default); otherwise
 * one of the bot's configured model services, `model` null = that service's
 * default model. The host checks the pair against `AddonEnv.modelChoices`.
 */
export const replyCheckSettings = z.object({
  timeoutSec: z.number().min(1).max(15).default(4),
  engine: z.string().max(80).nullable().default(null),
  model: z.string().max(200).nullable().default(null),
  ...caps(20_000, 200),
});
export type ReplyCheckSettings = z.infer<typeof replyCheckSettings>;

const earlySettings = z.object({ quietHours: quiet.default(null) });
const reviewSettings = z.object({
  engine: z.string().max(80).nullable().default(null),
  model: z.string().max(200).nullable().default(null),
});

/** The registry: what Alca ships. Order is the order the editor lists them. */
export const ADDONS: readonly AddonManifest[] = [
  {
    id: PROACTIVE_ID,
    name: "主動留意",
    description: "看行事曆、信件和 Alca 自己的狀態，有具體的事才主動提一件，並先查好細節。",
    costClass: "proactive",
    settings: proactiveSettings,
    defaultEnabled: false,
    requires: ["engine_completion"],
    dailyTokenCap: 30_000,
    dailyRunCap: 6,
  },
  {
    id: REPLY_CHECK_ID,
    name: "回覆檢查",
    description: "總機每次回覆前，先檢查有沒有問太多、提了做不到的事或說出記憶來源，有就重寫一次。",
    costClass: "on_use",
    settings: replyCheckSettings,
    defaultEnabled: false,
    requires: ["engine_completion"],
    dailyTokenCap: 20_000,
    dailyRunCap: 200,
    pickModel: true,
  },
  {
    id: EARLY_WORK_ID,
    name: "提前做",
    description: "收到觸發事件時在背景先準備好草稿；寄出、付款、刪除、發布不會在背景做。",
    costClass: "proactive",
    settings: earlySettings,
    defaultEnabled: false,
    requires: [],
    dailyTokenCap: null,
    dailyRunCap: null,
    adapter: {
      read: (b) => ({ enabled: b.earlyWork === "on", settings: { quietHours: b.quietHours } }),
      write: (p) => ({
        ...(p.enabled !== undefined ? { earlyWork: p.enabled ? "on" : "off" } : {}),
        ...(p.settings ? { quietHours: (p.settings.quietHours as string | null) ?? null } : {}),
      }),
    },
  },
  {
    id: SHELL_REVIEW_ID,
    name: "小模型審 shell",
    description: "自主模式下，每個 shell 指令執行前先給一個模型看風險；高風險或看不懂就改成問你。",
    costClass: "on_use",
    settings: reviewSettings,
    defaultEnabled: false,
    requires: [],
    dailyTokenCap: null,
    dailyRunCap: null,
    adapter: {
      read: (b) => ({
        enabled: b.shellReview === "on",
        settings: { engine: b.shellReviewEngine, model: b.shellReviewModel },
      }),
      write: (p) => ({
        ...(p.enabled !== undefined ? { shellReview: p.enabled ? "on" : "off" } : {}),
        ...(p.settings
          ? {
              shellReviewEngine: (p.settings.engine as string | null) || null,
              shellReviewModel: (p.settings.model as string | null) || null,
            }
          : {}),
      }),
    },
  },
];

export function addonManifest(id: string): AddonManifest | undefined {
  return ADDONS.find((a) => a.id === id);
}
