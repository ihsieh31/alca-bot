// A small Telegram Bot API client written from the public docs
// (https://core.telegram.org/bots/api): getMe, getUpdates (long polling),
// sendMessage. The token is part of every request URL, so no URL, request or
// low-level fetch error ever leaves this file; errors carry Telegram's own
// description (which never contains the token) or a fixed sentence.

/** The public Bot API host; a test or a self-hosted Bot API server can point elsewhere. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** `123456789:AA…` — the shape BotFather gives out. */
export const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  first_name?: string;
  username?: string;
  title?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export class TelegramError extends Error {
  readonly code: number | undefined;
  /** 401 / 404 on the token: stop polling, the person has to fix the token. */
  readonly fatal: boolean;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "TelegramError";
    this.code = code;
    this.fatal = code === 401 || code === 404;
  }
}

/** Telegram's limit is 4096 characters; cut on a line break when one is near. */
export function splitMessage(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const nl = rest.lastIndexOf("\n", max);
    const cut = nl > max * 0.6 ? nl : max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length || out.length === 0) out.push(rest);
  return out;
}

export class TelegramApi {
  private readonly token: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string, o: { base?: string; fetch?: typeof fetch } = {}) {
    if (!TOKEN_RE.test(token)) throw new TelegramError("這不是 Telegram bot 權杖的格式（像 123456789:AA…）");
    this.token = token;
    this.base = (o.base ?? TELEGRAM_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = o.fetch ?? fetch;
  }

  private async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      // The fetch error's cause can quote the URL (and with it the token): never pass it on.
      throw new TelegramError("連不到 Telegram");
    }
    let body: { ok?: boolean; result?: T; description?: string; error_code?: number };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TelegramError(`Telegram 回應 HTTP ${res.status}`, res.status);
    }
    if (!res.ok || !body.ok) {
      const desc =
        typeof body.description === "string" ? body.description.replaceAll(this.token, "‹token›") : "";
      throw new TelegramError(desc || `Telegram 回應 HTTP ${res.status}`, body.error_code ?? res.status);
    }
    return body.result as T;
  }

  getMe(signal?: AbortSignal): Promise<TgUser> {
    return this.call<TgUser>("getMe", {}, signal);
  }

  /** Long poll: Telegram holds the request up to `timeoutSec` when there is nothing new. */
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message"] },
      signal,
    );
  }

  /** Plain text only (no parse_mode), so a reply can never turn into markup or a link preview trick. */
  async sendMessage(chatId: number, text: string): Promise<void> {
    for (const part of splitMessage(text)) {
      await this.call("sendMessage", {
        chat_id: chatId,
        text: part,
        link_preview_options: { is_disabled: true },
      });
    }
  }
}
