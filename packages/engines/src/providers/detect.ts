import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { LoginCheck, ProviderDef } from "./catalog.ts";

/**
 * Is a provider usable right now (P11)? CLI / ACP: the binary on PATH, its
 * `--version`, and the login checks the catalog gives. API: is there a key
 * in the local vault (or none needed). Never reads a key's value, never
 * prints one: `hasKey` is a yes/no.
 */

export type ProviderStatus = "ready" | "needs_login" | "needs_key" | "not_installed";

export interface Detection {
  status: ProviderStatus;
  /** One line on what to do (install, log in, paste a key), or what it is using. */
  hint: string;
  version?: string;
  path?: string;
  login: "yes" | "no" | "unknown";
}

export interface RunResult {
  code: number | null;
  out: string;
}

export type Runner = (cmd: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>;

export interface DetectContext {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Is there a key for this provider in the vault? */
  hasKey: (providerId: string) => boolean | Promise<boolean>;
  run?: Runner;
}

/** Run a command with a timeout; stdout + stderr, at most 64 KB. Never throws. */
export const runCommand: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch {
      return finish({ code: -1, out: "" });
    }
    const add = (c: Buffer) => {
      if (out.length < 65_536) out += c.toString("utf8");
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, out });
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(t);
      finish({ code: -1, out });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      finish({ code, out });
    });
  });

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where `bin` would run from: an absolute path as is, else the first match on PATH. */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!bin) return undefined;
  if (isAbsolute(bin) || bin.includes("/")) return executable(bin) ? bin : undefined;
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      if (executable(p)) return p;
    }
  }
  return undefined;
}

const expand = (p: string, home: string) => (p.startsWith("~/") ? join(home, p.slice(2)) : p);

async function checkLogin(
  checks: readonly LoginCheck[],
  bin: string,
  ctx: DetectContext,
): Promise<"yes" | "no" | "unknown"> {
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? homedir();
  let definitiveNo = false;
  for (const c of checks) {
    if (c.kind === "env") {
      if (c.names.some((n) => (env[n] ?? "").trim())) return "yes";
      if (c.definitive) definitiveNo = true;
    } else if (c.kind === "files") {
      if (c.paths.some((p) => existsSync(expand(p, home)))) return "yes";
      if (c.definitive) definitiveNo = true;
    } else {
      const r = await (ctx.run ?? runCommand)(bin, c.args, 5000);
      const okText = !c.ok || new RegExp(c.ok, "i").test(r.out);
      if (r.code === 0 && okText) return "yes";
      if (r.code !== null && r.code !== -1) definitiveNo = true;
    }
  }
  return definitiveNo ? "no" : "unknown";
}

export interface DetectOverrides {
  /** The person's own command (binary + args) for a CLI / ACP provider. */
  command?: readonly string[];
  /** A key env var the vault fills for an ACP agent (counts as logged in when the key is set). */
  keyEnv?: string;
}

export async function detectProvider(
  def: ProviderDef,
  ctx: DetectContext,
  o: DetectOverrides = {},
): Promise<Detection> {
  if (def.kind === "api") {
    const has = await ctx.hasKey(def.id);
    if (def.keyRequired !== false && !has)
      return {
        status: "needs_key",
        hint: def.keyUrl ? `貼上 API key（到 ${new URL(def.keyUrl).host} 申請）` : "貼上 API key",
        login: "no",
      };
    return {
      status: "ready",
      hint: def.keyRequired === false ? `本機服務：請先開著 ${def.label}` : "金鑰已存在這台電腦",
      login: "yes",
    };
  }
  const bin = o.command?.[0] ?? def.binary ?? "";
  const path = findOnPath(bin, ctx.env ?? process.env);
  if (!path)
    return {
      status: "not_installed",
      hint: def.installHint ? `安裝：${def.installHint}` : `找不到 ${bin || "指令"}`,
      login: "unknown",
    };
  const v = await (ctx.run ?? runCommand)(path, ["--version"], 5000);
  const version =
    v.code === 0
      ? v.out
          .split("\n")
          .map((l) => l.trim())
          .find(Boolean)
          ?.slice(0, 60)
      : undefined;
  const keyed = o.keyEnv ? await ctx.hasKey(def.id) : false;
  const login = keyed ? "yes" : await checkLogin(def.login ?? [], path, ctx);
  if (login === "no")
    return {
      status: "needs_login",
      hint: def.loginHint ?? `請先登入 ${def.label}`,
      login,
      path,
      ...(version ? { version } : {}),
    };
  return {
    status: "ready",
    hint:
      login === "yes"
        ? `已登入${version ? ` · ${version}` : ""}`
        : `${version ?? "已安裝"}${def.loginHint ? `；若要求登入：${def.loginHint}` : ""}`,
    login,
    path,
    ...(version ? { version } : {}),
  };
}
