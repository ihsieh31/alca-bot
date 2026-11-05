import { classifyToolCall } from "@alca/policy";
import type { HostTool } from "@alca/tools";
import { confineBox } from "../../../workspace/sandbox.ts";
import { confine } from "../../../workspace/workdir.ts";
import { type HostToolContext, obj, type ToolEnv } from "./common.ts";

/**
 * Plan §4: `bash` (+ `bash_poll`, `bash_input`, `bash_kill`) on the worker's
 * bash sessions. The command runs in the worker's folder (`workdir` moves it
 * inside, never out); it waits up to `timeoutMs` (120 s by default, up to
 * 10 min) or returns a session at once with `background: true`. A non-zero
 * exit comes back as a structured result (`status`, `exit_code`, the
 * output), never as a tool error; output over 50 KB is cut and kept whole.
 * The gate sees the command: `inspect` classifies it (a publish, send or
 * delete asks at every level; ordinary build / test / format commands in
 * the folder are `write`), and the shell floor applies as to any shell.
 */

const spillFor =
  (env: ToolEnv, ctx: HostToolContext | undefined, title: string) =>
  (full: string): string | undefined =>
    env.spill?.(ctx, title, full);

export function bashTools(env: ToolEnv): HostTool[] {
  return [
    {
      spec: {
        name: "bash",
        description:
          "在工作資料夾執行 shell 指令，等到結束（預設逾時 120 秒，timeoutMs 最多 600000）。要跑很久的用 background: true，立刻拿到 session id，之後用 bash_poll 看。非 0 的 exit code 會照實回報（不是工具錯誤）。用 workdir 取代 cd。不要用 shell 改檔（用 edit／write／apply_patch）。沙箱外執行才帶 unsandboxed（需確認）。",
        inputSchema: obj(
          {
            command: { type: "string" },
            workdir: { type: "string" },
            timeoutMs: { type: "integer", minimum: 1 },
            yieldMs: { type: "integer", minimum: 1 },
            background: { type: "boolean" },
            unsandboxed: { type: "boolean" },
          },
          ["command"],
        ),
      },
      actionClass: "execute",
      inspect: async (a) => ({ actionClass: classifyToolCall("bash", a) }),
      run: async (a, signal, ctx) => {
        const root = env.dir(ctx);
        const cwd = typeof a.workdir === "string" && a.workdir ? confine(root, a.workdir) : root;
        const command = String(a.command ?? "");
        const box = a.unsandboxed === true ? {} : confineBox(env.confine?.(ctx));
        if (box.refuse) throw new Error(box.refuse);
        const r = await env.state(ctx).bash.exec({
          command,
          cwd,
          signal,
          ...(box.spec ? { confine: box.spec } : {}),
          ...(typeof a.timeoutMs === "number" ? { timeoutMs: a.timeoutMs } : {}),
          ...(typeof a.yieldMs === "number" ? { yieldMs: a.yieldMs } : {}),
          ...(a.background === true ? { background: true } : {}),
          spill: spillFor(env, ctx, `bash：${command.slice(0, 60)}`),
        });
        return r.text;
      },
    },
    {
      spec: {
        name: "bash_poll",
        description:
          "看一個 bash session 的新輸出（預設等 5 秒，yieldMs 最多 300000）；可送 signal INT／TERM／KILL。",
        inputSchema: obj(
          {
            sessionId: { type: "integer" },
            yieldMs: { type: "integer", minimum: 1 },
            signal: { type: "string", enum: ["INT", "TERM", "KILL"] },
          },
          ["sessionId"],
        ),
      },
      actionClass: "read",
      run: async (a, _s, ctx) =>
        (
          await env.state(ctx).bash.poll({
            sessionId: Number(a.sessionId),
            ...(typeof a.yieldMs === "number" ? { yieldMs: a.yieldMs } : {}),
            ...(typeof a.signal === "string" ? { signal: a.signal as "INT" } : {}),
            spill: spillFor(env, ctx, `bash session ${String(a.sessionId)}`),
          })
        ).text,
    },
    {
      spec: {
        name: "bash_input",
        description: "寫入一個 bash session 的 stdin（原樣送出，可含 \\u0003 等控制字元），再回傳新輸出。",
        inputSchema: obj({ sessionId: { type: "integer" }, input: { type: "string" } }, [
          "sessionId",
          "input",
        ]),
      },
      actionClass: "execute",
      // What goes into a running shell's stdin is a command line like any other.
      inspect: async (a) => ({ actionClass: classifyToolCall("bash_input", a) }),
      run: async (a, _s, ctx) =>
        (await env.state(ctx).bash.poll({ sessionId: Number(a.sessionId), input: String(a.input ?? "") }))
          .text,
    },
    {
      spec: {
        name: "bash_kill",
        description: "結束一個 bash session（整個程序樹）。",
        inputSchema: obj({ sessionId: { type: "integer" } }, ["sessionId"]),
      },
      actionClass: "execute",
      run: async (a, _s, ctx) => env.state(ctx).bash.kill(Number(a.sessionId)),
    },
  ];
}
