/**
 * Secret filter. Memory and skills must never hold a credential: a candidate
 * memory that contains one is dropped whole (not masked and kept), and
 * learned skill steps have such values replaced by a marker. Errs on the side
 * of flagging: losing a harmless note is cheaper than keeping a password.
 */

export type SecretKind =
  | "private_key"
  | "token"
  | "jwt"
  | "bearer"
  | "url_credentials"
  | "url_secret_param"
  | "labelled_secret"
  | "card_number"
  | "national_id"
  | "high_entropy";

export interface SecretFinding {
  kind: SecretKind;
  start: number;
  end: number;
}

export const REDACTED = "[已遮蔽]";

const PATTERNS: Array<[SecretKind, RegExp]> = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  [
    "token",
    /\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|pk_(?:live|test)_[A-Za-z0-9]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,})/g,
  ],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi],
  ["url_credentials", /\/\/[^\s/:@]+:[^\s/@]+@/g],
  [
    "url_secret_param",
    /[?&#](?:access_token|token|api_key|apikey|key|secret|password|passwd|sig|signature|code)=[^&\s#]+/gi,
  ],
];

/** "密碼是 xxx", "password: xxx", "驗證碼 123456" — the value after the label. */
const LABELLED =
  /(?:\b(?:password|passwd|pwd|passcode|passphrase|pin(?:\s*code)?|otp|one[- ]time code|secret|token|api[ _-]?key|access key|private key|seed phrase|recovery phrase|cvv|cvc|security code)\b|密碼|密码|口令|驗證碼|验证码|認證碼|一次性密碼|PIN\s*碼|金鑰|密鑰|私鑰|助記詞|註記詞|安全碼|提款卡密碼|網銀密碼)\s*(?:是|為|为|是不是)?\s*[:：=]?\s*([^\s，。,;；]{1,200})/gi;

const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const TW_ID = /\b[A-Z][12489]\d{8}\b/g;
const HIGH_ENTROPY = /[A-Za-z0-9+/_=-]{28,}/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const TW_LETTER = "ABCDEFGHJKLMNPQRSTUVXYWZIO";
function twIdValid(id: string): boolean {
  const n = TW_LETTER.indexOf(id.charAt(0)) + 10;
  if (n < 10) return false;
  const nums = [Math.floor(n / 10), n % 10, ...id.slice(1).split("").map(Number)];
  const w = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  return nums.reduce((s, d, i) => s + d * (w[i] as number), 0) % 10 === 0;
}

function entropyLooksSecret(s: string): boolean {
  if (/^[a-z]+$/i.test(s) || /^\d+$/.test(s)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(s)).length;
  if (/^[0-9a-f]{32,}$/i.test(s)) return true; // hex digests, keys
  if (classes < 3) return false;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h >= 3.5;
}

/** Every secret-looking span, merged and sorted. */
export function findSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const [kind, re] of PATTERNS)
    for (const m of text.matchAll(re))
      out.push({ kind, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  for (const m of text.matchAll(LABELLED)) {
    const value = m[1] ?? "";
    // "密碼很難記" is not a password, but we cannot tell; only skip obvious non-values.
    if (/^(?:嗎|呢|了|的|啊|喔|忘了|錯了|改了)$/.test(value)) continue;
    const start = (m.index ?? 0) + m[0].length - value.length;
    out.push({ kind: "labelled_secret", start, end: start + value.length });
  }
  for (const m of text.matchAll(CARD)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits))
      out.push({ kind: "card_number", start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  for (const m of text.matchAll(TW_ID))
    if (twIdValid(m[0]))
      out.push({ kind: "national_id", start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  for (const m of text.matchAll(HIGH_ENTROPY))
    if (entropyLooksSecret(m[0]))
      out.push({ kind: "high_entropy", start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretFinding[] = [];
  for (const f of out) {
    const last = merged.at(-1);
    if (last && f.start <= last.end) last.end = Math.max(last.end, f.end);
    else merged.push({ ...f });
  }
  return merged;
}

export function containsSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}

/** Replace every secret-looking span with the marker. */
export function redact(text: string): string {
  let out = "";
  let at = 0;
  for (const f of findSecrets(text)) {
    out += text.slice(at, f.start) + REDACTED;
    at = f.end;
  }
  return out + text.slice(at);
}

const SECRET_KEY =
  /pass(?:word|wd|code)?|secret|token|api[_-]?key|auth|cookie|session|otp|pin|cvv|cvc|card|密碼|金鑰|驗證碼/i;

/** Deep copy with secret values masked; a value under a secret-sounding key is masked whatever it looks like. */
export function redactValue<T>(value: T, key = ""): T {
  if (typeof value === "string") return (SECRET_KEY.test(key) && value ? REDACTED : redact(value)) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, key)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, k);
    return out as T;
  }
  return value;
}
