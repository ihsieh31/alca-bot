import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { within } from "./confine-paths.ts";

/**
 * Next-round §5.2: the OS sandbox around commands the model chooses. The
 * only place in the repo that knows how a Seatbelt profile or a bubblewrap
 * command line is put together; `BashSessions.start` is the one caller that
 * runs model commands through it.
 *
 * The goal is narrow on purpose: writes only inside the work folder (plus
 * its temp folder and package caches), Alca's data folder and the home
 * folder's secrets unreadable, the protected engine / tool configuration
 * inside the work folder not writable. Programs still run, read most files
 * and (by default) reach the network; network actions are still classified
 * and carded by the gate, which the sandbox never loosens.
 */

export type ConfinerKind = "seatbelt" | "bwrap" | "none";

export interface ConfineSpec {
  /** Which confiner builds the command (the probe's kind). */
  kind: "seatbelt" | "bwrap";
  /** The work folder, real path (BotWorkDirs.resolve). */
  workDir: string;
  /** The session's temp folder (TMPDIR), real path, 0700. */
  tmpDir: string;
  /** Package caches and folders the bot was given (real paths). */
  extraWritable: string[];
  /** Alca's data folder (except the work and temp folders), other bots' folders, home secrets. */
  denyRead: string[];
  /** Inside the work folder, still not writable: `.git/config`, `.git/hooks`, `.claude`, … */
  denyWriteInside: string[];
  network: "open" | "none";
  /** macOS: connections back to Alca's own API port are refused. */
  corePort?: number;
}

export interface ConfinedCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** A string literal in SBPL (Scheme): backslash and double quote escaped. */
export function sbplString(s: string): string {
  if (s.includes("\0")) throw new Error("path with a NUL byte");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const sub = (p: string) => `(subpath ${sbplString(p)})`;

/**
 * The Seatbelt profile. `(allow default)` as the base and explicit denies on
 * top (a deny-default profile stops zsh 5.9 on macOS 26 reading `hw.*`
 * sysctls, and most build tools with it); in SBPL a later rule wins.
 */
export function seatbeltProfile(spec: ConfineSpec): string {
  const writable = [spec.workDir, spec.tmpDir, ...spec.extraWritable].map(sub);
  const lines = [
    "(version 1)",
    "(allow default)",
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${writable.join(" ")}`,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr")',
    '  (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
  ];
  if (spec.denyWriteInside.length)
    lines.push(`(deny file-write* ${spec.denyWriteInside.map(sub).join(" ")})`);
  if (spec.denyRead.length) lines.push(`(deny file-read* ${spec.denyRead.map(sub).join(" ")})`);
  // The login keychain (securityd): `security find-generic-password` and friends fail.
  lines.push(
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd"))',
  );
  if (spec.corePort)
    lines.push(`(deny network-outbound (remote ip ${sbplString(`localhost:${spec.corePort}`)}))`);
  if (spec.network === "none")
    // IP only: unix sockets (local tools) keep working.
    lines.push(
      '(deny network-outbound (remote ip "*:*"))',
      '(deny network-inbound (local ip "*:*"))',
      '(deny network-bind (local ip "*:*"))',
    );
  return `${lines.join("\n")}\n`;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The bubblewrap arguments (before `--` and the command). The root is
 * read-only; the work and temp folders and the caches are bound writable;
 * protected configuration inside the work folder is bound read-only over
 * itself; a denied folder gets an empty tmpfs over it and a denied file
 * `/dev/null`. bubblewrap can only mount over a path that exists, so missing
 * entries are skipped (the gate's string checks still cover them). No
 * `--new-session`: the session's process group must stay one group for
 * the existing kill-tree cleanup; `--die-with-parent` ends it with Alca.
 */
export function bwrapArgs(spec: ConfineSpec): string[] {
  const a = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const p of [spec.workDir, spec.tmpDir, ...spec.extraWritable])
    if (existsSync(p)) a.push("--bind", p, p);
  for (const p of spec.denyWriteInside) if (existsSync(p)) a.push("--ro-bind", p, p);
  for (const p of spec.denyRead) {
    if (!existsSync(p)) continue;
    // A denied folder that holds the work folder cannot be covered (it would hide it).
    if (within(p, spec.workDir) || within(p, spec.tmpDir)) continue;
    if (isDir(p)) a.push("--tmpfs", p);
    else a.push("--ro-bind", "/dev/null", p);
  }
  if (spec.network === "none") a.push("--unshare-net");
  a.push("--die-with-parent");
  return a;
}

/** The command to spawn instead of `file args` (pure: snapshot-tested). */
export function confinedCommand(spec: ConfineSpec, file: string, args: readonly string[]): ConfinedCommand {
  const env = { TMPDIR: spec.tmpDir, ALCA_SANDBOX: spec.kind };
  if (spec.kind === "seatbelt")
    return { file: SANDBOX_EXEC, args: ["-p", seatbeltProfile(spec), file, ...args], env };
  return { file: "bwrap", args: [...bwrapArgs(spec), "--", file, ...args], env };
}

/** `spawn`, inside the sandbox when a spec is given; without one exactly as before. */
export function spawnConfined(
  spec: ConfineSpec | undefined,
  file: string,
  args: readonly string[],
  o: SpawnOptions,
): ChildProcess {
  if (!spec) return spawn(file, [...args], o);
  const c = confinedCommand(spec, file, args);
  const env = { ...(o.env ?? process.env), ...c.env } as NodeJS.ProcessEnv;
  return spawn(c.file, c.args, { ...o, env });
}

/**
 * Said to the model with a failed command run inside the sandbox, so it does
 * not retry the same write again and again (the loop guard caps it anyway).
 */
export const CONFINE_HINT =
  "（這個指令在沙箱內執行：只允許寫入工作資料夾與暫存資料夾，讀不到 Alca 的資料夾與家目錄的金鑰。需要寫外面請先說明原因，或帶 unsandboxed: true 重試——會請使用者確認。）";

/** A failure that looks like the sandbox refused something (EPERM / read-only / sandbox wording). */
export function looksConfined(output: string): boolean {
  return /Operation not permitted|Read-only file system|Permission denied|deny\(\d+\)|sandbox/i.test(output);
}
