import variant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSSyncVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

/**
 * Plan §5: the JavaScript sandbox behind `browser_script`.
 * A WASM QuickJS interpreter inside the harness process; every call gets a
 * new runtime and context and destroys them at the end. The only host
 * functions are `__step(json) → Promise<json>` and `__log(str)`: no network,
 * files, modules, process or timers. Steps, memory, stack, wall time, the
 * returned value and the log all have hard limits.
 */

export const SANDBOX_LIMITS = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  steps: 200,
  valueBytes: 65_536,
  logEntries: 100,
  logChars: 8_000,
  scriptChars: 20_000,
  timeoutMinMs: 1_000,
  timeoutDefaultMs: 60_000,
  timeoutMaxMs: 120_000,
  stepTimeoutMaxMs: 30_000,
  errorChars: 2_000,
} as const;

export type SandboxStatus =
  | "completed"
  | "failed"
  | "timeout"
  | "step_limit"
  | "user_control"
  | "tab_closed"
  | "dialog";

export interface SandboxResult {
  status: SandboxStatus;
  value?: unknown;
  error?: string;
  steps: number;
  log: string[];
}

/** A host step that must end the script at once with this status (the person took control, the tab closed…). */
export class SandboxStop extends Error {
  readonly status: Exclude<SandboxStatus, "completed" | "failed" | "timeout" | "step_limit">;
  constructor(
    status: Exclude<SandboxStatus, "completed" | "failed" | "timeout" | "step_limit">,
    message: string,
  ) {
    super(message);
    this.status = status;
  }
}

export interface SandboxStepRequest {
  action: string;
  [k: string]: unknown;
}

export interface SandboxOptions {
  script: string;
  timeoutMs?: number;
  /** Runs one step; the deadline is the step's own (≤ 30 s and ≤ the time left). */
  step(
    req: SandboxStepRequest,
    ctx: { index: number; deadline: number; signal: AbortSignal },
  ): Promise<unknown>;
  signal?: AbortSignal;
  /** Errors and log lines pass through this before they leave (secret values, tokens). */
  redact?: (s: string) => string;
}

let modulePromise: Promise<QuickJSWASMModule> | undefined;
const quickjs = () => {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant as unknown as QuickJSSyncVariant);
  return modulePromise;
};

/** The helpers the script sees; each becomes one `__step`. */
const PRELUDE = `
const __call = async (action, args) => {
  const r = JSON.parse(await __step(JSON.stringify(Object.assign({ action }, args || {}))));
  if (r && r.error) throw new Error(r.error);
  return r ? r.value : undefined;
};
const css = (selector, nth) => ({ css: String(selector), nth: Number(nth) || 0 });
const role = (role, name, exact) => ({ role: String(role), name: name === undefined ? undefined : String(name), exact: !!exact });
const text = (t, exact) => ({ text: String(t), exact: !!exact });
const navigate = (u) => __call("navigate", typeof u === "string" ? { url: u } : u);
const click = (target, opts) => __call("click", Object.assign({ target }, opts || {}));
const type = (target, value, opts) => __call("type", Object.assign({ target, text: String(value) }, opts || {}));
const press = (key, target) => __call("press", { key: String(key), target });
const hover = (target) => __call("hover", { target });
const scroll = (dy, target) => __call("scroll", { dy: Number(dy) || 0, target });
const selectOption = (target, values) => __call("select_option", { target, values: [].concat(values).map(String) });
const setChecked = (target, checked) => __call("set_checked", { target, checked: !!checked });
const waitFor = (w, opts) => __call("wait_for", Object.assign(
  typeof w === "function" ? { fn: String(w) } : typeof w === "string" ? { text: w } : Object.assign({}, w), opts || {}));
const evaluate = () => { throw new Error("evaluate 不支援：腳本不能在頁面裡執行 JavaScript"); };
const snapshot = () => __call("snapshot", {});
const step = (o) => __call(o && o.action, o);
const sleep = (ms) => __call("sleep", { ms: Number(ms) || 0 });
const log = (...a) => __log(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
`;

const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");

export async function runSandbox(o: SandboxOptions): Promise<SandboxResult> {
  const redact = o.redact ?? ((s: string) => s);
  const L = SANDBOX_LIMITS;
  const log: string[] = [];
  let logChars = 0;
  if (o.script.length > L.scriptChars)
    return { status: "failed", error: `script 超過 ${L.scriptChars} 字元`, steps: 0, log };
  const timeoutMs = Math.min(
    L.timeoutMaxMs,
    Math.max(L.timeoutMinMs, Math.floor(o.timeoutMs ?? L.timeoutDefaultMs)),
  );
  const deadline = Date.now() + timeoutMs;
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  o.signal?.addEventListener("abort", onOuter, { once: true });
  if (o.signal?.aborted) ctrl.abort();

  const QJS = await quickjs();
  const rt = QJS.newRuntime();
  rt.setMemoryLimit(L.memoryBytes);
  rt.setMaxStackSize(L.stackBytes);
  rt.setInterruptHandler(() => Date.now() > deadline || ctrl.signal.aborted);
  const vm = rt.newContext();

  let steps = 0;
  let closed = false;
  const deferreds = new Set<{ alive: boolean; dispose(): void }>();
  let stop: { status: SandboxStatus; error: string } | undefined;
  const pending = new Set<Promise<void>>();
  let wake: (() => void) | undefined;
  const nudge = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };

  try {
    const logFn = vm.newFunction("__log", (h) => {
      const s = redact(String(vm.getString(h)));
      if (log.length < L.logEntries && logChars + s.length <= L.logChars) {
        log.push(s);
        logChars += s.length;
      }
    });
    vm.setProp(vm.global, "__log", logFn);
    logFn.dispose();

    const stepFn = vm.newFunction("__step", (h) => {
      const raw = String(vm.getString(h));
      const d = vm.newPromise();
      deferreds.add(d);
      const index = steps++;
      const settle = (json: string, ok: boolean) => {
        if (closed || !d.alive) return;
        deferreds.delete(d);
        const s = vm.newString(json);
        if (ok) d.resolve(s);
        else d.reject(s);
        s.dispose();
        d.dispose();
        rt.executePendingJobs();
      };
      if (index >= L.steps || stop) {
        // Over the limit (or already ended): the step never settles and the driver ends the script.
        stop ??= { status: "step_limit", error: `步驟超過上限 ${L.steps}` };
        nudge();
      } else {
        let req: SandboxStepRequest | undefined;
        try {
          const v = JSON.parse(raw) as unknown;
          if (typeof v === "object" && v !== null && typeof (v as { action?: unknown }).action === "string")
            req = v as SandboxStepRequest;
        } catch {
          req = undefined;
        }
        const stepDeadline = Math.min(deadline, Date.now() + L.stepTimeoutMaxMs);
        const p = (async () => {
          if (!req) return settle(JSON.stringify({ error: "步驟格式錯誤" }), true);
          try {
            const value = await o.step(req, { index, deadline: stepDeadline, signal: ctrl.signal });
            settle(JSON.stringify({ value: value ?? null }), true);
          } catch (err) {
            if (err instanceof SandboxStop) {
              stop ??= { status: err.status, error: redact(err.message).slice(0, L.errorChars) };
              settle(JSON.stringify({ error: err.status }), true);
            } else
              settle(
                JSON.stringify({ error: redact(String((err as Error)?.message ?? err)).slice(0, 500) }),
                true,
              );
          }
        })();
        pending.add(p);
        void p.finally(() => {
          pending.delete(p);
          nudge();
        });
      }
      return d.handle;
    });
    vm.setProp(vm.global, "__step", stepFn);
    stepFn.dispose();

    let outcome: { ok: true; json: string } | { ok: false; error: string } | undefined;
    const finishFn = vm.newFunction("__finish", (h) => {
      if (outcome) return;
      try {
        const r = JSON.parse(String(vm.getString(h))) as { ok: boolean; json?: string; error?: string };
        outcome = r.ok ? { ok: true, json: r.json ?? "null" } : { ok: false, error: r.error ?? "錯誤" };
      } catch {
        outcome = { ok: false, error: "結果格式錯誤" };
      }
      nudge();
    });
    vm.setProp(vm.global, "__finish", finishFn);
    finishFn.dispose();

    const wrapped = `(async () => {\n${PRELUDE}\n${o.script}\n})().then(
  (v) => { let j; try { j = JSON.stringify(v === undefined ? null : v); } catch (e) { __finish(JSON.stringify({ ok: false, error: "回傳值無法轉成 JSON" })); return; }
           __finish(JSON.stringify({ ok: true, json: j === undefined ? "null" : j })); },
  (e) => __finish(JSON.stringify({ ok: false, error: (e && e.name ? e.name + ": " : "") + (e && e.message !== undefined ? e.message : String(e)) })));`;
    const evaluated = vm.evalCode(wrapped, "browser_script.js");
    if (evaluated.error) {
      const e = vm.dump(evaluated.error);
      evaluated.error.dispose();
      const timedOut = Date.now() > deadline;
      return {
        status: timedOut ? "timeout" : "failed",
        error: redact(errorText(e)).slice(0, L.errorChars),
        steps,
        log,
      };
    }
    evaluated.value.dispose();

    for (;;) {
      const jobs = rt.executePendingJobs();
      if (jobs.error) {
        const e = vm.dump(jobs.error);
        jobs.error.dispose();
        if (!outcome) outcome = { ok: false, error: errorText(e) };
      }
      await Promise.resolve();
      if (outcome) break;
      if (stop) break;
      if (Date.now() > deadline) return { status: "timeout", error: "腳本超過時間上限", steps, log };
      if (ctrl.signal.aborted) return { status: "failed", error: "已中斷", steps, log };
      if (pending.size === 0) {
        // Give a just-settled step one more turn of the job queue before calling it stuck.
        await new Promise((r) => setImmediate(r));
        rt.executePendingJobs();
        await Promise.resolve();
        if (outcome || stop) break;
        if (pending.size === 0)
          return {
            status: "failed",
            error: "腳本卡住了：只能 await 提供的 helper（沒有計時器或其他非同步來源）",
            steps,
            log,
          };
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        const t = setTimeout(resolve, Math.max(1, Math.min(250, deadline - Date.now())));
        void Promise.race([...pending]).finally(() => clearTimeout(t));
      });
    }
    if (stop) return { status: stop.status, error: stop.error, steps: Math.min(steps, L.steps), log };
    if (!outcome) return { status: "failed", error: "沒有結果", steps, log };
    if (!outcome.ok) {
      const timedOut = /interrupted/i.test(outcome.error) && Date.now() > deadline;
      return {
        status: timedOut ? "timeout" : "failed",
        error: redact(outcome.error).slice(0, L.errorChars),
        steps,
        log,
      };
    }
    if (utf8Bytes(outcome.json) > L.valueBytes)
      return { status: "failed", error: `回傳值超過 ${L.valueBytes} 位元組`, steps, log };
    return { status: "completed", value: JSON.parse(outcome.json) as unknown, steps, log };
  } finally {
    stop ??= { status: "failed", error: "腳本已結束" };
    o.signal?.removeEventListener("abort", onOuter);
    ctrl.abort();
    closed = true;
    for (const d of deferreds)
      try {
        if (d.alive) d.dispose();
      } catch {
        // already gone
      }
    try {
      vm.dispose();
    } catch {
      // a pending promise handle can outlive the context; the runtime goes anyway
    }
    try {
      rt.dispose();
    } catch {
      // ignore
    }
  }
}

function errorText(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const o = e as { name?: unknown; message?: unknown };
    if (typeof o.message === "string")
      return `${typeof o.name === "string" ? `${o.name}: ` : ""}${o.message}`;
  }
  return typeof e === "string" ? e : JSON.stringify(e);
}
