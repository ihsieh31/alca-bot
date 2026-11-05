// The relay's account registry (P10): keyed hash of a Google account id →
// the computers registered under it. The relay never stores the Google `sub`,
// an email or a token: the account key is HMAC-SHA-256(relay secret, sub), so
// the file alone does not say whose computers these are. WebCrypto only
// (shared by the Node relay and the Cloudflare Worker); persistence goes
// through an `AccountStore`.
import { type Key, toB64u, utf8 } from "@alca/link/bytes";
import type { ComputerListing } from "@alca/link/relay-protocol";

export interface ComputerEntry {
  mailbox: string;
  name: string;
  fingerprint: string;
  registeredAt: string;
  lastSeen: string;
}

export interface AccountSnapshot {
  v: 1;
  accounts: Record<string, ComputerEntry[]>;
}

export interface AccountStore {
  load(): Promise<AccountSnapshot | undefined>;
  save(s: AccountSnapshot): Promise<void>;
}

/** In memory only (tests; a relay without a store file). */
export class MemoryAccountStore implements AccountStore {
  snapshot: AccountSnapshot | undefined;
  async load() {
    return this.snapshot ? (JSON.parse(JSON.stringify(this.snapshot)) as AccountSnapshot) : undefined;
  }
  async save(s: AccountSnapshot) {
    this.snapshot = JSON.parse(JSON.stringify(s)) as AccountSnapshot;
  }
}

export interface AccountRegistryOptions {
  /** The relay secret (at least 16 bytes of entropy); keys the account hash. */
  secret: string;
  store?: AccountStore;
  maxComputersPerAccount?: number;
  now?: () => number;
  /** Debounce for saves, ms (default 500; 0 = save at once). */
  saveDelayMs?: number;
}

const cleanName = (s: unknown): string =>
  (typeof s === "string" ? s : "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from a display name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 60) || "電腦";

export class AccountRegistry {
  private accounts = new Map<string, ComputerEntry[]>();
  private byMailbox = new Map<string, string>();
  private hmacKey: Promise<Key>;
  private loaded: Promise<void>;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private readonly o: AccountRegistryOptions;
  private readonly now: () => number;

  constructor(o: AccountRegistryOptions) {
    if (!o.secret || o.secret.length < 16) throw new Error("the relay secret must be at least 16 characters");
    this.o = o;
    this.now = o.now ?? Date.now;
    this.hmacKey = crypto.subtle.importKey("raw", utf8(o.secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    this.loaded = (async () => {
      const s = await o.store?.load();
      for (const [acct, list] of Object.entries(s?.accounts ?? {})) {
        const clean = list.filter((c) => c && typeof c.mailbox === "string");
        if (!clean.length) continue;
        this.accounts.set(acct, clean);
        for (const c of clean) this.byMailbox.set(c.mailbox, acct);
      }
    })();
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  /** The account key for a Google `sub`: base64url(HMAC-SHA-256(secret, "alca-relay/v0 account" ‖ 0 ‖ sub)). */
  async accountOf(sub: string): Promise<string> {
    const mac = await crypto.subtle.sign(
      "HMAC",
      await this.hmacKey,
      utf8(`alca-relay/v0 account\u0000${sub}`),
    );
    return toB64u(new Uint8Array(mac));
  }

  stats() {
    return { accounts: this.accounts.size, computers: this.byMailbox.size };
  }

  /** Add or refresh a computer; a mailbox belongs to one account (moving it drops the old entry). */
  async register(
    account: string,
    c: { mailbox: string; name: unknown; fingerprint: string },
  ): Promise<"ok" | "too_many"> {
    await this.loaded;
    const iso = new Date(this.now()).toISOString();
    const prev = this.byMailbox.get(c.mailbox);
    if (prev && prev !== account) this.drop(c.mailbox);
    const list = this.accounts.get(account) ?? [];
    const old = list.find((x) => x.mailbox === c.mailbox);
    if (old) {
      old.name = cleanName(c.name);
      old.fingerprint = c.fingerprint;
      old.lastSeen = iso;
    } else {
      if (list.length >= (this.o.maxComputersPerAccount ?? 10)) return "too_many";
      list.push({
        mailbox: c.mailbox,
        name: cleanName(c.name),
        fingerprint: c.fingerprint,
        registeredAt: iso,
        lastSeen: iso,
      });
    }
    this.accounts.set(account, list);
    this.byMailbox.set(c.mailbox, account);
    this.changed();
    return "ok";
  }

  async unregister(mailbox: string): Promise<boolean> {
    await this.loaded;
    const ok = this.drop(mailbox);
    if (ok) this.changed();
    return ok;
  }

  private drop(mailbox: string): boolean {
    const acct = this.byMailbox.get(mailbox);
    if (!acct) return false;
    this.byMailbox.delete(mailbox);
    const left = (this.accounts.get(acct) ?? []).filter((x) => x.mailbox !== mailbox);
    if (left.length) this.accounts.set(acct, left);
    else this.accounts.delete(acct);
    return true;
  }

  owns(account: string, mailbox: string): boolean {
    return this.byMailbox.get(mailbox) === account;
  }

  isRegistered(mailbox: string): boolean {
    return this.byMailbox.has(mailbox);
  }

  /** The core proved its mailbox (signed challenge): note when. */
  seen(mailbox: string): void {
    const acct = this.byMailbox.get(mailbox);
    const c = acct ? this.accounts.get(acct)?.find((x) => x.mailbox === mailbox) : undefined;
    if (!c) return;
    c.lastSeen = new Date(this.now()).toISOString();
    this.changed();
  }

  async list(account: string, online: (mailbox: string) => boolean): Promise<ComputerListing[]> {
    await this.loaded;
    return (this.accounts.get(account) ?? []).map((c) => ({ ...c, online: online(c.mailbox) }));
  }

  snapshot(): AccountSnapshot {
    return {
      v: 1,
      accounts: Object.fromEntries([...this.accounts].map(([k, v]) => [k, v.map((c) => ({ ...c }))])),
    };
  }

  /** Write any pending change now (shutdown, tests). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.saving = this.saving.then(() => this.o.store?.save(this.snapshot())).catch(() => undefined);
    }
    await this.saving;
  }

  private changed() {
    if (!this.o.store) return;
    const delay = this.o.saveDelayMs ?? 500;
    if (delay === 0) {
      this.saving = this.saving.then(() => this.o.store?.save(this.snapshot())).catch(() => undefined);
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saving = this.saving.then(() => this.o.store?.save(this.snapshot())).catch(() => undefined);
    }, delay);
    (this.saveTimer as { unref?: () => void }).unref?.();
  }
}
