import { randomBytes } from "node:crypto";
import type { SecretStore } from "@alca/os";

/**
 * Plan §5: website passwords in the connectors' vault, as the general
 * harness's `SecretSource`. An entry is `site-login:<id>` holding
 * `{ origin, username?, password, label?, botIds? }`, sealed with the rest
 * of the vault. The model only ever sees ids, labels, usernames and
 * origins; the password leaves this class only through `value()`, only for
 * the exact https origin the entry is for (no subdomains, no http), and only
 * for a bot the entry allows (no `botIds` = every bot). Card numbers and
 * one-time codes are not kept here (known gap).
 */

const PREFIX = "site-login:";

export interface SiteLogin {
  id: string;
  origin: string;
  username?: string;
  label?: string;
  /** Bots that may use it; absent = every bot. */
  botIds?: string[];
}

interface Stored extends Omit<SiteLogin, "id"> {
  password: string;
}

/** The canonical https origin of a URL or origin text, or undefined when it is not https. */
export function httpsOrigin(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

export class SiteLogins {
  private readonly vault: SecretStore;
  constructor(vault: SecretStore) {
    this.vault = vault;
  }

  private async entry(id: string): Promise<Stored | undefined> {
    if (!/^[a-z0-9_]{4,64}$/.test(id)) return undefined;
    const raw = await this.vault.get(`${PREFIX}${id}`);
    if (!raw) return undefined;
    try {
      const v = JSON.parse(raw) as Stored;
      return typeof v.origin === "string" && typeof v.password === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  /** Keep a site login (https only). Returns its id. */
  async save(o: {
    origin: string;
    password: string;
    username?: string;
    label?: string;
    botIds?: string[];
  }): Promise<string> {
    const origin = httpsOrigin(o.origin);
    if (!origin) throw new Error("只能存 HTTPS 網站的登入");
    if (!o.password) throw new Error("需要密碼");
    const id = `login_${randomBytes(6).toString("hex")}`;
    const v: Stored = {
      origin,
      password: o.password,
      ...(o.username ? { username: o.username } : {}),
      ...(o.label ? { label: o.label.slice(0, 80) } : {}),
      ...(o.botIds?.length ? { botIds: [...o.botIds] } : {}),
    };
    await this.vault.set(`${PREFIX}${id}`, JSON.stringify(v));
    return id;
  }

  async remove(id: string): Promise<void> {
    await this.vault.delete(`${PREFIX}${id}`);
  }

  /** Every login (without passwords). */
  async all(): Promise<SiteLogin[]> {
    const out: SiteLogin[] = [];
    for (const name of await this.vault.names()) {
      if (!name.startsWith(PREFIX)) continue;
      const id = name.slice(PREFIX.length);
      const e = await this.entry(id);
      if (!e) continue;
      const { password: _p, ...rest } = e;
      out.push({ id, ...rest });
    }
    return out;
  }

  private allowed(e: Stored, botId: string, origin: string): boolean {
    const o = httpsOrigin(origin);
    return !!o && o === e.origin && (!e.botIds?.length || e.botIds.includes(botId));
  }

  /** SecretSource: the password for this bot on exactly this https origin; undefined otherwise. */
  async value(botId: string, secretId: string, origin: string): Promise<string | undefined> {
    const e = await this.entry(secretId);
    return e && this.allowed(e, botId, origin) ? e.password : undefined;
  }

  /** SecretSource: the logins usable on this origin (ids, labels, usernames — never passwords). */
  async list(
    botId: string,
    origin: string,
  ): Promise<Array<{ secretId: string; label: string; username?: string }>> {
    const out: Array<{ secretId: string; label: string; username?: string }> = [];
    for (const l of await this.all()) {
      const e = await this.entry(l.id);
      if (!e || !this.allowed(e, botId, origin)) continue;
      out.push({
        secretId: l.id,
        label: l.label ?? l.origin,
        ...(l.username ? { username: l.username } : {}),
      });
    }
    return out;
  }
}
