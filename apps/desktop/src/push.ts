// Web Push from the core (P8): "something needs you" pings to paired phones.
//
// - The VAPID key pair is generated on first start and kept in secrets.json
//   (0600) on this computer; phones subscribe with its public half.
// - A push carries only a type and an opaque id (`{v, t, id}`), encrypted for
//   the phone (RFC 8291). The phone shows a fixed local sentence and fetches
//   the details over the end-to-end Link session after it is opened.
// - The core POSTs to the browser's push service itself (RFC 8030); no Alca
//   server is involved. Only the known push services are contacted.
import type { AlcaCore } from "@alca/core";
import type { AlcaEvent } from "@alca/protocol";
import {
  checkKeys,
  type DeliveryResult,
  type PushKind,
  PushSender,
  pushPayload,
  type VapidJwk,
  vapidPublicKey,
} from "@alca/push";
import type { PushSubscriptionRecord, Store } from "@alca/store";

export interface PushOptions {
  core: AlcaCore;
  store: Store;
  vapid: VapidJwk;
  /** VAPID contact (mailto: / https:). Default: $ALCA_PUSH_CONTACT, else a neutral example address. */
  contact?: string;
  /** Tests: allow a loopback mock push service. */
  allowEndpoint?: (endpoint: string) => boolean;
  fetch?: typeof fetch;
  /** Seconds before a failed (429 / 5xx / network) delivery is tried once more. */
  retrySec?: number;
  /** settings `devices.pushPreview` (P13 B1): `none` = no Web Push at all; an open app still hears. */
  preview?: () => "none" | "notify_only";
}

export class PushError extends Error {}

/** Consecutive refusals after which a subscription is dropped (the phone re-subscribes on next open). */
const MAX_FAILURES = 5;

export class PushNotifier {
  readonly sender: PushSender;
  private readonly o: PushOptions;
  /** Devices whose app is open and visible right now (they see the card in the app). */
  private readonly visible = new Set<string>();
  /** ref → thread, from the events (a worker's / teammate's card names the thread it is shown in). */
  private readonly where = new Map<string, string>();
  private readonly sent = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private off: (() => void) | undefined;
  private readonly inflight = new Set<Promise<unknown>>();
  private inApp: ((deviceId: string, p: { t: PushKind; id: string }) => void) | undefined;

  constructor(o: PushOptions) {
    this.o = o;
    this.sender = new PushSender({
      vapid: () => o.vapid,
      contact: o.contact ?? process.env.ALCA_PUSH_CONTACT ?? "mailto:admin@example.com",
      ...(o.allowEndpoint ? { allowEndpoint: o.allowEndpoint } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
  }

  /** Web Push switched off in settings. */
  private off_(): boolean {
    return this.o.preview?.() === "none";
  }

  get publicKey(): string {
    return vapidPublicKey(this.o.vapid);
  }

  /** Listen for cards on every thread. */
  start(): void {
    this.off = this.o.core.bus.subscribe("*", (e) => this.onEvent(e));
  }

  private onEvent(e: AlcaEvent): void {
    if (e.type === "approval.requested") this.queue("approval", e.data.approvalId, e.threadId);
    else if (e.type === "question.asked") this.queue("question", e.data.questionId, e.threadId);
    else if (e.type === "handoff.requested" && e.data.to === "user")
      this.queue("handoff", e.data.handoffId, e.threadId);
  }

  /** P14: an add-on's offer card was shown (主動留意). */
  offer(offerId: string, threadId: string | undefined): void {
    this.queue("offer", offerId, threadId ?? "");
  }

  private queue(kind: PushKind, ref: string, threadId: string) {
    this.where.set(ref, threadId);
    if (this.where.size > 500) this.where.delete(this.where.keys().next().value as string);
    // A card replayed to a reconnecting surface is not new.
    if (this.sent.has(ref)) return;
    this.sent.add(ref);
    if (this.sent.size > 2000) this.sent.delete(this.sent.values().next().value as string);
    this.track(this.notify(kind, ref));
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }

  /** How a visible phone hears about a card instead (a sealed Link event; set by the Link wiring). */
  setInApp(fn: (deviceId: string, p: { t: PushKind; id: string }) => void): void {
    this.inApp = fn;
  }

  /** The phone tells the core whether the app is in front (then it needs no push). */
  presence(deviceId: string, visible: boolean): void {
    if (visible) this.visible.add(deviceId);
    else this.visible.delete(deviceId);
  }

  subscribe(
    deviceId: string,
    a: { endpoint?: unknown; keys?: unknown; userAgent?: unknown },
  ): { id: string; endpointHost: string } {
    const endpoint = typeof a.endpoint === "string" ? a.endpoint : "";
    if (!endpoint || endpoint.length > 1024) throw new PushError("endpoint is required");
    if (!this.sender.endpointAllowed(endpoint)) throw new PushError("這不是已知的推播服務");
    const k = (a.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
    const keys = { p256dh: String(k.p256dh ?? ""), auth: String(k.auth ?? "") };
    try {
      checkKeys(keys);
    } catch (e) {
      throw new PushError((e as Error).message);
    }
    const d = this.o.store.devices.get(deviceId);
    if (!d || d.revokedAt) throw new PushError("這台裝置已被撤銷");
    const rec = this.o.store.push.upsert(deviceId, {
      endpoint,
      ...keys,
      userAgent: typeof a.userAgent === "string" ? a.userAgent : "",
    });
    return { id: rec.id, endpointHost: new URL(endpoint).host };
  }

  unsubscribe(deviceId: string, endpoint?: unknown): { removed: number } {
    return {
      removed: this.o.store.push.removeForDevice(
        deviceId,
        typeof endpoint === "string" ? endpoint : undefined,
      ),
    };
  }

  status(deviceId: string) {
    const subs = this.o.store.push.forDevice(deviceId);
    return {
      vapidPublicKey: this.publicKey,
      subscribed: subs.length > 0,
      subscriptions: subs.map((s) => ({
        endpointHost: new URL(s.endpoint).host,
        createdAt: s.createdAt,
        lastSentAt: s.lastSentAt,
        lastStatus: s.lastStatus,
        failures: s.failures,
      })),
    };
  }

  /** Send a test ping to one device (even while its app is open). */
  async test(deviceId: string): Promise<{ results: DeliveryResult[] }> {
    if (this.off_()) throw new PushError("通知在電腦的設定裡關閉了（推播：不送）");
    const id = `t${Date.now().toString(36)}`;
    const subs = this.o.store.push.forDevice(deviceId);
    if (!subs.length) throw new PushError("這支手機還沒開啟通知");
    const results = await Promise.all(subs.map((s) => this.deliver(s, "test", id)));
    return { results };
  }

  private live(deviceId: string): boolean {
    const d = this.o.store.devices.get(deviceId);
    return !!d && !d.revokedAt;
  }

  /** A revoked phone: no in-app notices either (its session is cut off too). */
  forget(deviceId: string): void {
    this.visible.delete(deviceId);
    this.o.store.push.removeForDevice(deviceId);
  }

  /** Ping every paired phone that has a subscription and is not looking at the app. */
  async notify(kind: PushKind, ref: string): Promise<DeliveryResult[]> {
    const out: DeliveryResult[] = [];
    for (const s of this.o.store.push.live()) {
      if (!this.live(s.deviceId)) continue;
      if (this.visible.has(s.deviceId)) {
        this.o.store.push.record(s, { kind, ref, outcome: "skipped" });
        this.inApp?.(s.deviceId, { t: kind, id: ref });
        continue;
      }
      if (this.off_()) {
        this.o.store.push.record(s, { kind, ref, outcome: "skipped" });
        continue;
      }
      out.push(await this.deliver(s, kind, ref));
    }
    return out;
  }

  private async deliver(s: PushSubscriptionRecord, kind: PushKind, ref: string, attempt = 1) {
    const r = await this.sender.send({ endpoint: s.endpoint, keys: s.keys }, pushPayload(kind, ref));
    this.o.store.push.record(s, { kind, ref, outcome: r.outcome, status: r.status });
    if (r.outcome === "gone") this.o.store.push.remove(s.id);
    else if (r.outcome === "rejected" && s.failures + 1 >= MAX_FAILURES) this.o.store.push.remove(s.id);
    else if (r.outcome === "retry" && attempt < 2) {
      const sec = Math.min(r.retryAfterSec ?? this.o.retrySec ?? 30, 600);
      const t = setTimeout(() => {
        this.timers.delete(t);
        const fresh = this.o.store.push.get(s.id);
        // B8: never a retry to a phone revoked since the first try (the store drops its
        // subscriptions on revoke; this holds even if that ever changes).
        if (fresh && this.live(fresh.deviceId)) this.track(this.deliver(fresh, kind, ref, attempt + 1));
      }, sec * 1000);
      t.unref?.();
      this.timers.add(t);
    }
    return r;
  }

  /**
   * Where a pinged card lives, for the phone that was opened from the
   * notification. Answers only ids and status; the card itself arrives over
   * the thread watch, like any other card.
   */
  locate(kind: string, ref: string): { kind: string; threadId: string | null; status: string } {
    const st = this.o.store;
    const threadOfRun = (runId: string | null | undefined) =>
      runId ? (st.runs.get(runId)?.threadId ?? null) : null;
    if (kind === "approval") {
      const a = st.human.approval(ref);
      if (!a) return { kind, threadId: null, status: "unknown" };
      const viaWorker = a.workerId ? (st.workers.get(a.workerId)?.threadId ?? null) : null;
      return { kind, threadId: this.where.get(ref) ?? viaWorker ?? threadOfRun(a.runId), status: a.status };
    }
    if (kind === "question") {
      const q = st.human.question(ref);
      if (!q) return { kind, threadId: null, status: "unknown" };
      return { kind, threadId: this.where.get(ref) ?? threadOfRun(q.runId), status: q.status };
    }
    if (kind === "handoff") return { kind, threadId: this.where.get(ref) ?? null, status: "pending" };
    if (kind === "offer") {
      const o = st.offers.get(ref);
      return o
        ? { kind, threadId: o.threadId, status: o.status }
        : { kind, threadId: null, status: "unknown" };
    }
    return { kind, threadId: null, status: "unknown" };
  }

  async close(): Promise<void> {
    this.off?.();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await Promise.allSettled([...this.inflight]);
  }
}
