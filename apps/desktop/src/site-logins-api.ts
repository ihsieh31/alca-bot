import { httpsOrigin, type SiteLogin, SiteLogins } from "@alca/connectors";
import type { AlcaCore } from "@alca/core";
import { tSource } from "@alca/design/i18n";
import type { SecretStore } from "@alca/os";
import { appendAudit } from "@alca/store";
import { ConnectorsApiError } from "./connectors-api.ts";
import { log } from "./log.ts";

/**
 * Design §0.2.7: the way in for website passwords (`SiteLogins` in the
 * vault — the one `SecretStore`). The desktop window saves and removes (both
 * need the approve key); the phone lists and removes, never adds (a password
 * never travels the relay). Nothing here returns, logs or audits a password:
 * the audit row has the login's id, origin and username only.
 */

export const LOGIN_LIMITS = { password: 1024, username: 200, label: 80, botIds: 50 } as const;

const DESKTOP = { kind: "user" as const, id: "desktop" };

export interface SiteLoginView extends SiteLogin {
  bots: Array<{ id: string; name: string }>;
}

export class SiteLoginsApi {
  private readonly logins: SiteLogins;
  private readonly core: AlcaCore;

  constructor(vault: SecretStore, core: AlcaCore) {
    this.logins = new SiteLogins(vault);
    this.core = core;
  }

  async list(): Promise<SiteLoginView[]> {
    const bots = this.core.store.bots.list();
    const name = (id: string) => bots.find((b) => b.id === id)?.name ?? id;
    return (await this.logins.all())
      .sort((a, b) => a.origin.localeCompare(b.origin))
      .map((l) => ({ ...l, bots: (l.botIds ?? []).map((id) => ({ id, name: name(id) })) }));
  }

  async save(body: Record<string, unknown>): Promise<SiteLoginView[]> {
    const origin = typeof body.origin === "string" ? httpsOrigin(body.origin.trim()) : undefined;
    if (!origin) throw new ConnectorsApiError(400, tSource("core.siteLogins.https"));
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || password.length > LOGIN_LIMITS.password)
      throw new ConnectorsApiError(400, tSource("core.siteLogins.password", { max: LOGIN_LIMITS.password }));
    const username = typeof body.username === "string" ? body.username.trim() : "";
    if (username.length > LOGIN_LIMITS.username)
      throw new ConnectorsApiError(400, tSource("core.siteLogins.username", { max: LOGIN_LIMITS.username }));
    const label = typeof body.label === "string" ? body.label.trim().slice(0, LOGIN_LIMITS.label) : "";
    const raw = Array.isArray(body.botIds) ? body.botIds : [];
    if (raw.length > LOGIN_LIMITS.botIds)
      throw new ConnectorsApiError(400, tSource("core.siteLogins.tooManyBots"));
    const known = new Set(this.core.store.bots.list().map((b) => b.id));
    const botIds = [...new Set(raw.filter((x): x is string => typeof x === "string"))];
    const unknown = botIds.find((id) => !known.has(id));
    if (unknown) throw new ConnectorsApiError(400, tSource("core.siteLogins.unknownBot", { id: unknown }));
    const id = await this.logins.save({
      origin,
      password,
      ...(username ? { username } : {}),
      ...(label ? { label } : {}),
      ...(botIds.length ? { botIds } : {}),
    });
    this.audit("site_login.saved", id, { origin, ...(username ? { username } : {}), bots: botIds.length });
    log.info(`site login saved ${id} for ${origin}`);
    return this.list();
  }

  async remove(id: string): Promise<SiteLoginView[]> {
    const had = (await this.logins.all()).find((l) => l.id === id);
    if (!had) throw new ConnectorsApiError(404, tSource("core.siteLogins.notFound"));
    await this.logins.remove(id);
    this.audit("site_login.removed", id, { origin: had.origin });
    log.info(`site login removed ${id} for ${had.origin}`);
    return this.list();
  }

  private audit(action: string, id: string, detail: Record<string, unknown>): void {
    appendAudit(this.core.store.db, {
      ts: new Date().toISOString(),
      initiator: DESKTOP,
      actor: DESKTOP,
      action,
      actionClass: "write",
      target: id,
      decision: "allow",
      detail,
    });
  }
}
