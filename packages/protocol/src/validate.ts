import { type AlcaEvent, AlcaEventSchema } from "./events.ts";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; event: AlcaEvent } | { ok: false; issues: ValidationIssue[] };

/** Validate an unknown value as an Alca event without throwing. */
export function validateEvent(value: unknown): ValidationResult {
  const parsed = AlcaEventSchema.safeParse(value);
  if (parsed.success) return { ok: true, event: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({
      path: i.path.map(String).join("."),
      message: i.message,
    })),
  };
}

export class InvalidEventError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`invalid Alca event: ${issues.map((i) => `${i.path || "<root>"}: ${i.message}`).join("; ")}`);
    this.name = "InvalidEventError";
    this.issues = issues;
  }
}

/** Validate or throw InvalidEventError. */
export function parseEvent(value: unknown): AlcaEvent {
  const r = validateEvent(value);
  if (!r.ok) throw new InvalidEventError(r.issues);
  return r.event;
}

export function isAlcaEvent(value: unknown): value is AlcaEvent {
  return AlcaEventSchema.safeParse(value).success;
}

/** Parse one NDJSON / WebSocket text frame. */
export function parseEventJson(text: string): AlcaEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InvalidEventError([{ path: "", message: "not valid JSON" }]);
  }
  return parseEvent(raw);
}
