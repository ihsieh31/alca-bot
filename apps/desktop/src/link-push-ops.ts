import { RpcError } from "@alca/link";
import { PushError, type PushNotifier } from "./push.ts";

/**
 * Web Push for the phone (P8). Any paired phone may turn its own
 * notifications on or off, see their state, ask for a test ping and say
 * whether the app is in front; it can only touch its own subscriptions.
 * `cards.locate` (needs `chat`) tells a phone opened from a notification
 * which thread the card is in; the card itself comes over the thread watch.
 */

type Op = ["any" | "chat", (a: Record<string, unknown>) => unknown];

async function mapped<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PushError) throw new RpcError("bad_request", e.message);
    throw e;
  }
}

export function pushOps(push: PushNotifier | undefined, deviceId: string): Record<string, Op> {
  const p = () => {
    if (!push) throw new RpcError("unavailable", "推播未啟用");
    return push;
  };
  const ref = (a: Record<string, unknown>) => {
    const v = a.id;
    if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v))
      throw new RpcError("bad_request", "id is required");
    return v;
  };
  return {
    "push.config": ["any", () => ({ enabled: !!push, vapidPublicKey: push?.publicKey ?? null })],
    "push.status": ["any", () => p().status(deviceId)],
    "push.subscribe": ["any", (a) => mapped(() => p().subscribe(deviceId, a))],
    "push.unsubscribe": ["any", (a) => p().unsubscribe(deviceId, a.endpoint)],
    "push.test": ["any", () => mapped(() => p().test(deviceId))],
    "push.presence": [
      "any",
      (a) => {
        push?.presence(deviceId, a.visible === true);
        return { ok: true };
      },
    ],
    "cards.locate": [
      "chat",
      (a) => {
        const kind = typeof a.kind === "string" ? a.kind : "approval";
        return p().locate(kind, ref(a));
      },
    ],
  };
}
