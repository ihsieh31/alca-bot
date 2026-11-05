import { isAlwaysConfirm } from "@alca/config";
import type { ActionClass } from "@alca/policy";

/**
 * Sensitive-action gate, action layer. Before a click / key press / typed
 * value / select runs, the host looks at the real element (role, label, form
 * it submits, page and form URLs) and classifies the step. Payment, send,
 * delete and publish are the frozen always-confirm classes from
 * `@alca/config`: a step in one of them runs only if a person approved that
 * class for this exact call. The patterns are a floor that only ever
 * escalates; they are not a guarantee, and a network-layer gate comes later.
 */

/** What the host reads off the live element before acting. */
export interface ElementFacts {
  role: string;
  /** Accessible name (button label, link text, input label). */
  name: string;
  tag?: string;
  /** input/button `type`. */
  type?: string;
  href?: string;
  /** `autocomplete` and `name`/`id` of an input, for card-data detection. */
  autocomplete?: string;
  fieldName?: string;
  form?: {
    action?: string;
    method?: string;
    hasPassword?: boolean;
    hasCardFields?: boolean;
    isSearch?: boolean;
    /** Label of the form's default submit button, for Enter-to-submit. */
    submitLabel?: string;
  };
}

export type StepKind = "click" | "type" | "press" | "select" | "navigate";

export interface StepFacts {
  kind: StepKind;
  pageUrl: string;
  key?: string;
  /** `type` with submit=true presses Enter afterwards. */
  submit?: boolean;
  url?: string;
  element?: ElementFacts;
}

export interface Classification {
  actionClass: ActionClass;
  reasons: string[];
}

/** A user- or host-supplied rule. Rules can only add sensitivity, never remove it. */
export interface SensitiveRule {
  id: string;
  actionClass: "payment" | "send" | "delete" | "publish";
  /** Hostname suffix, e.g. "paypal.com" matches www.paypal.com. */
  domain?: string;
  /** Tested against the page URL path + query (or the form action). */
  path?: RegExp;
  /** Tested against the element's accessible name. */
  name?: RegExp;
  /** Which steps the rule applies to (default: click and submit-like key presses). */
  steps?: StepKind[];
}

const NAME_PATTERNS: ReadonlyArray<["payment" | "send" | "delete" | "publish", RegExp]> = [
  [
    "payment",
    /付款|結帳|結賬|購買|下單|支付|確認訂單|送出訂單|立即購|刷卡|儲值|加值|捐款|捐贈|訂閱|\bpay\b|pay now|check ?out|place (your )?order|\bbuy\b|purchase|complete (my |your )?order|subscribe|donate|confirm (and )?pay/i,
  ],
  [
    "delete",
    /刪除|移除|清空|永久刪|註銷|解除綁定|退出群組|\bdelete\b|\bremove\b|\berase\b|destroy|\bdiscard\b|\btrash\b/i,
  ],
  [
    "send",
    /傳送|寄出|寄送|發送|送出|回覆|轉寄|留言|\bsend\b|\breply\b|\bforward\b|\bsubmit\b|post comment|\bcomment\b/i,
  ],
  [
    "publish",
    /發布|發佈|發表|公開|分享|上架|貼文|推文|publish|\bpost\b|\btweet\b|\bshare\b|deploy|go live|\brelease\b/i,
  ],
];

/** Steps that are plainly not sensitive even when a pattern would match. */
const SAFE_NAMES = /^(搜尋|search|登入|log ?in|sign ?in|下一頁|next|上一頁|back|取消|cancel|關閉|close)$/i;
const CONFIRM_LIKE =
  /確認|確定|完成|繼續|下一步|送出|提交|confirm|continue|complete|submit|proceed|done|next/i;
const CHECKOUT_PATH =
  /\/(checkout|payment|payments|pay|billing|purchase|order\/(confirm|review|place))(\/|\?|$)|[?&]step=(payment|review)/i;
const CARD_FIELD = /cc-(number|csc|exp)|card.?num|cardnumber|cvv|cvc|security.?code|卡號|安全碼|信用卡/i;

export const DEFAULT_SENSITIVE_RULES: readonly SensitiveRule[] = Object.freeze([
  { id: "pay.paypal", actionClass: "payment", domain: "paypal.com" },
  { id: "pay.stripe-checkout", actionClass: "payment", domain: "checkout.stripe.com" },
  { id: "pay.google", actionClass: "payment", domain: "pay.google.com" },
  { id: "pay.apple", actionClass: "payment", domain: "apple.com", path: /\/(shop\/)?checkout/i },
  { id: "pay.line", actionClass: "payment", domain: "pay.line.me" },
  { id: "pay.jkopay", actionClass: "payment", domain: "jkopay.com" },
  { id: "pay.ecpay", actionClass: "payment", domain: "ecpay.com.tw" },
  { id: "pay.newebpay", actionClass: "payment", domain: "newebpay.com" },
  { id: "send.gmail", actionClass: "send", domain: "mail.google.com", name: /^(傳送|send)/i },
  { id: "send.outlook", actionClass: "send", domain: "outlook.live.com", name: /^(傳送|send)/i },
  { id: "publish.x", actionClass: "publish", domain: "x.com", name: /^(post|發佈|發布|回覆|reply)/i },
  { id: "publish.threads", actionClass: "publish", domain: "threads.net", name: /^(post|發佈)/i },
]);

const PRIORITY: readonly ActionClass[] = ["payment", "delete", "send", "publish"];

function host(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
function pathOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return "";
  }
}
const domainMatches = (h: string, d: string) => h === d || h.endsWith(`.${d}`);

/** Does this step submit something (a click on a control, or Enter in a form)? */
function submitsSomething(s: StepFacts): boolean {
  if (s.kind === "click") return true;
  if (s.kind === "press") return s.key === "Enter" && !!s.element?.form;
  if (s.kind === "type") return !!s.submit && !!s.element?.form;
  return false;
}

/** The label that best describes what the step triggers. */
function triggerLabel(s: StepFacts): string {
  const el = s.element;
  if (!el) return "";
  if (s.kind === "click") return el.name;
  return el.form?.submitLabel ?? "";
}

export function classifyStep(
  s: StepFacts,
  rules: readonly SensitiveRule[] = DEFAULT_SENSITIVE_RULES,
): Classification {
  const found: Array<{ c: ActionClass; why: string }> = [];
  const el = s.element;
  const label = triggerLabel(s).trim();
  const submits = submitsSomething(s);
  const targetUrl = el?.form?.action ?? s.pageUrl;

  if (s.kind === "navigate") {
    const scheme = (s.url ?? "").split(":")[0]?.toLowerCase();
    if (scheme === "mailto" || scheme === "sms" || scheme === "tel")
      found.push({ c: "send", why: `${scheme} 連結` });
  }

  // Typing card data is part of paying, whatever the button says.
  if ((s.kind === "type" || s.kind === "select") && el) {
    const field = `${el.autocomplete ?? ""} ${el.fieldName ?? ""} ${el.name}`;
    if (CARD_FIELD.test(field)) found.push({ c: "payment", why: "輸入付款卡資料" });
  }

  if (submits && el) {
    const safe = SAFE_NAMES.test(label) || (el.form?.isSearch ?? false);
    // A sign-in form's "Submit" is not a send.
    const login = !!el.form?.hasPassword && !el.form.hasCardFields;
    if (!safe) {
      for (const [c, re] of NAME_PATTERNS) {
        if (login && (c === "send" || c === "publish")) continue;
        if (re.test(label)) found.push({ c, why: `按鈕「${label}」` });
      }
      if (el.form?.hasCardFields) found.push({ c: "payment", why: "表單含付款卡欄位" });
      const onCheckout = CHECKOUT_PATH.test(pathOf(s.pageUrl)) || CHECKOUT_PATH.test(pathOf(el.form?.action));
      if (onCheckout && (CONFIRM_LIKE.test(label) || !!el.form))
        found.push({ c: "payment", why: "結帳頁上的確認動作" });
    }
  }

  for (const r of SAFE_NAMES.test(label) ? [] : rules) {
    const steps = r.steps ?? ["click", "press", "type"];
    if (!steps.includes(s.kind)) continue;
    if ((s.kind === "press" || s.kind === "type") && !submits) continue;
    const url = s.kind === "navigate" ? (s.url ?? "") : targetUrl;
    if (r.domain && !domainMatches(host(url), r.domain) && !domainMatches(host(s.pageUrl), r.domain))
      continue;
    if (r.path && !r.path.test(pathOf(url))) continue;
    if (r.name && !r.name.test(label)) continue;
    if (!r.domain && !r.path && !r.name) continue;
    found.push({ c: r.actionClass, why: `規則 ${r.id}` });
  }

  for (const c of PRIORITY) {
    const hits = found.filter((f) => f.c === c);
    if (hits.length) return { actionClass: c, reasons: [...new Set(hits.map((h) => h.why))] };
  }
  if (s.kind === "navigate") return { actionClass: "network", reasons: [] };
  if (s.kind === "click" && el?.role === "link") return { actionClass: "network", reasons: [] };
  return { actionClass: "write", reasons: [] };
}

/**
 * May a step of class `found` run under an authorization for class `granted`?
 * Ordinary classes always may (the gateway already allowed the call); an
 * always-confirm class needs an approval for exactly that class.
 */
export function stepAllowed(found: ActionClass, granted: ActionClass): boolean {
  return !isAlwaysConfirm(found) || found === granted;
}

export class SensitiveActionError extends Error {
  readonly actionClass: ActionClass;
  readonly summary: string;
  constructor(actionClass: ActionClass, summary: string) {
    super(
      `這一步屬於「${CLASS_LABEL[actionClass] ?? actionClass}」，一律需要使用者批准：${summary}。請單獨再呼叫一次這個動作，主機會出示批准卡。`,
    );
    this.name = "SensitiveActionError";
    this.actionClass = actionClass;
    this.summary = summary;
  }
}

export const CLASS_LABEL: Readonly<Record<string, string>> = {
  payment: "付款",
  send: "寄送",
  delete: "刪除",
  publish: "對外發布",
  write: "修改",
  network: "連線",
  read: "讀取",
  execute: "執行",
};
