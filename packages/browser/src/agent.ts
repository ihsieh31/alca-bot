import { isAlwaysConfirm } from "@alca/config";
import type { ActionClass } from "@alca/policy";
import type { BrowserActionKindT } from "@alca/protocol";
import { defuseAlcaTags } from "@alca/tools";
import type { BrowserHost } from "./host.ts";
import { describeNotes } from "./network.ts";
import { checkNavigableUrl, type Frame, SUPPORTED_KEYS, sleep, type TabDriver } from "./page.ts";
import { CLASS_LABEL, classifyStep, SensitiveActionError, type StepFacts, stepAllowed } from "./sensitive.ts";
import { type ElementHandle, parseElementRef } from "./snapshot.ts";
import type { RecordedStep, SpaceInternal, TabEntry } from "./space.ts";

/** Which element a step acts on: a ref from the current snapshot, or a replayable role + name locator. */
export type StepTarget =
  | { ref: number | string }
  | { css: string; nth?: number }
  | { role?: string; name: string; nth?: number; exact?: boolean };

export type AgentStep =
  | { do: "navigate"; url: string }
  | { do: "click"; target: StepTarget }
  | {
      do: "type";
      target: StepTarget;
      text: string;
      clear?: boolean;
      submit?: boolean;
      /** A vault value: never recorded, never echoed, redacted from every later output of the Space. */
      secret?: boolean;
    }
  | { do: "hover"; target: StepTarget }
  | { do: "check"; target: StepTarget; checked: boolean }
  | { do: "select"; target: StepTarget; option: string }
  | { do: "press"; key: string; target?: StepTarget }
  | { do: "scroll"; target?: StepTarget; dy?: number }
  | { do: "wait"; ms?: number; text?: string; timeoutMs?: number }
  | { do: "read"; target?: StepTarget; maxChars?: number }
  | { do: "snapshot"; maxChars?: number }
  | { do: "screenshot" };

export interface StepResult {
  ok: true;
  output: string;
  gated?: ActionClass;
  frame?: Frame;
}

export interface Inspection {
  actionClass: ActionClass;
  summary: string;
  target: string;
  reasons: string[];
}

const MUTATING = new Set(["click", "type", "select", "press", "navigate", "check"]);

/** Remove every secret value a Space was filled with from a text that leaves it. */
export function redactKnown(text: string, known: Iterable<string> | undefined): string {
  let out = text;
  for (const k of known ?? []) if (k && k.length >= 4) out = out.split(k).join("••••");
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Page text reaches the model fenced as untrusted data, never as instructions. */
export function fence(url: string, text: string): string {
  const safe = defuseAlcaTags(text);
  return `<alca:page url=${JSON.stringify(url)} trust="untrusted">\n${safe}\n</alca:page>`;
}

function verb(step: AgentStep): string {
  switch (step.do) {
    case "click":
      return "按下";
    case "type":
      return step.submit ? "填寫並送出" : "填寫";
    case "select":
      return "選擇";
    case "press":
      return `按 ${step.key}`;
    case "navigate":
      return "前往";
    case "check":
      return step.checked ? "勾選" : "取消勾選";
    default:
      return step.do;
  }
}

/**
 * Agent-facing operations over a bot's Space. Every call checks ownership,
 * waits its turn while a person drives, runs one at a time per Space, and
 * puts mutating steps through the sensitive-action gate against the class
 * the policy gateway authorized.
 */
export class BrowserAgent {
  readonly host: BrowserHost;
  constructor(host: BrowserHost) {
    this.host = host;
  }

  private tab(s: SpaceInternal): TabEntry {
    const t = this.host.activeTab(s);
    if (!t) throw new Error("這個 Space 沒有分頁");
    return t;
  }

  private async resolve(d: TabDriver, t: StepTarget): Promise<ElementHandle> {
    if ("ref" in t) {
      const ref = parseElementRef(t.ref);
      if (ref === undefined) throw new Error(`不是有效的元素編號：${String(t.ref)}（格式 @N）`);
      return d.handle(ref);
    }
    if ("css" in t) {
      const css = String(t.css).trim();
      if (!css) throw new Error("css 目標不能是空字串");
      const h = await d.findCss(css, t.nth ?? 0);
      if (!h) throw new Error(`畫面上找不到符合 css「${css.slice(0, 120)}」的可互動元素（只認快照裡的元素）`);
      return h;
    }
    const find = () => d.find(t.role, t.name, t.nth ?? 0, t.exact ?? false);
    if (!d.snapshotId) await d.snapshot();
    let h = find();
    if (!h) {
      await d.snapshot();
      h = find();
    }
    if (!h) throw new Error(`畫面上找不到${t.role ? ` ${t.role}` : ""}「${t.name}」`);
    return h;
  }

  /** Classify a step against the live page without running it (feeds the gateway's approval card). */
  async inspect(spaceId: string, botId: string, step: AgentStep): Promise<Inspection> {
    const s = this.host.owned(spaceId, botId);
    const d = this.tab(s).driver;
    const facts: StepFacts = { kind: "click", pageUrl: d.url };
    let name = "";
    if (step.do === "navigate") {
      Object.assign(facts, { kind: "navigate", url: step.url });
      name = hostOf(step.url);
    } else if (
      step.do === "click" ||
      step.do === "type" ||
      step.do === "select" ||
      step.do === "press" ||
      step.do === "check"
    ) {
      const target = "target" in step ? step.target : undefined;
      const h = target ? await this.resolve(d, target).catch(() => undefined) : undefined;
      if (h) {
        facts.element = await d.facts(h);
        name = h.name;
      } else if (target && "name" in target) {
        facts.element = { role: target.role ?? "button", name: target.name };
        name = target.name;
      }
      facts.kind = step.do === "check" ? "click" : step.do;
      if (step.do === "press") facts.key = step.key;
      if (step.do === "type") facts.submit = !!step.submit;
    } else {
      return { actionClass: "read", summary: `讀取 ${hostOf(d.url)}`, target: d.url, reasons: [] };
    }
    const c = classifyStep(facts, this.host.rules());
    const what = step.do === "navigate" ? name : `「${name || "（未命名元素）"}」`;
    // The button label is already in the summary; keep only the other reasons.
    const extra = c.reasons.filter((r) => !r.startsWith("按鈕「"));
    const why = extra.length ? `（${extra.join("、")}）` : "";
    return {
      actionClass: c.actionClass,
      summary: `在 ${hostOf(d.url)} ${verb(step)}${what}${why}`.slice(0, 300),
      target: step.do === "navigate" ? step.url : d.url,
      reasons: c.reasons,
    };
  }

  /** Run one step for the owning bot. `granted` is the class the policy gateway authorized. */
  async step(
    spaceId: string,
    botId: string,
    step: AgentStep,
    opts: { signal: AbortSignal; granted: ActionClass },
  ): Promise<StepResult> {
    const s = this.host.owned(spaceId, botId);
    const run = async () => {
      await this.host.agentTurn(s, opts.signal);
      s.status = "working";
      this.host.changed(s.spaceId);
      const tab = this.tab(s);
      const kind: BrowserActionKindT =
        step.do === "read" || step.do === "hover" ? "read" : step.do === "check" ? "click" : step.do;
      this.host.net.beginStep(s, opts.granted);
      try {
        const r = await this.exec(s, tab, step, opts.granted);
        const net = await this.host.net.endStep(s, opts.signal);
        const blocked = net.find((n) => n.outcome === "blocked");
        this.note(s, tab, kind, r.label, true, r.gated ?? (blocked ? blocked.actionClass : undefined));
        if (r.record && !blocked) s.recording.push(r.record);
        return {
          ok: true as const,
          output: redactKnown(`${r.output}${describeNotes(net)}`, s.secrets),
          ...(r.gated ? { gated: r.gated } : {}),
          ...(r.frame ? { frame: r.frame } : {}),
        };
      } catch (err) {
        await this.host.net.endStep(s, opts.signal).catch(() => undefined);
        const msg = redactKnown(String((err as Error).message ?? err), s.secrets);
        const gated = err instanceof SensitiveActionError ? err.actionClass : undefined;
        this.note(s, tab, kind, `${step.do} 失敗`, false, gated, msg);
        if (step.do === "type" && step.secret && !(err instanceof SensitiveActionError))
          throw new Error(redactKnown(msg, [step.text]));
        throw err;
      } finally {
        if (s.status === "working") s.status = s.controller === "user" ? "waiting_user" : "idle";
        this.host.changed(s.spaceId);
      }
    };
    const p = s.chain.then(run, run);
    s.chain = p.catch(() => undefined);
    return p;
  }

  private note(
    s: SpaceInternal,
    tab: TabEntry,
    kind: BrowserActionKindT,
    label: string,
    ok: boolean,
    gated?: ActionClass,
    error?: string,
  ): void {
    s.lastAction = { kind, label, ok, at: this.host.now().toISOString() };
    this.host.emit("space.action", {
      spaceId: s.spaceId,
      botId: s.botId,
      tabId: tab.tabId,
      kind,
      label,
      ok,
      ...(gated && isAlwaysConfirm(gated) ? { gated } : {}),
      ...(error ? { error: error.slice(0, 500) } : {}),
    });
  }

  private async gate(d: TabDriver, step: AgentStep, h: ElementHandle | undefined, granted: ActionClass) {
    const facts: StepFacts = {
      kind: (step.do === "check" ? "click" : step.do) as StepFacts["kind"],
      pageUrl: d.url,
    };
    if (h) facts.element = await d.facts(h);
    if (step.do === "press") facts.key = step.key;
    if (step.do === "type") facts.submit = !!step.submit;
    if (step.do === "navigate") facts.url = step.url;
    const c = classifyStep(facts, this.host.rules());
    if (!stepAllowed(c.actionClass, granted)) {
      const name = h?.name ? `「${h.name}」` : "";
      throw new SensitiveActionError(
        c.actionClass,
        `${verb(step)}${name}（${c.reasons.join("、") || CLASS_LABEL[c.actionClass]}）`,
      );
    }
    return isAlwaysConfirm(c.actionClass) ? c.actionClass : undefined;
  }

  private locator(h: ElementHandle) {
    return { role: h.role, name: h.name, ...(h.nth ? { nth: h.nth } : {}), exact: true };
  }

  private async exec(
    s: SpaceInternal,
    tab: TabEntry,
    step: AgentStep,
    granted: ActionClass,
  ): Promise<{ output: string; label: string; gated?: ActionClass; record?: RecordedStep; frame?: Frame }> {
    const d = tab.driver;
    const target = "target" in step ? step.target : undefined;
    const h =
      target && (MUTATING.has(step.do) || step.do === "hover") ? await this.resolve(d, target) : undefined;
    const gated = MUTATING.has(step.do) ? await this.gate(d, step, h, granted) : undefined;
    const extra = gated ? { gated } : {};
    switch (step.do) {
      case "navigate": {
        const url = checkNavigableUrl(step.url);
        await d.navigate(url);
        return {
          output: `已開啟 ${d.title || d.url}（${d.url}）`,
          label: `前往 ${hostOf(d.url)}`,
          record: { do: "navigate", url },
          ...extra,
        };
      }
      case "click":
        await d.click(h!);
        return {
          output: `已點擊 @${h!.ref}「${h!.name}」，目前在 ${d.url}`,
          label: `點擊「${h!.name}」`,
          record: { do: "click", target: this.locator(h!) },
          ...extra,
        };
      case "type": {
        if (step.secret) {
          // The value goes host → page only; the Space remembers it to redact later outputs.
          s.secrets ??= new Set();
          s.secrets.add(step.text);
          await d.type(h!, step.text, {
            ...(step.clear ? { clear: true } : {}),
            ...(step.submit ? { submit: true } : {}),
          });
          return {
            output: `已在 @${h!.ref}「${h!.name}」填入金庫項目${step.submit ? "並送出" : ""}`,
            label: `在「${h!.name}」填入金庫項目`,
            ...extra,
          };
        }
        await d.type(h!, step.text, {
          ...(step.clear ? { clear: true } : {}),
          ...(step.submit ? { submit: true } : {}),
        });
        const rec: RecordedStep = {
          do: "type",
          target: this.locator(h!),
          text: step.text,
          ...(step.clear ? { clear: true } : {}),
          ...(step.submit ? { submit: true } : {}),
        };
        return {
          output: `已在 @${h!.ref}「${h!.name}」輸入 ${step.text.length} 個字${step.submit ? "並送出" : ""}`,
          label: `在「${h!.name}」輸入`,
          record: rec,
          ...extra,
        };
      }
      case "select": {
        const label = await d.select(h!, step.option);
        return {
          output: `已選擇「${label}」`,
          label: `選擇「${label}」`,
          record: { do: "select", target: this.locator(h!), option: step.option },
          ...extra,
        };
      }
      case "hover":
        await d.hover(h!);
        return {
          output: `滑鼠移到 @${h!.ref}「${h!.name}」上`,
          label: `移到「${h!.name}」上`,
          record: { do: "hover", target: this.locator(h!) },
        };
      case "check": {
        const was = await d.checkedState(h!);
        if (was === undefined) throw new Error(`@${h!.ref}「${h!.name}」不是可勾選的元素`);
        if (was !== step.checked) await d.click(h!);
        const now = await d.checkedState(h!);
        if (now !== step.checked)
          throw new Error(`「${h!.name}」沒有變成${step.checked ? "勾選" : "未勾選"}`);
        return {
          output: `「${h!.name}」${was === step.checked ? "本來就" : "已"}${step.checked ? "勾選" : "取消勾選"}`,
          label: `${step.checked ? "勾選" : "取消勾選"}「${h!.name}」`,
          record: { do: "check", target: this.locator(h!), checked: step.checked },
          ...extra,
        };
      }
      case "press": {
        if (!SUPPORTED_KEYS.includes(step.key))
          throw new Error(`不支援的按鍵：${step.key}（可用：${SUPPORTED_KEYS.join("、")}）`);
        if (h) await d.focus(h);
        await d.press(step.key);
        await d.settle();
        return {
          output: `已按下 ${step.key}`,
          label: `按下 ${step.key}`,
          record: { do: "press", key: step.key, ...(h ? { target: this.locator(h) } : {}) },
          ...extra,
        };
      }
      case "scroll": {
        const sh = target ? await this.resolve(d, target) : undefined;
        await d.scroll({ ...(sh ? { h: sh } : {}), ...(step.dy !== undefined ? { dy: step.dy } : {}) });
        return {
          output: sh ? `已捲到「${sh.name}」` : "已捲動頁面",
          label: "捲動",
          record: {
            do: "scroll",
            ...(sh ? { target: this.locator(sh) } : {}),
            ...(step.dy !== undefined ? { dy: step.dy } : {}),
          },
        };
      }
      case "wait": {
        if (step.text) {
          const ok = await d.waitForText(step.text, Math.min(step.timeoutMs ?? 10_000, 60_000));
          if (!ok) throw new Error(`等不到「${step.text}」出現`);
          return { output: `「${step.text}」已出現`, label: "等待", record: { do: "wait", text: step.text } };
        }
        const ms = Math.min(Math.max(step.ms ?? 1000, 0), 30_000);
        await sleep(ms);
        return { output: `已等待 ${ms} ms`, label: "等待", record: { do: "wait", ms } };
      }
      case "read": {
        const rh = target ? await this.resolve(d, target) : undefined;
        const text = await d.readText(rh, Math.min(step.maxChars ?? 8000, 40_000));
        return { output: fence(d.url, text), label: "讀取內容" };
      }
      case "snapshot": {
        const snap = await d.snapshot(step.maxChars);
        let out = `頁面：${snap.title || "（無標題）"}\n網址：${snap.url}\n快照：${snap.snapshotId}（@N 只在這份快照有效）\n\n${fence(snap.url, snap.text || "- （頁面沒有可讀內容）")}`;
        if (snap.captcha) {
          this.host.autoHandoff(s, "頁面要求人機驗證，請你完成後按「交還」");
          out +=
            "\n\n偵測到人機驗證（CAPTCHA）。已把這個 Space 交給使用者處理，下一個動作會等使用者交還後才執行。";
        }
        return { output: out, label: "讀取畫面結構" };
      }
      case "screenshot": {
        const frame = await d.screenshot("png");
        return { output: `已截圖（${frame.width}×${frame.height}）`, label: "截圖", frame };
      }
    }
  }

  /** The bot's successful steps in this Space, as a replayable script. */
  recording(spaceId: string, botId: string): { version: 1; steps: RecordedStep[] } {
    return { version: 1, steps: [...this.host.owned(spaceId, botId).recording] };
  }
}
