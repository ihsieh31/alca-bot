/**
 * Mac test B8: a model sometimes leaks raw tool-call markup into one of
 * `report_result`'s text fields — the summary ends with
 * `</summary>\n<parameter name="changes">["README.md …"]`. The leaked tail is
 * cut off the text, and the parameters in it are salvaged: a field the call
 * did not carry is taken from the tail (JSON when it parses, else the text;
 * a list that is not JSON becomes one item per line). Only markers of a tool
 * call count: a closing tag named like the field itself,
 * `<parameter name="…">`, `</parameter>`, `<invoke…>` / `</invoke>` and
 * `function_calls` tags, so ordinary text with HTML in it is kept.
 */

const TEXT_FIELDS = ["summary", "result", "unblock", "proposal"] as const;
const LIST_FIELDS = new Set(["changes", "claims", "questions"]);
const TAIL_MARKERS = String.raw`<parameter\s+name\s*=|</parameter>|</?invoke\b|</?(?:[a-z]+:)?function_calls>`;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function leakStart(text: string, field: string): number {
  const m = new RegExp(`</${esc(field)}>|${TAIL_MARKERS}`, "i").exec(text);
  return m ? m.index : -1;
}

/** `<parameter name="x">value` pairs in a leaked tail (each value up to the next marker). */
function paramsOf(tail: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(
    String.raw`<parameter\s+name\s*=\s*"([A-Za-z_][\w-]*)"\s*>([\s\S]*?)(?=${TAIL_MARKERS}|$)`,
    "gi",
  );
  for (let m = re.exec(tail); m; m = re.exec(tail)) {
    const [, name, value] = m;
    if (name && value !== undefined && !(name in out)) out[name] = value.trim();
  }
  return out;
}

function parsedValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Whether the call already carried this field (text with something in it, a list with items, anything else set). */
function carried(v: unknown): boolean {
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined;
}

/** report_result's arguments with leaked tool-call markup cut out of the text fields and its fields salvaged. */
export function cleanReportArgs(a: Record<string, unknown>): Record<string, unknown> {
  let out = a;
  for (const field of TEXT_FIELDS) {
    const v = out[field];
    if (typeof v !== "string") continue;
    const at = leakStart(v, field);
    if (at < 0) continue;
    const salvaged = paramsOf(v.slice(at));
    out = { ...out, [field]: v.slice(0, at).trimEnd() };
    for (const [name, raw] of Object.entries(salvaged)) {
      if (carried(out[name])) continue;
      const value = parsedValue(raw);
      out = {
        ...out,
        [name]:
          LIST_FIELDS.has(name) && typeof value === "string"
            ? value
                .split("\n")
                .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
                .filter(Boolean)
            : value,
      };
    }
  }
  return out;
}
