/**
 * P15 B2 (plan v11.1 §1 S5): tool arguments are checked against the tool's
 * JSON schema before anything runs. A mismatch goes back to the model as an
 * ordinary tool error it can fix (not a failed step of the run). Light
 * coercion first: "3" → 3, "true" → true, one value → [value], null on an
 * optional field → dropped. Only the subset of JSON Schema our tools use.
 */

type Schema = Record<string, unknown>;

export interface SchemaIssue {
  path: string;
  msg: string;
}

const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

function coerce(v: unknown, s: Schema | undefined): unknown {
  if (!s) return v;
  const t = s.type;
  if (t === "number" || t === "integer") {
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  } else if (t === "boolean") {
    if (v === "true") return true;
    if (v === "false") return false;
  } else if (t === "array") {
    if (v !== undefined && v !== null && !Array.isArray(v)) return [coerce(v, s.items as Schema)];
    if (Array.isArray(v)) return v.map((x) => coerce(x, s.items as Schema));
  } else if (t === "object" && v && typeof v === "object" && !Array.isArray(v)) {
    const props = (s.properties ?? {}) as Record<string, Schema>;
    const req = new Set((s.required as string[] | undefined) ?? []);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === null && !req.has(k)) continue;
      out[k] = coerce(x, props[k]);
    }
    return out;
  }
  return v;
}

function check(v: unknown, s: Schema | undefined, path: string, out: SchemaIssue[]): void {
  if (!s || out.length >= 12) return;
  const t = s.type as string | undefined;
  const actual = typeOf(v);
  if (t) {
    const ok =
      t === actual ||
      (t === "integer" && actual === "number" && Number.isInteger(v)) ||
      (t === "number" && actual === "number");
    if (!ok) {
      out.push({ path: path || "(root)", msg: `應該是 ${t}，收到 ${actual}` });
      return;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.includes(v))
    out.push({ path: path || "(root)", msg: `只能是 ${s.enum.join(" / ")}` });
  if (typeof v === "number" && typeof s.minimum === "number" && v < s.minimum)
    out.push({ path, msg: `不能小於 ${s.minimum}` });
  if (actual === "array")
    for (const [i, x] of (v as unknown[]).entries()) check(x, s.items as Schema, `${path}[${i}]`, out);
  if (actual === "object") {
    const o = v as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of (s.required as string[] | undefined) ?? [])
      if (o[r] === undefined) out.push({ path: path ? `${path}.${r}` : r, msg: "必填" });
    for (const [k, x] of Object.entries(o)) {
      if (props[k]) check(x, props[k], path ? `${path}.${k}` : k, out);
      else if (s.additionalProperties === false)
        out.push({ path: path ? `${path}.${k}` : k, msg: "不是這個工具的參數" });
    }
  }
}

export function validateArgs(
  tool: string,
  schema: Schema | undefined,
  args: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  const coerced = coerce(args ?? {}, schema ?? { type: "object" });
  if (!coerced || typeof coerced !== "object" || Array.isArray(coerced))
    return { ok: false, message: `工具 ${tool} 的參數必須是 JSON 物件。` };
  const issues: SchemaIssue[] = [];
  check(coerced, schema ?? { type: "object" }, "", issues);
  if (!issues.length) return { ok: true, args: coerced as Record<string, unknown> };
  return {
    ok: false,
    message: `工具 ${tool} 參數不符 schema：\n${issues.map((i) => `- ${i.path}: ${i.msg}`).join("\n")}\n請修正後重新呼叫。`,
  };
}

/** Parse streamed JSON arguments, with a small repair (trailing commas, missing closing brackets). */
export function parseArgs(raw: string): { args: Record<string, unknown> } | { error: string } {
  if (!raw.trim()) return { args: {} };
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  let v = tryParse(raw);
  if (v === undefined) {
    let s = raw
      .trim()
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/,\s*$/, "");
    const opens = (s.match(/[{[]/g) ?? []).length - (s.match(/[}\]]/g) ?? []).length;
    if (opens > 0 && opens < 8) {
      const stack: string[] = [];
      for (const ch of s) {
        if (ch === "{") stack.push("}");
        else if (ch === "[") stack.push("]");
        else if (ch === "}" || ch === "]") stack.pop();
      }
      s += stack.reverse().join("");
    }
    v = tryParse(s);
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { error: `參數不是 JSON 物件。收到：${raw.slice(0, 2000)}` };
  return { args: v as Record<string, unknown> };
}

/** The JSON-schema keys the checker above understands (a result schema may use only these). */
const SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "minimum",
  "additionalProperties",
  "description",
]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean"]);

function schemaProblem(s: unknown, path: string, depth: number): string | undefined {
  const at = path || "(root)";
  if (!s || typeof s !== "object" || Array.isArray(s)) return `${at}: 要是 JSON 物件`;
  if (depth > 8) return `${at}: 巢狀太深（最多 8 層）`;
  const o = s as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !SCHEMA_KEYS.has(k));
  if (extra.length)
    return `${at}: 不支援 ${extra.slice(0, 4).join("、")}（只能用 ${[...SCHEMA_KEYS].join("、")}）`;
  if (o.type !== undefined && !SCHEMA_TYPES.has(o.type as string))
    return `${at}.type: 只能是 ${[...SCHEMA_TYPES].join(" / ")}`;
  if (
    o.required !== undefined &&
    !(Array.isArray(o.required) && o.required.every((r) => typeof r === "string"))
  )
    return `${at}.required: 要是字串陣列`;
  if (
    o.enum !== undefined &&
    !(Array.isArray(o.enum) && o.enum.every((v) => v === null || typeof v !== "object"))
  )
    return `${at}.enum: 要是純值陣列`;
  if (o.minimum !== undefined && typeof o.minimum !== "number") return `${at}.minimum: 要是數字`;
  if (o.additionalProperties !== undefined && typeof o.additionalProperties !== "boolean")
    return `${at}.additionalProperties: 只能是 true / false`;
  if (o.description !== undefined && typeof o.description !== "string") return `${at}.description: 要是字串`;
  if (o.items !== undefined) {
    const p = schemaProblem(o.items, `${path}[]`, depth + 1);
    if (p) return p;
  }
  if (o.properties !== undefined) {
    if (!o.properties || typeof o.properties !== "object" || Array.isArray(o.properties))
      return `${at}.properties: 要是 JSON 物件`;
    for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
      const p = schemaProblem(v, path ? `${path}.${k}` : k, depth + 1);
      if (p) return p;
    }
  }
  return undefined;
}

/**
 * Design §0.2.4: a dispatch's `resultSchema` as the router gave it (an object,
 * or JSON text). Only the subset `validateArgs` checks, an object at the root,
 * at most `maxBytes` serialized. Undefined when none was given; throws with
 * the reason otherwise (the router reads it and fixes the call).
 */
export function readResultSchema(raw: unknown, maxBytes: number): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("resultSchema 不是合法的 JSON");
    }
  }
  const problem = schemaProblem(v, "", 0);
  if (problem) throw new Error(`resultSchema 不符：${problem}`);
  const s = v as Record<string, unknown>;
  if (s.type !== "object") throw new Error('resultSchema 最外層要是 {"type":"object", …}');
  const size = Buffer.byteLength(JSON.stringify(s));
  if (size > maxBytes) throw new Error(`resultSchema 太大（${size} 位元組，最多 ${maxBytes}）`);
  return s;
}
