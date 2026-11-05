import type { ActionClass } from "@alca/policy";
import type { RegisteredTool, ToolCallContext } from "@alca/tools";
import { type AgentStep, BrowserAgent, type StepTarget } from "./agent.ts";
import type { BrowserHost } from "./host.ts";
import { runSandbox, SANDBOX_LIMITS, type SandboxStepRequest, SandboxStop } from "./sandbox.ts";
import { SensitiveActionError } from "./sensitive.ts";
import { parseElementRef } from "./snapshot.ts";
import { type SpaceInternal, SpaceNotFoundError } from "./space.ts";

/**
 * Plan §5: the general harness's browser tools.
 *
 * - `browser_script`: a JavaScript program run in the QuickJS sandbox; each
 *   helper call is one browser step through the same ownership, takeover and
 *   sensitive-action gates as a single call (a send / pay / submit step still
 *   stops for the person). No secret, card, upload or takeover step exists in
 *   a script, and nothing runs JavaScript in the page (`evaluate` is not
 *   offered; see SECURITY.md, known limits).
 * - `browser_fill_secret`: fills a password field from the vault by item id,
 *   only on an HTTPS page whose origin the vault item is for; the value goes
 *   host → page only and never reaches the model, the recording, an event,
 *   the log or the result. Card numbers and one-time codes are not filled
 *   (known gap): those go to the person through a takeover.
 * - `browser_request_takeover`: hands the Space to the person and waits for
 *   them (≤ 15 minutes); refused for background work nobody is watching.
 */

export const TAKEOVER_MAX_MS = 15 * 60_000;
export const TAKEOVER_REASONS = [
  "captcha",
  "passkey",
  "payment_confirmation",
  "oauth_account_choice",
  "sign_in_blocked",
  "unsupported_secret",
  "other",
] as const;

/** Where vault values come from. Only ids and labels ever leave it toward the model. */
export interface SecretSource {
  /**
   * The password of a vault item for this bot, only when the item is for
   * exactly this page origin (https only); undefined = not available here.
   */
  value(botId: string, secretId: string, origin: string): Promise<string | undefined>;
  /** Items usable on this origin (id, label, username) — never values. */
  list?(
    botId: string,
    origin: string,
  ): Promise<Array<{ secretId: string; label: string; username?: string }>>;
}

export interface GeneralBrowserOptions {
  secrets?: SecretSource;
  /** Whether a person can answer for this task now (false for background / scheduled work). */
  interactive?: (ctx: { botId?: string; threadId?: string; workerId?: string }) => boolean;
  /** The worker is waiting on a person (its stall clock pauses). */
  waiting?: (ctx: { workerId?: string }, on: boolean) => void;
  /** Tell the person (push / card) once the Space is really theirs. */
  notifyTakeover?: (
    ctx: { botId?: string; threadId?: string; workerId?: string },
    reason: string,
    note?: string,
  ) => void;
  takeoverMaxMs?: number;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/** Redact what must never leave: known secret values, card-number shapes, bearer tokens. */
export function redactSecrets(s: string, known: Iterable<string> = []): string {
  let out = s;
  for (const k of known) if (k && k.length >= 4) out = out.split(k).join("••••");
  return out
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, "••••")
    .replace(/(authorization\s*[:=]\s*)(\S+(\s+\S+)?)/gi, "$1••••")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1••••")
    .replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}\b/g, "••••");
}

/** A sandbox target → a step target (role + name, visible text, or an @ref). */
function targetOf(t: unknown): StepTarget {
  if (typeof t === "string" && /^@?\d+$/.test(t)) return { ref: t };
  if (typeof t !== "object" || t === null) throw new Error("需要 target：用 role(…)、text(…) 或 @ref");
  const o = t as Record<string, unknown>;
  if (typeof o.ref === "string" || typeof o.ref === "number") return { ref: o.ref };
  if (typeof o.css === "string") {
    if (!o.css.trim()) throw new Error("css() 需要選擇器");
    const nth = Number(o.nth);
    return { css: o.css, ...(Number.isInteger(nth) && nth > 0 ? { nth } : {}) };
  }
  if (typeof o.role === "string" && typeof o.name === "string") return { role: o.role, name: o.name };
  if (typeof o.text === "string") return { name: o.text };
  if (typeof o.role === "string") throw new Error("role() 需要 name");
  throw new Error("看不懂的 target");
}

const ALLOWED = new Set([
  "navigate",
  "click",
  "type",
  "press",
  "hover",
  "scroll",
  "select_option",
  "set_checked",
  "wait_for",
  "snapshot",
  "sleep",
]);

/** One sandbox step request → the browser step it means (or an error the script can catch). */
export function stepOf(req: SandboxStepRequest): AgentStep {
  if (req.action === "evaluate")
    throw new Error("evaluate 不支援：腳本不能在頁面裡執行 JavaScript，請用 snapshot、waitFor 與目標 helper");
  if (!ALLOWED.has(req.action)) throw new Error(`腳本裡沒有「${req.action}」這個動作`);
  switch (req.action) {
    case "navigate": {
      const url = str(req.url);
      if (!url) throw new Error("navigate 需要 url（這個版本不支援上一頁／下一頁）");
      return { do: "navigate", url };
    }
    case "click":
      return { do: "click", target: targetOf(req.target) };
    case "hover":
      return { do: "hover", target: targetOf(req.target) };
    case "set_checked":
      return { do: "check", target: targetOf(req.target), checked: req.checked === true };
    case "type":
      return {
        do: "type",
        target: targetOf(req.target),
        text: String(req.text ?? ""),
        ...(req.clear ? { clear: true } : {}),
        ...(req.submit ? { submit: true } : {}),
      };
    case "press":
      return {
        do: "press",
        key: String(req.key ?? ""),
        ...(req.target !== undefined && req.target !== null ? { target: targetOf(req.target) } : {}),
      };
    case "scroll":
      return {
        do: "scroll",
        dy: Number(req.dy) || 0,
        ...(req.target !== undefined && req.target !== null ? { target: targetOf(req.target) } : {}),
      };
    case "select_option": {
      const values = Array.isArray(req.values) ? req.values.map(String) : [];
      if (!values[0]) throw new Error("selectOption 需要值");
      return { do: "select", target: targetOf(req.target), option: values[0] };
    }
    case "wait_for": {
      if (req.fn !== undefined) throw new Error("這個版本不支援在頁面裡執行的等待函式，請等文字出現");
      const text = str(req.text);
      if (!text) throw new Error("waitFor 需要要等的文字");
      const t = Number(req.timeoutMs);
      return { do: "wait", text, timeoutMs: Math.min(25_000, Number.isFinite(t) && t > 0 ? t : 10_000) };
    }
    case "snapshot":
      return { do: "snapshot" };
    case "sleep":
      return { do: "wait", ms: Math.min(5_000, Math.max(0, Number(req.ms) || 0)) };
    default:
      throw new Error(`這個版本的腳本不支援 ${req.action}`);
  }
}

export function generalBrowserTools(host: BrowserHost, o: GeneralBrowserOptions = {}): RegisteredTool[] {
  const agent = new BrowserAgent(host);
  /** Origins a script touched, per task: vault auto-fill is refused there (§4 S3). */
  const scripted = new Map<string, Set<string>>();
  /** Spaces with a takeover or secret request open (one at a time). */
  const busy = new Set<string>();
  const taskKey = (ctx: { workerId?: string; threadId?: string }) => ctx.workerId ?? ctx.threadId ?? "";

  const spaceOf = (ctx: { botId?: string; threadId?: string; workerId?: string }): SpaceInternal => {
    if (!ctx.botId) throw new Error("沒有 bot 身分，不能使用瀏覽器");
    const s = ctx.threadId ? host.forThread(ctx.botId, ctx.threadId, ctx.workerId) : undefined;
    if (!s) throw new Error("這件工作還沒有開瀏覽器；先用 browser_open");
    return s;
  };
  const urlOf = (s: SpaceInternal) => host.activeTab(s)?.driver.url ?? "";
  /** The field behind `@N` is a password input (type=password or a password autocomplete). */
  const passwordField = async (s: SpaceInternal, ref: string): Promise<boolean> => {
    const d = host.activeTab(s)?.driver;
    const n = parseElementRef(ref);
    if (!d || n === undefined) return false;
    try {
      const f = await d.facts(d.handle(n));
      return f.type === "password" || /password/i.test(f.autocomplete ?? "");
    } catch {
      return false;
    }
  };

  return [
    {
      name: "browser_script",
      summary:
        '一次跑一段 JavaScript 瀏覽器腳本（隔離沙箱，不在頁面裡執行，最多 200 步、120 秒）：helper 有 navigate(url)、click(t)、type(t, 文字, {clear, submit})、press(鍵, t?)、hover(t)、scroll(dy, t?)、selectOption(t, 值)、setChecked(t, true/false)、waitFor(文字)、snapshot()、sleep(ms)、log(…)；目標 t 用 role(角色, 名稱)、text(文字)、css(選擇器) 或 "@N"（css 只認快照裡的可互動元素）。return 的值會傳回。沒有 evaluate；送出、付款、寄送的步驟會停下，要單獨呼叫讓主機出批准卡；沒有填密碼或付款的 helper。',
      inputSchema: obj(
        {
          script: { type: "string", maxLength: SANDBOX_LIMITS.scriptChars },
          timeoutMs: {
            type: "integer",
            minimum: SANDBOX_LIMITS.timeoutMinMs,
            maximum: SANDBOX_LIMITS.timeoutMaxMs,
          },
          finalSnapshot: { type: "boolean" },
        },
        ["script"],
      ),
      actionClass: "write",
      source: "builtin",
      run: async (a, ctx: ToolCallContext) => {
        const script = str(a.script);
        if (!script) throw new Error("需要 script");
        const s = spaceOf(ctx);
        const origins = scripted.get(taskKey(ctx)) ?? new Set<string>();
        scripted.set(taskKey(ctx), origins);
        const granted: ActionClass = ctx.actionClass;
        const r = await runSandbox({
          script,
          ...(typeof a.timeoutMs === "number" ? { timeoutMs: a.timeoutMs } : {}),
          signal: ctx.signal,
          redact: (x) => redactSecrets(x),
          step: async (req, sctx) => {
            if (s.closed) throw new SandboxStop("tab_closed", "Space 已關閉");
            if (s.controller === "user") throw new SandboxStop("user_control", "使用者正在操作這個 Space");
            const st = stepOf(req);
            const origin = originOf(urlOf(s));
            if (origin) origins.add(origin);
            const signal = AbortSignal.any([
              sctx.signal,
              AbortSignal.timeout(Math.max(1, sctx.deadline - Date.now())),
            ]);
            try {
              const out = await agent.step(s.spaceId, s.botId, st, { signal, granted });
              const after = originOf(urlOf(s));
              if (after) origins.add(after);
              return out.output;
            } catch (err) {
              if (err instanceof SpaceNotFoundError) throw new SandboxStop("tab_closed", "Space 已關閉");
              if (err instanceof SensitiveActionError)
                throw new Error(
                  `這一步需要使用者批准（${err.actionClass}：${err.summary}）；腳本不能自己送出，請單獨呼叫那一步讓主機出示批准卡`,
                );
              throw err;
            }
          },
        });
        const out: Record<string, unknown> = { status: r.status, steps: r.steps };
        if (r.value !== undefined) out.value = r.value;
        if (r.error) out.error = r.error;
        if (r.log.length) out.log = r.log;
        const url = urlOf(s);
        if (url) out.url = url.split("?")[0];
        if (a.finalSnapshot !== false && r.status !== "tab_closed") {
          try {
            out.snapshot = (
              await agent.step(
                s.spaceId,
                s.botId,
                { do: "snapshot", maxChars: 6000 },
                { signal: ctx.signal, granted: "read" },
              )
            ).output;
          } catch (err) {
            out.snapshotError = redactSecrets(String((err as Error).message ?? err)).slice(0, 300);
          }
        }
        out.note = "沒有回滾：steps 是已經生效的步驟數。";
        return JSON.stringify(out);
      },
    },
    {
      name: "browser_fill_secret",
      summary:
        "用金庫項目的 id 填一個密碼欄位；值由 Alca 直接填進頁面，你看不到。只能在 HTTPS 頁面、而且網站要和金庫項目的網址相同；腳本碰過的網站不會自動填。卡號與一次性驗證碼不支援，改用 browser_request_takeover。",
      inputSchema: obj(
        {
          ref: { type: "string", description: '欄位編號，例如 "@3"（來自最新的 snapshot）' },
          secretId: { type: "string", description: "金庫項目 id（不是值）" },
          submit: { type: "boolean" },
        },
        ["ref", "secretId"],
      ),
      actionClass: "write",
      source: "builtin",
      run: async (a, ctx: ToolCallContext) => {
        const s = spaceOf(ctx);
        const ref = str(a.ref);
        const secretId = str(a.secretId);
        if (!ref || !secretId) throw new Error("需要 ref 與 secretId");
        const url = urlOf(s);
        if (!url.startsWith("https://"))
          throw new Error("只能在 HTTPS 頁面填祕密；請用 browser_request_takeover");
        const origin = originOf(url);
        if (scripted.get(taskKey(ctx))?.has(origin))
          throw new Error(
            "這個網站在這件工作裡被腳本操作過，不自動填祕密；請用 browser_request_takeover 讓使用者自己輸入",
          );
        if (busy.has(s.spaceId)) throw new Error("這個 Space 已經有一個待處理的接手或祕密請求");
        if (!o.secrets) throw new Error("金庫沒有連上；請用 browser_request_takeover 讓使用者自己輸入");
        const field = await passwordField(s, ref);
        if (!field)
          throw new Error(
            `@${ref.replace(/^@/, "")} 不是密碼欄位；目前只代填密碼（卡號、驗證碼請用 browser_request_takeover）`,
          );
        const value = await o.secrets.value(s.botId, secretId, origin);
        if (!value) throw new Error("金庫沒有可用在這個網站的這個項目；請用 browser_request_takeover");
        busy.add(s.spaceId);
        try {
          const r = await agent.step(
            s.spaceId,
            s.botId,
            {
              do: "type",
              target: { ref },
              text: value,
              clear: true,
              secret: true,
              ...(a.submit === true ? { submit: true } : {}),
            },
            { signal: ctx.signal, granted: ctx.actionClass },
          );
          if (urlOf(s).includes(value))
            throw new Error("頁面網址出現了祕密值，已停止；請用 browser_request_takeover");
          if (originOf(urlOf(s)) !== origin && !r.output.includes("送出"))
            throw new Error("填入時網站換了；請重新 snapshot 確認");
          return redactSecrets(r.output, [value]);
        } catch (err) {
          throw new Error(redactSecrets(String((err as Error).message ?? err), [value]));
        } finally {
          busy.delete(s.spaceId);
        }
      },
    },
    {
      name: "browser_request_takeover",
      summary:
        "請使用者在手機上接手這個 Space（驗證碼、CAPTCHA、passkey、最後付款確認、選帳號）。會等到使用者交還（最多 15 分鐘）；之後先重新 snapshot。",
      inputSchema: obj(
        {
          reason: { type: "string", enum: [...TAKEOVER_REASONS] },
          note: { type: "string", maxLength: 300 },
        },
        ["reason"],
      ),
      actionClass: "read",
      source: "builtin",
      run: async (a, ctx: ToolCallContext) => {
        const reason = (TAKEOVER_REASONS as readonly string[]).includes(String(a.reason))
          ? String(a.reason)
          : "other";
        const note = str(a.note)?.slice(0, 300);
        if (o.interactive && !o.interactive(ctx))
          throw new Error(
            "這件工作沒有人在看（背景或排程）；需要使用者時請用 report_result 回報 needs_input（person_only）或 blocked",
          );
        const s = spaceOf(ctx);
        if (busy.has(s.spaceId)) throw new Error("這個 Space 已經有一個待處理的接手或祕密請求");
        busy.add(s.spaceId);
        const max = o.takeoverMaxMs ?? TAKEOVER_MAX_MS;
        let unlisten: (() => void) | undefined;
        try {
          // Hand over first (refs drop, agent actions queue), then tell the person.
          host.takeOver(s.spaceId, { kind: "agent", id: s.botId }, note ? `${reason}：${note}` : reason);
          o.waiting?.(ctx, true);
          o.notifyTakeover?.(ctx, reason, note);
          const status = await new Promise<"completed" | "cancelled" | "timeout">((resolve) => {
            const t = setTimeout(() => resolve("timeout"), max);
            const done = (v: "completed" | "cancelled") => {
              clearTimeout(t);
              resolve(v);
            };
            unlisten = host.onControlChange((c) => {
              if (c.space.spaceId === s.spaceId && c.controller === "agent") done("completed");
            });
            ctx.signal.addEventListener("abort", () => done("cancelled"), { once: true });
            if (s.controller === "agent") done("completed");
          });
          if (status !== "completed" && s.controller === "user" && !s.closed)
            host.handBack(
              s.spaceId,
              { kind: "agent", id: s.botId },
              status === "timeout" ? "接手逾時" : "接手取消",
            );
          return JSON.stringify({
            status,
            ...(status === "completed" ? { next: "take_fresh_snapshot" } : {}),
          });
        } finally {
          unlisten?.();
          o.waiting?.(ctx, false);
          busy.delete(s.spaceId);
        }
      },
    },
  ];
}
