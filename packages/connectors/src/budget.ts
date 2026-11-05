/**
 * Result shaping for connected-app data before a model sees it: compact,
 * long strings cut, arrays shortened, the whole thing under a character
 * budget, and fenced as untrusted data (an email body is not an instruction).
 */
import { defuseAlcaTags } from "@alca/tools";

function prune(v: unknown, depth: number, strMax: number, arrMax: number): unknown {
  if (typeof v === "string")
    return v.length > strMax ? `${v.slice(0, strMax)}…（截斷，原長 ${v.length} 字）` : v;
  if (v === null || typeof v !== "object") return v;
  if (depth > 6) return "…";
  if (Array.isArray(v)) {
    const out = v.slice(0, arrMax).map((x) => prune(x, depth + 1, strMax, arrMax));
    if (v.length > arrMax) out.push(`…（還有 ${v.length - arrMax} 筆）`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    // Never pass along anything that looks like a credential field.
    if (/^(access_token|refresh_token|id_token|api_key|password|secret|authorization|cookie)$/i.test(k))
      continue;
    out[k] = prune(x, depth + 1, strMax, arrMax);
  }
  return out;
}

export function budgetJson(v: unknown, maxChars: number): { text: string; truncated: boolean } {
  let strMax = 2000;
  let arrMax = 50;
  let text = JSON.stringify(prune(v, 0, strMax, arrMax)) ?? "null";
  let truncated = false;
  while (text.length > maxChars && strMax > 60) {
    truncated = true;
    strMax = Math.floor(strMax / 2);
    arrMax = Math.max(3, Math.floor(arrMax / 2));
    text = JSON.stringify(prune(v, 0, strMax, arrMax)) ?? "null";
  }
  if (text.length > maxChars) {
    truncated = true;
    text = `${text.slice(0, maxChars)}…`;
  }
  return { text, truncated };
}

const esc = (s: string) => s.replaceAll('"', "'").replaceAll("<", "‹");

export function fenceApp(o: {
  toolkit: string;
  tool: string;
  account: string;
  body: string;
  truncated: boolean;
}): string {
  return [
    `<alca:app toolkit="${esc(o.toolkit)}" tool="${esc(o.tool)}" account="${esc(o.account)}" trust="untrusted"${o.truncated ? ' truncated="true"' : ""}>`,
    defuseAlcaTags(o.body),
    "</alca:app>",
  ].join("\n");
}

/** Read a dotted path (`data.messages`) out of a tool result. */
export function pick(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const k of path.split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
