import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store, TriggerRecord, TriggerSource } from "@alca/store";
import type { TriggerEventInput, TriggerRule, TriggerSourceDriver } from "@alca/tools";
import { budgetJson, pick } from "./budget.ts";
import { appInfo } from "./catalog.ts";
import type { ConnectorService } from "./service.ts";
import type { Vault } from "./vault.ts";

/**
 * Connected-app triggers (P6). The provider (Composio) signs each event and
 * POSTs it to a mailbox on the person's own relay; the core pulls from there
 * (outbound only, no public port), checks the signature (HMAC-SHA256 over
 * `id.timestamp.body`, base64, the provider's documented scheme), drops
 * duplicates by event id, and fires the matching P3 trigger, so the two-stage
 * filter (code rules, then model judgment) decides whether anyone wakes up.
 */

export const HOOK_PULL_KEY = "relay.hookPullToken";
export const WEBHOOK_SECRET_KEY = "composio.webhookSecret";

/** The provider's signature scheme: `v1,<base64 HMAC-SHA256(secret, "<id>.<ts>.<body>")>`, several space-separated. */
export function verifySignature(
  secret: string,
  h: { id?: string | undefined; timestamp?: string | undefined; signature?: string | undefined },
  body: string,
  o: { now?: number; toleranceSec?: number } = {},
): boolean {
  if (!secret || !h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts)) return false;
  const tol = o.toleranceSec ?? 24 * 3600;
  const now = (o.now ?? Date.now()) / 1000;
  if (tol > 0 && Math.abs(now - ts) > tol) return false;
  const expected = createHmac("sha256", secret).update(`${h.id}.${h.timestamp}.${body}`).digest();
  for (const part of h.signature.split(" ")) {
    const b64 = part.includes(",") ? part.split(",")[1] : part;
    const got = Buffer.from(b64 ?? "", "base64");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

/** Sign like the provider does (tests and the mock server). */
export function signWebhook(secret: string, id: string, timestamp: string, body: string): string {
  return `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export interface HookEnvelope {
  id: string;
  type: string;
  metadata: { trigger_id?: string; trigger_slug?: string; connected_account_id?: string };
  data: Record<string, unknown>;
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** Turn an app event into what the trigger filter reads: text, sender, stream key. */
export function eventInput(toolkit: string, env: HookEnvelope): TriggerEventInput {
  const d = env.data ?? {};
  const first = (...keys: string[]) => keys.map((k) => text(pick(d, k))).find(Boolean) ?? "";
  const app = appInfo(toolkit).name;
  if (toolkit === "gmail") {
    const subject = first("subject");
    const from = first("sender", "from");
    const body = first("preview", "message_text", "messageText", "snippet");
    const threadId = first("thread_id", "threadId");
    return {
      text: `${app} 新信：${subject}\n${body}`.slice(0, 4000),
      ...(from ? { from } : {}),
      ...(threadId ? { streamKey: `gmail:${threadId}`, streamTitle: subject || "信件" } : {}),
    };
  }
  if (toolkit === "slack" || toolkit === "line") {
    const msg = first("text", "message.text", "event.text");
    const from = first("user", "userId", "source.userId", "event.user");
    const chan = first("channel", "event.channel", "source.groupId");
    return {
      text: `${app} 訊息：${msg}`.slice(0, 4000),
      ...(from ? { from } : {}),
      ...(chan ? { streamKey: `${toolkit}:${chan}`, streamTitle: `${app} ${chan}` } : {}),
      // A direct message is addressed to the bot.
      ...(env.metadata.trigger_slug?.includes("DIRECT") ? { explicit: true } : {}),
    };
  }
  if (toolkit === "github") {
    const msg = first("message", "title", "head_commit.message");
    const from = first("author", "sender.login", "user.login");
    const repo = first("repository", "repo", "repository.full_name");
    return {
      text: `${app} ${env.metadata.trigger_slug ?? "事件"}：${msg}`.slice(0, 4000),
      ...(from ? { from } : {}),
      ...(repo ? { streamKey: `github:${repo}`, streamTitle: repo } : {}),
    };
  }
  return { text: `${app} 事件：${budgetJson(d, 3000).text}` };
}

export interface HookPullerOptions {
  store: Store;
  vault: Vault;
  service: ConnectorService;
  /** The relay's base URL (http(s) or ws(s); the rendezvous). */
  relayUrl: string;
  fire: (triggerId: string, ev: TriggerEventInput) => Promise<unknown>;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface PullResult {
  received: number;
  fired: number;
  rejected: number;
  duplicates: number;
  error?: string;
}

/** Mailbox on the relay + the pull loop. */
export class HookPuller {
  private readonly o: HookPullerOptions;
  private registered = false;
  lastError: string | undefined;
  lastPullAt: string | undefined;

  constructor(o: HookPullerOptions) {
    this.o = o;
  }

  private base(): string {
    return this.o.relayUrl.replace(/^ws(s?):/, "http$1:").replace(/\/+$/, "");
  }

  hookId(): string {
    let id = this.o.store.connectors.meta("relay.hookId");
    if (!id) {
      id = randomBytes(18).toString("base64url");
      this.o.store.connectors.setMeta("relay.hookId", id);
    }
    return id;
  }

  /** The public URL the provider posts to. */
  hookUrl(): string {
    return `${this.base()}/v0/hooks/${this.hookId()}`;
  }

  private async token(): Promise<string> {
    let t = await this.o.vault.get(HOOK_PULL_KEY);
    if (!t) {
      t = randomBytes(32).toString("base64url");
      await this.o.vault.set(HOOK_PULL_KEY, t);
    }
    return t;
  }

  /** The relay may keep mailboxes in memory only: register on every start. */
  async register(): Promise<void> {
    const pull = createHash("sha256")
      .update(await this.token())
      .digest("hex");
    const r = await (this.o.fetch ?? fetch)(this.hookUrl(), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pull }),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status !== 200 && r.status !== 201) throw new Error(`relay 不接受這個信箱（${r.status}）`);
    // 201 = a new, empty mailbox (first start, or a relay that forgot us): its counter starts at 0.
    if (r.status === 201) this.o.store.connectors.setMeta("relay.hookSeq", "0");
    this.registered = true;
  }

  /** Make sure the provider can sign for us: read (or create) the project's webhook secret. */
  async ensureSecret(): Promise<string> {
    const have = await this.o.vault.get(WEBHOOK_SECRET_KEY);
    if (have) return have;
    const s = await this.o.service.client.webhookSecret(this.hookUrl());
    await this.o.vault.set(WEBHOOK_SECRET_KEY, s.secret);
    return s.secret;
  }

  async pull(): Promise<PullResult> {
    const out: PullResult = { received: 0, fired: 0, rejected: 0, duplicates: 0 };
    try {
      if (!this.registered) await this.register();
      const secret = await this.o.vault.get(WEBHOOK_SECRET_KEY);
      const after = Number(this.o.store.connectors.meta("relay.hookSeq") ?? 0) || 0;
      const r = await (this.o.fetch ?? fetch)(`${this.hookUrl()}/events?after=${after}`, {
        headers: { "x-alca-pull": await this.token() },
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status === 403) {
        // The relay restarted and someone else holds the id, or it forgot us: register again next time.
        this.registered = false;
        throw new Error("relay 拒絕取件（403）");
      }
      if (!r.ok) throw new Error(`relay 回應 ${r.status}`);
      const body = (await r.json()) as {
        items?: Array<{ seq: number; headers: Record<string, string>; body: string }>;
        seq?: number;
      };
      // The relay's counter is behind ours: its mailbox started over, so count from its start
      // (the webhook-id guard below keeps anything seen before from running twice).
      let last = typeof body.seq === "number" && body.seq < after ? 0 : after;
      for (const item of body.items ?? []) {
        out.received++;
        last = Math.max(last, item.seq);
        const ok =
          !!secret &&
          verifySignature(
            secret,
            {
              id: item.headers["webhook-id"],
              timestamp: item.headers["webhook-timestamp"],
              signature: item.headers["webhook-signature"],
            },
            item.body,
            { ...(this.o.now ? { now: this.o.now() } : {}) },
          );
        if (!ok) {
          out.rejected++;
          this.o.log?.("connector event with a bad signature dropped");
          continue;
        }
        const eventId = item.headers["webhook-id"] as string;
        if (!this.o.store.connectors.markSeen(eventId)) {
          out.duplicates++;
          continue;
        }
        let env: HookEnvelope;
        try {
          env = JSON.parse(item.body) as HookEnvelope;
        } catch {
          out.rejected++;
          continue;
        }
        if (await this.ingest(env)) out.fired++;
      }
      // Acknowledge (next pull drops them) only after every item was handled.
      this.o.store.connectors.setMeta("relay.hookSeq", String(last));
      this.lastError = undefined;
    } catch (err) {
      out.error = String((err as Error)?.message ?? err);
      this.lastError = out.error;
    }
    this.lastPullAt = new Date().toISOString();
    return out;
  }

  /** One verified event → its P3 trigger. */
  async ingest(env: HookEnvelope): Promise<boolean> {
    const remote = env.metadata?.trigger_id;
    if (!remote) return false;
    const ct = this.o.store.connectors.triggerByRemote(remote);
    if (!ct) return false;
    const acc = this.o.store.connectors.account(ct.accountId);
    if (!acc || acc.status === "removed") return false;
    await this.o.fire(ct.triggerId, eventInput(acc.toolkit, env));
    return true;
  }
}

/**
 * Trigger sources for app events (`email`, `im`, `github`, `webhook`): they
 * only exist so the hub accepts those kinds; events come in through
 * `HookPuller.pull`, which one of them runs on the hub's clock.
 */
export class AppEventSource implements TriggerSourceDriver {
  readonly kind: TriggerSource;
  private readonly puller: (() => HookPuller | undefined) | undefined;
  private readonly everyMs: number;
  private next = 0;
  constructor(kind: TriggerSource, puller?: () => HookPuller | undefined, everySec = 20) {
    this.kind = kind;
    this.puller = puller;
    this.everyMs = everySec * 1000;
  }

  async tick(now: Date): Promise<void> {
    const p = this.puller?.();
    if (!p || now.getTime() < this.next) return;
    this.next = now.getTime() + this.everyMs;
    await p.pull();
  }
}

export interface EnableTriggerInput {
  accountId: string;
  slug: string;
  threadId: string;
  botId?: string;
  config?: Record<string, unknown>;
  rule?: TriggerRule;
  semantic?: string | null;
  name?: string;
}

/** Start an app trigger: a P3 trigger here, a trigger instance at the provider that delivers to our relay. */
export async function enableAppTrigger(
  o: {
    store: Store;
    service: ConnectorService;
    puller: HookPuller;
    createTrigger: (t: {
      botId?: string;
      threadId: string;
      name: string;
      source: TriggerSource;
      config?: Record<string, unknown>;
      rule?: TriggerRule;
      semantic?: string | null;
    }) => TriggerRecord;
  },
  i: EnableTriggerInput,
): Promise<{ triggerId: string; connectorTriggerId: string }> {
  const acc = o.store.connectors.account(i.accountId);
  if (acc?.status !== "active") throw new Error("這個帳號還沒連好");
  const info = appInfo(acc.toolkit);
  const known = info.triggers.find((t) => t.slug === i.slug);
  await o.puller.register();
  await o.puller.ensureSecret();
  const trg = o.createTrigger({
    ...(i.botId ? { botId: i.botId } : {}),
    threadId: i.threadId,
    name: (i.name ?? `${info.name}「${acc.label}」${known?.name ?? i.slug}`).slice(0, 80),
    source: info.source,
    config: { app: acc.toolkit, accountId: acc.id, slug: i.slug },
    rule: i.rule ?? { mode: "candidate" },
    semantic: i.semantic ?? null,
  });
  const remoteId = await o.service.client.upsertTrigger(i.slug, {
    userId: o.service.userId(),
    accountId: acc.remoteId,
    config: i.config ?? {},
    egressUrl: o.puller.hookUrl(),
  });
  const ct = o.store.connectors.addTrigger({
    accountId: acc.id,
    slug: i.slug,
    remoteId,
    triggerId: trg.id,
    config: i.config ?? {},
    status: "active",
  });
  return { triggerId: trg.id, connectorTriggerId: ct.id };
}
