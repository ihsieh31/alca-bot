// The desktop 設定 screen's API (P13 B3). It edits the person-facing part of
// config.json: the simple fields (team approval level, learning, push) and the
// 進階 ones (new devices' default scopes, pairing on / off, a self-hosted
// relay, the log level). `engineering` and the model list are kept as they
// are; payment / send / delete / publish confirmation is not a setting.
import { existsSync, readFileSync } from "node:fs";
import { DeviceScope, parseSettings, type Settings, SettingsError, stripRemovedKeys } from "@alca/config";
import { tSource } from "@alca/design/i18n";
import { writeFileAtomic } from "@alca/os";
import { HttpError } from "./http.ts";
import { type LogLevel, setLogLevel } from "./log.ts";

/** Fields that only take effect at the next start (read once while starting). */
export const RESTART_FIELDS = [
  "devices.allowPairing",
  "devices.defaultScopes",
  "advanced.rendezvousUrl",
] as const;

export interface SettingsView {
  simple: {
    level: Settings["permissions"]["level"];
    learning: boolean;
    pushPreview: Settings["devices"]["pushPreview"];
  };
  advanced: {
    defaultScopes: Settings["devices"]["defaultScopes"];
    allowPairing: boolean;
    rendezvousUrl: string | null;
    logLevel: LogLevel;
    /** 瀏覽器: download Chromium on first use when none is found (applies at once). */
    browserAutoDownload: boolean;
    /** This start ran with --no-browser-download (or without the app's download): the switch does nothing until then. */
    browserAutoDownloadLocked: boolean;
    /** R9.3: the interface language (applies at once: the window reloads). */
    locale: Settings["advanced"]["locale"];
  };
  /** Of RESTART_FIELDS, the ones whose saved value differs from what this process started with. */
  pendingRestart: string[];
  /** The always-confirm classes, for the screen's fixed line (never editable). */
  alwaysConfirm: readonly string[];
}

export interface SettingsApiOptions {
  /** <data>/config.json */
  file: string;
  get: () => Settings;
  set: (s: Settings) => void;
  /** False when this process started with --no-browser-download (tests: unset = false). */
  browserDownload?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function restartValue(s: Settings, f: (typeof RESTART_FIELDS)[number]): string {
  if (f === "devices.allowPairing") return String(s.devices.allowPairing);
  if (f === "devices.defaultScopes") return [...s.devices.defaultScopes].sort().join(",");
  return s.advanced.rendezvousUrl ?? "";
}

export class SettingsApi {
  private readonly o: SettingsApiOptions;
  /** What this process started with, for "重新啟動後生效". */
  private readonly started: Settings;

  constructor(o: SettingsApiOptions) {
    this.o = o;
    this.started = o.get();
  }

  view(): SettingsView {
    const s = this.o.get();
    return {
      simple: {
        level: s.permissions.level,
        learning: s.advanced.learning,
        pushPreview: s.devices.pushPreview,
      },
      advanced: {
        defaultScopes: s.devices.defaultScopes,
        allowPairing: s.devices.allowPairing,
        rendezvousUrl: s.advanced.rendezvousUrl ?? null,
        logLevel: s.advanced.logLevel,
        browserAutoDownload: s.advanced.browserAutoDownload,
        browserAutoDownloadLocked: !this.o.browserDownload,
        locale: s.advanced.locale,
      },
      pendingRestart: RESTART_FIELDS.filter((f) => restartValue(s, f) !== restartValue(this.started, f)),
      alwaysConfirm: ["payment", "send", "delete", "publish"],
    };
  }

  /**
   * Apply a change: `{level?, learning?, pushPreview?, defaultScopes?,
   * allowPairing?, rendezvousUrl? (null clears), logLevel?}`. Anything else is
   * refused. The new file is validated as a whole before it replaces the old.
   */
  patch(body: Record<string, unknown>): SettingsView {
    const allowed = new Set([
      "level",
      "learning",
      "pushPreview",
      "defaultScopes",
      "allowPairing",
      "rendezvousUrl",
      "logLevel",
      "browserAutoDownload",
      "locale",
    ]);
    for (const k of Object.keys(body))
      if (!allowed.has(k)) throw new HttpError(400, tSource("core.common.notEditableHere", { key: k }));
    const raw = this.readRaw();
    const page = (name: string): Record<string, unknown> => {
      const p = raw[name];
      if (isObj(p)) return p;
      const fresh: Record<string, unknown> = {};
      raw[name] = fresh;
      return fresh;
    };
    if ("level" in body) page("permissions").level = body.level;
    if ("learning" in body) page("advanced").learning = body.learning;
    if ("pushPreview" in body) page("devices").pushPreview = body.pushPreview;
    if ("defaultScopes" in body) {
      const scopes = body.defaultScopes;
      if (!Array.isArray(scopes) || !scopes.every((x) => DeviceScope.safeParse(x).success))
        throw new HttpError(400, tSource("core.settings.scopes"));
      page("devices").defaultScopes = [...new Set(scopes)];
    }
    if ("allowPairing" in body) page("devices").allowPairing = body.allowPairing;
    if ("rendezvousUrl" in body) {
      const v = body.rendezvousUrl;
      if (typeof v === "string" && v.trim() && !/^https:\/\//i.test(v.trim()))
        throw new HttpError(400, tSource("core.settings.relayHttps"));
      if (v === null || v === "") delete page("advanced").rendezvousUrl;
      else page("advanced").rendezvousUrl = typeof v === "string" ? v.trim() : v;
    }
    if ("logLevel" in body) page("advanced").logLevel = body.logLevel;
    if ("locale" in body) page("advanced").locale = body.locale;
    if ("browserAutoDownload" in body) {
      // Mac test 2026-11-04b B6: the switch was locked in the window but the API still wrote it.
      if (!this.o.browserDownload) throw new HttpError(409, tSource("core.settings.noBrowserDownload"));
      page("advanced").browserAutoDownload = body.browserAutoDownload;
    }
    let next: Settings;
    try {
      next = parseSettings(raw);
    } catch (e) {
      if (e instanceof SettingsError)
        throw new HttpError(400, tSource("core.settings.invalid", { issues: e.issues.join("; ") }));
      throw e;
    }
    this.writeRaw(raw);
    this.o.set(next);
    setLogLevel(next.advanced.logLevel);
    return this.view();
  }

  /**
   * Next round R1: 設定 › 網路搜尋 writes `engineering.webSearch` (the
   * approve-key check and the key itself live in web-search.ts). The whole
   * file is validated before it replaces the old one.
   */
  setEngineering(key: "webSearch", value: Record<string, unknown>): void {
    const raw = this.readRaw();
    const eng = isObj(raw.engineering) ? raw.engineering : {};
    raw.engineering = { ...eng, [key]: value };
    let next: Settings;
    try {
      next = parseSettings(raw);
    } catch (e) {
      if (e instanceof SettingsError)
        throw new HttpError(400, tSource("core.settings.invalid", { issues: e.issues.join("; ") }));
      throw e;
    }
    this.writeRaw(raw);
    this.o.set(next);
  }

  /** config.json as written (old removed keys dropped); missing = {}. */
  private readRaw(): Record<string, unknown> {
    if (!existsSync(this.o.file)) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.o.file, "utf8"));
    } catch {
      throw new HttpError(409, tSource("core.settings.configNotJson"));
    }
    if (!isObj(raw)) throw new HttpError(409, tSource("core.settings.configNotObject"));
    stripRemovedKeys(raw);
    return raw;
  }

  private writeRaw(raw: Record<string, unknown>): void {
    writeFileAtomic(this.o.file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  }
}
