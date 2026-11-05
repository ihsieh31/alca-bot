// telegram.json (0600) in the data directory: the person's choices (on / off,
// which bot answers, the allow-list) and the poller's own state (the update
// offset, which thread each chat talks to, the last few chats that tried to
// talk without being allowed). No token (that is in the vault) and no
// message text is ever written here.
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "@alca/os";

export interface TelegramSettings {
  enabled: boolean;
  /** The Alca bot whose conversation Telegram messages go to; null = the default bot. */
  botId: string | null;
  /** Private chat ids allowed to talk to Alca. Empty = nobody. */
  allowChatIds: number[];
}

export interface ChatLink {
  threadId: string;
  botId: string;
}

export interface UnknownChat {
  chatId: number;
  name: string;
  at: string;
}

export interface TelegramState extends TelegramSettings {
  /** Next getUpdates offset (last update_id + 1). */
  offset: number;
  chats: Record<string, ChatLink>;
  /** Newest first, at most 5; name only, never what they wrote. */
  unknown: UnknownChat[];
}

export const EMPTY_STATE: TelegramState = Object.freeze({
  enabled: false,
  botId: null,
  allowChatIds: [],
  offset: 0,
  chats: {},
  unknown: [],
}) as TelegramState;

const isChatId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v !== 0;

/** Read the file; anything malformed falls back to "off, nobody allowed" (fail closed). */
export function loadState(path: string): TelegramState {
  if (!existsSync(path)) return structuredClone(EMPTY_STATE);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TelegramState>;
    const chats: Record<string, ChatLink> = {};
    for (const [k, v] of Object.entries(raw.chats ?? {}))
      if (v && typeof v.threadId === "string" && typeof v.botId === "string")
        chats[k] = { threadId: v.threadId, botId: v.botId };
    return {
      enabled: raw.enabled === true,
      botId: typeof raw.botId === "string" ? raw.botId : null,
      allowChatIds: Array.isArray(raw.allowChatIds) ? raw.allowChatIds.filter(isChatId) : [],
      offset: Number.isSafeInteger(raw.offset) && (raw.offset ?? 0) > 0 ? (raw.offset as number) : 0,
      chats,
      unknown: Array.isArray(raw.unknown)
        ? raw.unknown
            .filter((u): u is UnknownChat => !!u && isChatId(u.chatId) && typeof u.name === "string")
            .slice(0, 5)
        : [],
    };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

export function saveState(path: string, s: TelegramState): void {
  writeFileAtomic(path, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
}

/** Validate a settings change from the desktop; returns the problem, or undefined. */
export function settingsProblem(v: Record<string, unknown>): string | undefined {
  if ("enabled" in v && typeof v.enabled !== "boolean") return "enabled 要是 true / false";
  if ("botId" in v && v.botId !== null && typeof v.botId !== "string") return "botId 要是字串或 null";
  if ("allowChatIds" in v) {
    if (!Array.isArray(v.allowChatIds)) return "allowChatIds 要是陣列";
    if (v.allowChatIds.length > 20) return "最多 20 個聊天";
    if (!v.allowChatIds.every(isChatId)) return "聊天 ID 要是整數";
    if (v.allowChatIds.some((x) => (x as number) < 0)) return "只支援私人聊天（群組的 ID 是負數）";
  }
  return undefined;
}
