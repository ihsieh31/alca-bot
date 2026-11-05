import { isAlwaysConfirm } from "@alca/config";
import type { ActionClass } from "@alca/policy";
import type { AgentStep, BrowserAgent, StepTarget } from "./agent.ts";
import { classifyStep, SensitiveActionError, type SensitiveRule } from "./sensitive.ts";

/**
 * Script mode: a deterministic JSON list of steps, run in one tool call.
 * There is no JavaScript in a script: each step is one of the host's own
 * actions, targets are `@N` refs or role + name locators (replayable on a
 * fresh page), and every step goes through the same ownership, takeover and
 * sensitive-action gates as a single call. A step that needs an approval the
 * script was not granted stops the script there, with what ran so far.
 */

export interface BrowserScript {
  version: 1;
  steps: AgentStep[];
}

export interface ScriptStepReport {
  index: number;
  do: string;
  ok: boolean;
  output?: string;
  error?: string;
}

export interface ScriptReport {
  ok: boolean;
  steps: ScriptStepReport[];
  /** Set when a step needs a person's yes for a class this run was not granted. */
  needsApproval?: { index: number; actionClass: ActionClass; summary: string };
}

const MAX_STEPS = 50;
const DOS = new Set([
  "navigate",
  "click",
  "type",
  "select",
  "press",
  "scroll",
  "wait",
  "read",
  "snapshot",
  "screenshot",
  "hover",
  "check",
]);

function targetProblem(t: unknown, where: string): string | undefined {
  if (typeof t !== "object" || t === null) return `${where}: target 必須是物件`;
  const o = t as Record<string, unknown>;
  if ("ref" in o)
    return typeof o.ref === "string" || typeof o.ref === "number" ? undefined : `${where}: ref 格式錯誤`;
  if ("css" in o)
    return typeof o.css === "string" && o.css.trim() ? undefined : `${where}: css 必須是非空字串`;
  if (typeof o.name !== "string" || !o.name.trim()) return `${where}: target 需要 ref 或 name`;
  if (o.role !== undefined && typeof o.role !== "string") return `${where}: role 必須是字串`;
  if (o.nth !== undefined && !(Number.isInteger(o.nth) && (o.nth as number) >= 0))
    return `${where}: nth 必須是 ≥ 0 的整數`;
  return undefined;
}

/** Validate an untrusted script; returns the problems (empty when valid). */
export function scriptProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return ["script 必須是物件"];
  const s = raw as Record<string, unknown>;
  if (s.version !== 1) return ["version 必須是 1"];
  if (!Array.isArray(s.steps) || s.steps.length === 0) return ["steps 必須是非空陣列"];
  if (s.steps.length > MAX_STEPS) return [`一次最多 ${MAX_STEPS} 步`];
  const out: string[] = [];
  for (const [i, st] of (s.steps as unknown[]).entries()) {
    const where = `第 ${i + 1} 步`;
    if (typeof st !== "object" || st === null) {
      out.push(`${where}: 必須是物件`);
      continue;
    }
    const o = st as Record<string, unknown>;
    if (typeof o.do !== "string" || !DOS.has(o.do)) {
      out.push(`${where}: 不認得的動作 ${String(o.do)}`);
      continue;
    }
    const needTarget = ["click", "type", "select", "hover", "check"].includes(o.do);
    if (needTarget || o.target !== undefined) {
      const p = targetProblem(o.target, where);
      if (p) out.push(p);
    }
    if (o.do === "navigate" && typeof o.url !== "string") out.push(`${where}: navigate 需要 url`);
    if (o.do === "type" && typeof o.text !== "string") out.push(`${where}: type 需要 text`);
    if (o.do === "select" && typeof o.option !== "string") out.push(`${where}: select 需要 option`);
    if (o.do === "press" && typeof o.key !== "string") out.push(`${where}: press 需要 key`);
    if (o.do === "type" && o.secret !== undefined) out.push(`${where}: 腳本不能填金庫項目`);
    if (o.do === "check" && typeof o.checked !== "boolean") out.push(`${where}: check 需要 checked`);
  }
  return out;
}

export function parseScript(raw: unknown): BrowserScript {
  const p = scriptProblems(raw);
  if (p.length) throw new Error(`腳本格式錯誤：${p.join("；")}`);
  return raw as BrowserScript;
}

/**
 * Static pre-flight: the strongest class any step declares by its locator
 * name or URL. Used for the approval card before the script runs; the live
 * check during the run can still stop it.
 */
export function classifyScript(
  script: BrowserScript,
  pageUrl: string,
  rules?: readonly SensitiveRule[],
): { actionClass: ActionClass; index?: number; reasons: string[] } {
  let best: { actionClass: ActionClass; index?: number; reasons: string[] } = {
    actionClass: "write",
    reasons: [],
  };
  const rank = (c: ActionClass) => (isAlwaysConfirm(c) ? 2 : c === "write" ? 1 : 0);
  script.steps.forEach((st, index) => {
    if (!["click", "type", "select", "press", "navigate", "check"].includes(st.do)) return;
    const t = "target" in st ? (st.target as StepTarget | undefined) : undefined;
    const name = t && "name" in t ? t.name : "";
    const c = classifyStep(
      {
        kind: (st.do === "check" ? "click" : st.do) as "click",
        pageUrl,
        ...(st.do === "navigate" ? { url: st.url } : {}),
        ...(st.do === "press" ? { key: st.key } : {}),
        ...(st.do === "type" ? { submit: !!st.submit } : {}),
        ...(name || st.do === "click"
          ? {
              element: {
                role: (t && "role" in t && t.role) || "button",
                name,
                ...(st.do !== "click" ? { form: {} } : {}),
              },
            }
          : {}),
      },
      rules,
    );
    if (rank(c.actionClass) > rank(best.actionClass))
      best = { actionClass: c.actionClass, index, reasons: c.reasons };
  });
  return best;
}

export async function runScript(
  agent: BrowserAgent,
  spaceId: string,
  botId: string,
  script: BrowserScript,
  opts: { signal: AbortSignal; granted: ActionClass },
): Promise<ScriptReport> {
  const steps: ScriptStepReport[] = [];
  for (const [index, st] of script.steps.entries()) {
    if (opts.signal.aborted) {
      steps.push({ index, do: st.do, ok: false, error: "已中斷" });
      return { ok: false, steps };
    }
    try {
      const r = await agent.step(spaceId, botId, st, opts);
      steps.push({ index, do: st.do, ok: true, output: r.output });
    } catch (err) {
      const error = String((err as Error).message ?? err);
      steps.push({ index, do: st.do, ok: false, error });
      if (err instanceof SensitiveActionError)
        return {
          ok: false,
          steps,
          needsApproval: { index, actionClass: err.actionClass, summary: err.summary },
        };
      return { ok: false, steps };
    }
  }
  return { ok: true, steps };
}

export function formatReport(r: ScriptReport): string {
  const lines = r.steps.map(
    (s) =>
      `${s.ok ? "✓" : "✗"} ${s.index + 1}. ${s.do}${s.ok ? (s.output ? `：${s.output}` : "") : `：${s.error}`}`,
  );
  if (r.needsApproval)
    lines.push(
      `\n第 ${r.needsApproval.index + 1} 步需要使用者批准（${r.needsApproval.actionClass}）。請單獨呼叫那一步，主機會出示批准卡；之後再用剩下的步驟繼續。`,
    );
  else lines.push(r.ok ? "\n全部完成。" : "\n腳本在失敗的那一步停下。");
  return lines.join("\n");
}
