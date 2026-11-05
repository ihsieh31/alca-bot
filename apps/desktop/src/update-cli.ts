// `alca update` (Phase E): check, install (only after the person says yes), roll back.
//
//   alca update check   [--json] [--channel stable|prerelease]
//   alca update install [--version <tag>] [--tarball <file> [--sha256 <hex>]] [--yes] [--no-restart]
//                       [--allow-downgrade] [--channel …]
//   alca update rollback [--yes] [--no-restart]
//   alca update status  [--json]
//
// Nothing is installed without a yes on the terminal (or --yes): the hourly check only
// notifies (設定 → 關於, the log). See docs/RELEASE.md for the trust model.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { loadSettingsFile } from "@alca/config";
import { defaultDataDir } from "./data-dir.ts";
import {
  defaultSpec,
  LABEL,
  type Runner,
  realRunner,
  type ServiceSpec,
  SYSTEMD_UNIT,
  status,
  unitPath,
  WINDOWS_TASK,
} from "./service.ts";
import {
  applyUpdate,
  detectLayout,
  type Layout,
  notOwnedText,
  readState,
  rollback,
  type ServiceControl,
  stage,
} from "./update-install.ts";
import {
  bareVersion,
  type Channel,
  compareVersions,
  githubSource,
  pickLatest,
  type ReleaseInfo,
  type ReleaseSource,
  UpdateError,
} from "./update-release.ts";
import { checkAsset, loadReleaseKeys, modeText, SIG_FILE, SUMS_FILE } from "./update-verify.ts";

const USAGE = `用法：
  alca update check [--json] [--channel stable|prerelease]
  alca update install [--version <tag>] [--tarball <檔案> [--sha256 <檢查碼>]] [--yes] [--no-restart] [--allow-downgrade]
  alca update rollback [--yes] [--no-restart]
  alca update status [--json]`;

const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);

/** The background service `alca service install` made, stopped and started in place (its unit is not rewritten). */
export function serviceControl(spec: ServiceSpec, run: Runner = realRunner): ServiceControl {
  return {
    installed: () => existsSync(unitPath(spec)) || (spec.platform === "win32" && status(spec, run).installed),
    stop: () => {
      if (spec.platform === "darwin") run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
      else if (spec.platform === "linux") run("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
      else run("schtasks", ["/End", "/TN", WINDOWS_TASK]);
    },
    start: () => {
      if (spec.platform === "darwin") {
        run("launchctl", ["bootstrap", `gui/${uid()}`, unitPath(spec)]);
        run("launchctl", ["kickstart", "-k", `gui/${uid()}/${LABEL}`]);
      } else if (spec.platform === "linux") run("systemctl", ["--user", "start", SYSTEMD_UNIT]);
      else run("schtasks", ["/Run", "/TN", WINDOWS_TASK]);
    },
  };
}

export async function probeHealth(port: number, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function waitHealthy(
  probe: () => Promise<boolean>,
  timeoutMs = 30_000,
  stepMs = 500,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function askYes(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise<string>((r) => rl.question(`${question} [y/N] `, r));
  rl.close();
  return /^(y|yes)$/i.test(a.trim());
}

export interface UpdateCliDeps {
  layout?: Layout;
  source?: ReleaseSource;
  service?: ServiceControl;
  probe?: () => Promise<boolean>;
  confirm?: (q: string) => Promise<boolean>;
  healthTimeoutMs?: number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function settingsOf(dataDir: string) {
  const s = loadSettingsFile(join(dataDir, "config.json"), () => undefined);
  return { port: s.engineering.port, channel: s.engineering.updates.channel as Channel };
}

export async function updateCli(argv: string[], d: UpdateCliDeps = {}): Promise<number> {
  const out = d.out ?? ((l: string) => console.log(l));
  const err = d.err ?? ((l: string) => console.error(l));
  const [sub, ...rest] = argv;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        json: { type: "boolean" },
        channel: { type: "string" },
        version: { type: "string" },
        tarball: { type: "string" },
        sha256: { type: "string" },
        yes: { type: "boolean", short: "y" },
        "no-restart": { type: "boolean" },
        "allow-downgrade": { type: "boolean" },
        "data-dir": { type: "string" },
      },
    }));
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    err(USAGE);
    return 2;
  }
  if (!sub || !["check", "install", "rollback", "status"].includes(sub)) {
    out(USAGE);
    return sub ? 2 : 0;
  }
  const dataDir = (values["data-dir"] as string | undefined) ?? defaultDataDir();
  const layout = d.layout ?? detectLayout();
  const cfg = settingsOf(dataDir);
  const channel = ((values.channel as string | undefined) ?? cfg.channel) as Channel;
  if (channel !== "stable" && channel !== "prerelease") {
    err("--channel 只能是 stable 或 prerelease");
    return 2;
  }
  const source = d.source ?? githubSource({ userAgent: `alca/${layout.version}` });
  const probe = d.probe ?? (() => probeHealth(cfg.port));
  const service = d.service ?? serviceControl(defaultSpec({ dataDir }));
  const confirm = d.confirm ?? askYes;
  try {
    if (sub === "status") {
      const st = readState(dataDir);
      if (values.json) out(JSON.stringify({ kind: layout.kind, version: layout.version, ...st }, null, 2));
      else {
        out(`  目前：Alca ${layout.version}（${kindText(layout.kind)}）`);
        if (st.lastCheck)
          out(
            `  上次檢查：${st.lastCheck.at}${st.lastCheck.latest ? `，最新 ${st.lastCheck.latest.tag}` : ""}${st.lastCheck.error ? `（${st.lastCheck.error}）` : ""}`,
          );
        if (st.installed)
          out(
            `  上次更新：${st.installed.from} → ${st.installed.to}（${st.installed.at}；${st.installed.verified}）`,
          );
        if (st.rolledBack)
          out(
            `  上次回滾：${st.rolledBack.from} → ${st.rolledBack.to}（${st.rolledBack.at}${st.rolledBack.auto ? "，自動" : ""}）`,
          );
      }
      return 0;
    }
    if (sub === "rollback") {
      if (layout.kind !== "installed") throw new UpdateError(notOwnedText(layout.kind));
      const st = readState(dataDir);
      if (!st.installed) throw new UpdateError("沒有可以回滾的更新紀錄");
      if (
        !values.yes &&
        !(await confirm(
          `回到 ${st.installed.from}？（目前 ${layout.version}；若資料庫已升級，會還原升級前備份，之後寫入的資料另存一份）`,
        ))
      ) {
        out("沒有回滾（要直接回滾請加 --yes）");
        return 1;
      }
      const r = await rollback({
        layout,
        dataDir,
        service,
        healthy: () => waitHealthy(probe, d.healthTimeoutMs),
        restart: !values["no-restart"],
        log: out,
      });
      out(r.started ? `  已回到 ${r.to}，背景服務已啟動。` : `  已回到 ${r.to}。`);
      return 0;
    }
    if (sub === "check") {
      const latest = pickLatest(await source.list(), channel);
      const newer = !!latest && compareVersions(latest.tag, layout.version) > 0;
      if (values.json) {
        out(
          JSON.stringify(
            {
              current: layout.version,
              kind: layout.kind,
              channel,
              latest: latest ? brief(latest) : null,
              newer,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      if (!latest)
        out(
          `  ${source.repo} 還沒有已發布的${channel === "stable" ? "正式" : ""}版本（草稿不算）。目前 ${layout.version}。`,
        );
      else if (!newer) out(`  已是最新：${layout.version}（最新 ${latest.tag}）。`);
      else {
        out(`  有新版：${latest.tag}（目前 ${layout.version}）`);
        out(`  說明：${latest.htmlUrl}`);
        out(
          layout.kind === "installed"
            ? "  安裝：alca update install（會先問你）"
            : `  ${notOwnedText(layout.kind, latest.htmlUrl)}`,
        );
      }
      return 0;
    }
    return await install(values, { layout, dataDir, channel, source, service, probe, confirm, out, d });
  } catch (e) {
    if (e instanceof UpdateError) {
      err(`更新失敗：${e.message}`);
      return 1;
    }
    throw e;
  }
}

const kindText = (k: Layout["kind"]) =>
  ({ installed: "安裝腳本安裝", bundled: "桌面 App 內建", checkout: "原始碼", unknown: "安裝方式不明" })[k];

const brief = (r: ReleaseInfo) => ({
  tag: r.tag,
  version: r.version,
  url: r.htmlUrl,
  ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
});

async function install(
  values: Record<string, string | boolean | undefined>,
  c: {
    layout: Layout;
    dataDir: string;
    channel: Channel;
    source: ReleaseSource;
    service: ServiceControl;
    probe: () => Promise<boolean>;
    confirm: (q: string) => Promise<boolean>;
    out: (l: string) => void;
    d: UpdateCliDeps;
  },
): Promise<number> {
  const { layout, out } = c;
  if (layout.kind !== "installed" || !layout.prefix) throw new UpdateError(notOwnedText(layout.kind));
  const keys = loadReleaseKeys(layout.appRoot);
  let tarball: string;
  let expect: string | undefined;
  let verified: string;
  const work = join(c.dataDir, "updates");
  if (values.tarball) {
    tarball = values.tarball as string;
    if (!existsSync(tarball)) throw new UpdateError(`找不到 ${tarball}`);
    const near = (f: string) =>
      existsSync(join(dirname(tarball), f)) ? readFileSync(join(dirname(tarball), f)) : undefined;
    const sums = near(SUMS_FILE);
    const sig = near(SIG_FILE);
    const sidecar = existsSync(`${tarball}.sha256`) ? readFileSync(`${tarball}.sha256`, "utf8") : undefined;
    const name = tarball.split(/[\\/]/).pop() as string;
    const r = checkAsset({
      file: tarball,
      name,
      keys,
      ...(sums ? { sums } : {}),
      ...(sig ? { sig } : {}),
      ...(sidecar ? { sidecar } : {}),
      ...(values.sha256 ? { expected: values.sha256 as string } : {}),
    });
    verified = modeText(r.mode);
    expect = values.version as string | undefined;
  } else {
    const all = await c.source.list();
    const want = values.version as string | undefined;
    const rel = want
      ? all.find((r) => bareVersion(r.tag) === bareVersion(want) && !r.draft)
      : pickLatest(all, c.channel);
    if (!rel) {
      if (want && all.some((r) => bareVersion(r.tag) === bareVersion(want)))
        throw new UpdateError(`${want} 還是草稿（尚未發布），不能用來更新`);
      throw new UpdateError(want ? `找不到 ${want} 這個 release` : "還沒有已發布的版本（草稿不算）");
    }
    if (!want && compareVersions(rel.tag, layout.version) <= 0) {
      out(`  已是最新：${layout.version}。`);
      return 0;
    }
    const dir = join(work, rel.version);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = [`alca-core-${rel.version}.tar.gz`, "alca-core.tar.gz"].find((n) =>
      rel.assets.some((a) => a.name === n),
    );
    if (!name) throw new UpdateError(`${rel.tag} 沒有核心壓縮檔（alca-core-${rel.version}.tar.gz）`);
    out(`  下載 ${rel.tag}：${name}`);
    tarball = join(dir, name);
    if (!(await c.source.download(rel, name, tarball))) throw new UpdateError(`下載不到 ${name}`);
    const get = async (n: string) =>
      (await c.source.download(rel, n, join(dir, n))) ? readFileSync(join(dir, n)) : undefined;
    const sums = await get(SUMS_FILE);
    const sig = await get(SIG_FILE);
    const sidecar = (await get(`${name}.sha256`))?.toString("utf8");
    const r = checkAsset({
      file: tarball,
      name,
      keys,
      ...(sums ? { sums } : {}),
      ...(sig ? { sig } : {}),
      ...(sidecar ? { sidecar } : {}),
    });
    verified = modeText(r.mode);
    expect = rel.version;
  }
  out(`  ${verified}`);
  const staged = stage({ prefix: layout.prefix, tarball, ...(expect ? { expectVersion: expect } : {}) });
  if (!values["allow-downgrade"] && compareVersions(staged.version, layout.version) <= 0) {
    rmSync(staged.dir, { recursive: true, force: true });
    throw new UpdateError(
      `${staged.version} 沒有比目前的 ${layout.version} 新（要降級請加 --allow-downgrade）`,
    );
  }
  const q = `把 Alca ${layout.version} 更新成 ${staged.version}？會先停止背景服務、備份資料庫，裝好後重新啟動；舊版留著可以 alca update rollback`;
  if (!values.yes && !(await c.confirm(q))) {
    rmSync(staged.dir, { recursive: true, force: true });
    out("沒有更新（要直接更新請加 --yes）");
    return 1;
  }
  const r = await applyUpdate({
    layout,
    dataDir: c.dataDir,
    staged,
    service: c.service,
    healthy: () => waitHealthy(c.probe, c.d.healthTimeoutMs),
    running: c.probe,
    restart: !values["no-restart"],
    allowDowngrade: !!values["allow-downgrade"],
    verified,
    log: out,
  });
  if (r.rolledBack) {
    out(
      `  新版 ${r.to} 沒有起來，已自動回到 ${r.rolledBack.to}。紀錄檔：${join(c.dataDir, "logs", "core.log")}`,
    );
    return 1;
  }
  out(
    r.started
      ? `  已更新到 ${r.to}，背景服務已重新啟動。`
      : `  已更新到 ${r.to}。請重新啟動 Alca（alca start 或 alca service install）。`,
  );
  return 0;
}
