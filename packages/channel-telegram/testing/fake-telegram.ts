// A local stand-in for the Telegram Bot API (written from the public docs):
// getMe, getUpdates with long polling and offsets, sendMessage. Tests push
// updates with `say()` and read what the bot sent from `sent`.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TgChat, TgUpdate } from "../src/api.ts";

export interface FakeTelegram {
  base: string;
  token: string;
  sent: Array<{ chatId: number; text: string }>;
  /** Every request path with the token replaced, to check nothing else leaked into URLs. */
  calls: string[];
  say(chat: Partial<TgChat> & { id: number }, text: string): void;
  /** Make the next getUpdates fail with this HTTP status + description. */
  failNext(status: number, description: string): void;
  revoke(): void;
  close(): Promise<void>;
}

export async function startFakeTelegram(
  token = "123456789:AAFakeFakeFakeFakeFakeFakeFakeFake_x",
): Promise<FakeTelegram> {
  const updates: TgUpdate[] = [];
  let nextId = 1000;
  let waiters: Array<() => void> = [];
  let fail: { status: number; description: string } | undefined;
  let revoked = false;
  const sent: FakeTelegram["sent"] = [];
  const calls: string[] = [];

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const url = req.url ?? "";
      calls.push(url.replaceAll(token, "<token>"));
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(url);
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (!m || m[1] !== token || revoked)
        return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
      const params = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      switch (m[2]) {
        case "getMe":
          return reply(200, {
            ok: true,
            result: { id: 123456789, is_bot: true, first_name: "Alca", username: "my_alca_bot" },
          });
        case "sendMessage":
          sent.push({ chatId: Number(params.chat_id), text: String(params.text) });
          return reply(200, {
            ok: true,
            result: { message_id: sent.length, date: 0, chat: { id: params.chat_id, type: "private" } },
          });
        case "getUpdates": {
          if (fail) {
            const f = fail;
            fail = undefined;
            return reply(f.status, { ok: false, error_code: f.status, description: f.description });
          }
          const offset = Number(params.offset ?? 0);
          const pending = () => updates.filter((u) => u.update_id >= offset);
          const answer = () => reply(200, { ok: true, result: pending() });
          if (pending().length) return answer();
          const timer = setTimeout(answer, Number(params.timeout ?? 0) * 1000);
          waiters.push(() => {
            clearTimeout(timer);
            answer();
          });
          res.on("close", () => clearTimeout(timer));
          return;
        }
        default:
          return reply(404, { ok: false, error_code: 404, description: "Not Found" });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    token,
    sent,
    calls,
    say(chat, text) {
      const c: TgChat = { type: "private", first_name: "測試", ...chat };
      updates.push({
        update_id: nextId++,
        message: {
          message_id: nextId,
          date: 0,
          chat: c,
          from: { id: c.id, first_name: c.first_name ?? "" },
          text,
        },
      });
      const w = waiters;
      waiters = [];
      for (const f of w) f();
    },
    failNext(status, description) {
      fail = { status, description };
    },
    revoke() {
      revoked = true;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
