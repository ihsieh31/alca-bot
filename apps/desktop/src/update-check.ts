// Phase E: the core looks for a newer release at most once a day, from the agents sweep's
// hourly slot (no timer of its own), and only tells: a log line once per new version, and
// 設定 → 關於 (GET /api/settings/about → update). Installing is `alca update install` on the
// terminal, after a yes. `engineering.updates.check: "off"` makes no request at all.
import type { Upkeep } from "@alca/store";
import {
  detectLayout,
  type Layout,
  notOwnedText,
  readState,
  type UpdateState,
  writeState,
} from "./update-install.ts";
import {
  type Channel,
  compareVersions,
  githubSource,
  pickLatest,
  type ReleaseSource,
} from "./update-release.ts";

export const CHECK_EVERY_MS = 24 * 3600_000;

export interface UpdateSettings {
  check: "notify" | "off";
  channel: Channel;
}

export interface UpdateView {
  check: "notify" | "off";
  channel: Channel;
  kind: Layout["kind"];
  current: string;
  lastCheck?: UpdateState["lastCheck"];
  /** Set when lastCheck found a newer version: what to do about it. */
  action?: string;
  rolledBack?: UpdateState["rolledBack"];
}

export class UpdateChecker {
  private readonly o: {
    dataDir: string;
    settings: () => UpdateSettings;
    layout?: Layout;
    source?: ReleaseSource;
    log?: (level: "info" | "warn", line: string) => void;
  };
  private readonly layout: Layout;
  private source: ReleaseSource | undefined;
  private inFlight: Promise<NonNullable<UpdateState["lastCheck"]>> | undefined;
  private told = "";

  constructor(o: UpdateChecker["o"]) {
    this.o = o;
    this.layout = o.layout ?? detectLayout();
    this.source = o.source;
  }

  private src(): ReleaseSource {
    this.source ??= githubSource({ userAgent: `alca/${this.layout.version}` });
    return this.source;
  }

  view(): UpdateView {
    const s = this.o.settings();
    const st = readState(this.o.dataDir);
    const lc = st.lastCheck && st.lastCheck.current === this.layout.version ? st.lastCheck : undefined;
    return {
      check: s.check,
      channel: s.channel,
      kind: this.layout.kind,
      current: this.layout.version,
      ...(lc ? { lastCheck: lc } : {}),
      ...(lc?.newer && lc.latest
        ? {
            action:
              this.layout.kind === "installed"
                ? "在終端機執行 alca update install（會先問你；裝之前會備份資料庫）"
                : notOwnedText(this.layout.kind, lc.latest.url),
          }
        : {}),
      ...(st.rolledBack ? { rolledBack: st.rolledBack } : {}),
    };
  }

  /** 檢查更新 (the button), and the daily check. One request at a time. */
  checkNow(now = new Date()): Promise<NonNullable<UpdateState["lastCheck"]>> {
    this.inFlight ??= this.run(now).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(now: Date): Promise<NonNullable<UpdateState["lastCheck"]>> {
    const current = this.layout.version;
    let lc: NonNullable<UpdateState["lastCheck"]>;
    try {
      const latest = pickLatest(await this.src().list(), this.o.settings().channel);
      const newer = !!latest && compareVersions(latest.tag, current) > 0;
      lc = {
        at: now.toISOString(),
        current,
        newer,
        ...(latest
          ? {
              latest: {
                tag: latest.tag,
                version: latest.version,
                url: latest.htmlUrl,
                ...(latest.publishedAt ? { publishedAt: latest.publishedAt } : {}),
              },
            }
          : {}),
      };
      if (newer && latest && this.told !== latest.tag) {
        this.told = latest.tag;
        this.o.log?.(
          "info",
          `有新版 Alca ${latest.tag}（目前 ${current}）：${this.view().action ?? latest.htmlUrl}`,
        );
      }
    } catch (e) {
      lc = {
        at: now.toISOString(),
        current,
        newer: false,
        error: e instanceof Error ? e.message : String(e),
      };
      this.o.log?.("warn", `檢查更新失敗：${lc.error}`);
    }
    writeState(this.o.dataDir, { ...readState(this.o.dataDir), lastCheck: lc });
    return lc;
  }

  /** From the hourly slot: at most once a day, never when switched off. */
  tick(now: Date): void {
    if (this.o.settings().check !== "notify" || this.inFlight) return;
    const last = readState(this.o.dataDir).lastCheck;
    if (last && last.current === this.layout.version && now.getTime() - Date.parse(last.at) < CHECK_EVERY_MS)
      return;
    void this.checkNow(now);
  }
}

/** Run the update check after the data steps of each hourly slot (the existing clock, no new timer). */
export function attachUpdateCheck(upkeep: Upkeep, checker: UpdateChecker): void {
  const hourly = upkeep.hourly.bind(upkeep);
  upkeep.hourly = (now: Date) => {
    const r = hourly(now);
    try {
      checker.tick(now);
    } catch {
      // the check reports its own failures; it never fails the sweep
    }
    return r;
  };
}
