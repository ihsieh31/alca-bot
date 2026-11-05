import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RpcError } from "@alca/link";

/**
 * The hands executor: no state, no credentials, one directory. It answers
 * exactly five operations from its paired core (`hands.info`, `shell`,
 * `read`, `write`, `list`); anything else is refused. The core has already
 * put every call through its policy gateway; this side only enforces what it
 * can check locally: the work directory, sizes, a timeout, a clean env.
 */

export interface ExecutorOptions {
  workdir: string;
  /** Largest output / file returned, in bytes. */
  maxOutput?: number;
  /** Extra env names passed to commands besides PATH / LANG (default none). */
  passEnv?: string[];
}

const MAX_FILE_WRITE = 2 * 1024 * 1024;

export class HandsExecutor {
  readonly root: string;
  private readonly maxOutput: number;
  private readonly passEnv: string[];

  constructor(o: ExecutorOptions) {
    mkdirSync(o.workdir, { recursive: true });
    this.root = realpathSync(resolve(o.workdir));
    this.maxOutput = o.maxOutput ?? 64 * 1024;
    this.passEnv = o.passEnv ?? [];
  }

  /** Resolve a path inside the work directory (symlinks followed) or refuse. */
  inside(p: string, mustExist = true): string {
    if (typeof p !== "string" || p.includes("\0")) throw new RpcError("bad_request", "bad path");
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.root, p);
    let real: string;
    try {
      real = mustExist
        ? realpathSync(abs)
        : join(realpathSync(dirname(abs)), abs.slice(dirname(abs).length + 1));
    } catch {
      throw new RpcError("not_found", `找不到 ${p}`);
    }
    const rel = relative(this.root, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new RpcError("forbidden", "路徑在允許的工作資料夾之外");
    return real;
  }

  env(): Record<string, string> {
    const e: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: this.root,
    };
    for (const k of this.passEnv) if (process.env[k] !== undefined) e[k] = process.env[k] as string;
    return e;
  }

  handle = async (op: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (op) {
      case "ping":
        return "pong";
      case "hands.info":
        return {
          workdir: this.root,
          platform: `${osPlatform()} ${process.arch}`,
          ops: ["shell", "read", "write", "list"],
        };
      case "shell":
        return this.shell(String(args.command ?? ""), Number(args.timeoutSec) || 60);
      case "read": {
        const f = this.inside(String(args.path ?? ""));
        const st = statSync(f);
        if (!st.isFile()) throw new RpcError("bad_request", "不是檔案");
        if (st.size > this.maxOutput) throw new RpcError("too_big", `檔案超過 ${this.maxOutput} bytes`);
        return { text: readFileSync(f, "utf8"), bytes: st.size };
      }
      case "write": {
        const content = String(args.content ?? "");
        if (Buffer.byteLength(content) > MAX_FILE_WRITE) throw new RpcError("too_big", "內容太大");
        const f = this.inside(String(args.path ?? ""), false);
        writeFileSync(f, content);
        return { written: relative(this.root, f), bytes: Buffer.byteLength(content) };
      }
      case "list": {
        const d = this.inside(String(args.path ?? "."));
        return readdirSync(d, { withFileTypes: true })
          .slice(0, 500)
          .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other" }));
      }
      default:
        throw new RpcError("unknown_op", `hands does not do ${op}`);
    }
  };

  private shell(
    command: string,
    timeoutSec: number,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    if (!command.trim()) throw new RpcError("bad_request", "command is required");
    const limit = Math.min(Math.max(timeoutSec, 1), 600) * 1000;
    return new Promise((resolveRun) => {
      // Own process group, so a timeout kills the command's children too.
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: this.root,
        env: this.env(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const take = (into: Buffer[]) => (c: Buffer) => {
        if (size >= this.maxOutput) return;
        size += c.length;
        into.push(c);
      };
      child.stdout.on("data", take(out));
      child.stderr.on("data", take(err));
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, limit);
      child.on("close", (code) => {
        clearTimeout(t);
        const cut = (b: Buffer[]) => Buffer.concat(b).subarray(0, this.maxOutput).toString("utf8");
        resolveRun({ exitCode: code, stdout: cut(out), stderr: cut(err), timedOut });
      });
      child.on("error", () => {
        clearTimeout(t);
        resolveRun({ exitCode: null, stdout: "", stderr: "無法啟動 shell", timedOut: false });
      });
    });
  }
}
