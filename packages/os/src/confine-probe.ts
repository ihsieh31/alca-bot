import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type ConfinerKind, type ConfineSpec, confinedCommand, SANDBOX_EXEC } from "./confine.ts";
import { realOrResolved } from "./confine-paths.ts";

/**
 * Next-round §5.3: is a sandbox usable on this machine? Asked once at start
 * (cached), shown in settings and on the worker panel. A probe never throws:
 * a confiner that cannot prove it works is reported unusable with a reason.
 */

export interface ConfineProbe {
  kind: ConfinerKind;
  ok: boolean;
  reason?: string;
  version?: string;
}

/** How the probe runs a program (tests swap it). */
export type ProbeRunner = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; out: string }>;

const run: ProbeRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err
        ? typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : 1
        : 0;
      resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });

/** A program on PATH (or undefined). */
export function onPath(name: string, path = process.env.PATH ?? ""): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // next
    }
  }
  return undefined;
}

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  run?: ProbeRunner;
  /** Skip the write test with a real profile (unit tests of the decision only). */
  shallow?: boolean;
  /** Where the AppArmor switch is read (tests). */
  apparmorFile?: string;
  path?: string;
}

/** Ubuntu 24.04+: unprivileged user namespaces need an AppArmor profile (bubblewrap fails without one). */
function apparmorBlocks(file = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"): boolean {
  try {
    return readFileSync(file, "utf8").trim() === "1";
  } catch {
    return false;
  }
}

export const APPARMOR_HELP =
  "Ubuntu 的 AppArmor 限制了非特權 user namespace（kernel.apparmor_restrict_unprivileged_userns=1）。解法二選一：為 bwrap 加一個 AppArmor profile（/etc/apparmor.d/bwrap，內容 `abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, }`，再 `sudo apparmor_parser -r /etc/apparmor.d/bwrap`），或 `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`（全系統放寬，較不建議）。";

/**
 * The write test with a real profile: inside the sandbox a file in the
 * work folder can be created and one outside it cannot.
 */
async function writeTest(kind: "seatbelt" | "bwrap", r: ProbeRunner): Promise<string | undefined> {
  const base = realOrResolved(mkdtempSync(join(tmpdir(), "alca-confine-probe-")));
  try {
    const work = join(base, "work");
    const tmp = join(base, "tmp");
    const outside = join(base, "outside");
    for (const d of [work, tmp, outside]) mkdirSync(d, { recursive: true });
    const spec: ConfineSpec = {
      kind,
      workDir: work,
      tmpDir: tmp,
      extraWritable: [],
      denyRead: [],
      denyWriteInside: [],
      network: "open",
    };
    const c = confinedCommand(spec, "/bin/sh", [
      "-c",
      `touch "${work}/in" && { touch "${outside}/out" 2>/dev/null && echo LEAK || echo HELD; }`,
    ]);
    const res = await r(c.file, c.args, 10_000);
    if (res.code !== 0) return `沙箱內無法執行指令（${res.out.trim().slice(0, 200) || `exit ${res.code}`}）`;
    if (res.out.includes("LEAK")) return "沙箱沒有擋住工作資料夾外的寫入";
    if (!res.out.includes("HELD")) return `沙箱測試沒有結果（${res.out.trim().slice(0, 200)}）`;
    return undefined;
  } finally {
    rmSync(base, { force: true, recursive: true });
  }
}

export async function probeConfiner(o: ProbeOptions = {}): Promise<ConfineProbe> {
  const platform = o.platform ?? process.platform;
  const r = o.run ?? run;
  try {
    if (platform === "darwin") {
      try {
        accessSync(SANDBOX_EXEC, constants.X_OK);
      } catch {
        return { kind: "seatbelt", ok: false, reason: `找不到 ${SANDBOX_EXEC}` };
      }
      const t = await r(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], 5000);
      if (t.code !== 0)
        return {
          kind: "seatbelt",
          ok: false,
          reason: `sandbox-exec 無法啟動（${t.out.trim().slice(0, 200)}）`,
        };
      if (!o.shallow) {
        const bad = await writeTest("seatbelt", r);
        if (bad) return { kind: "seatbelt", ok: false, reason: bad };
      }
      return { kind: "seatbelt", ok: true };
    }
    if (platform === "linux") {
      const bin = onPath("bwrap", o.path);
      if (!bin) return { kind: "bwrap", ok: false, reason: "沒有安裝 bubblewrap（bwrap）" };
      const v = await r("bwrap", ["--version"], 5000);
      const version = v.out.trim().replace(/^bubblewrap\s+/i, "") || undefined;
      const t = await r(
        "bwrap",
        ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "/bin/true"],
        5000,
      );
      if (t.code !== 0) {
        const aa = apparmorBlocks(o.apparmorFile);
        return {
          kind: "bwrap",
          ok: false,
          reason: aa
            ? `apparmor userns：${APPARMOR_HELP}`
            : `bwrap 無法啟動（${t.out.trim().slice(0, 200)}）`,
          ...(version ? { version } : {}),
        };
      }
      if (!o.shallow) {
        const bad = await writeTest("bwrap", r);
        if (bad) return { kind: "bwrap", ok: false, reason: bad, ...(version ? { version } : {}) };
      }
      return { kind: "bwrap", ok: true, ...(version ? { version } : {}) };
    }
    return { kind: "none", ok: false, reason: "這個作業系統還沒有支援的沙箱（Windows 列入後續）" };
  } catch (err) {
    return {
      kind: platform === "darwin" ? "seatbelt" : platform === "linux" ? "bwrap" : "none",
      ok: false,
      reason: `探測失敗：${String((err as Error)?.message ?? err).slice(0, 200)}`,
    };
  }
}

let cached: Promise<ConfineProbe> | undefined;

/** The probe, once per process. */
export function probeConfinerOnce(): Promise<ConfineProbe> {
  cached ??= probeConfiner();
  return cached;
}
