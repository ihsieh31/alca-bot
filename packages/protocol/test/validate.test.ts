import { describe, expect, it } from "vitest";
import {
  buildJsonSchema,
  EVENT_TYPES,
  InvalidEventError,
  idPattern,
  isAlcaEvent,
  newId,
  parseEvent,
  parseEventJson,
  validateEvent,
} from "../src/index.ts";
import { happyRun } from "./fixtures.ts";

describe("ids", () => {
  it("generates prefixed, pattern-valid, time-sortable ids", () => {
    const a = newId("thread", 1000);
    const b = newId("thread", 2000);
    expect(a).toMatch(idPattern("thread"));
    expect(a.slice(0, 14) < b.slice(0, 14)).toBe(true);
    expect(newId("run")).not.toMatch(idPattern("thread"));
  });
});

describe("event validation", () => {
  const { events } = happyRun();

  it("covers all 12 event types", () => {
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(EVENT_TYPES));
    expect(EVENT_TYPES).toHaveLength(12);
  });

  it("round-trips every event through JSON", () => {
    for (const e of events) {
      expect(parseEventJson(JSON.stringify(e))).toEqual(e);
      expect(isAlcaEvent(e)).toBe(true);
    }
  });

  it("rejects unknown event types", () => {
    const bad = { ...events[0], type: "run.exploded" };
    expect(validateEvent(bad).ok).toBe(false);
  });

  it("rejects unknown envelope keys and wrong protocol version", () => {
    expect(validateEvent({ ...events[0], extra: 1 }).ok).toBe(false);
    expect(validateEvent({ ...events[0], v: 1 }).ok).toBe(false);
  });

  it("rejects malformed ids, negative seq and bad initiator kinds", () => {
    const base = events[0];
    expect(validateEvent({ ...base, threadId: "thread-1" }).ok).toBe(false);
    expect(validateEvent({ ...base, runId: base?.threadId }).ok).toBe(false);
    expect(validateEvent({ ...base, seq: -1 }).ok).toBe(false);
    expect(validateEvent({ ...base, seq: 1.5 }).ok).toBe(false);
    expect(validateEvent({ ...base, initiator: { kind: "robot", id: "x" } }).ok).toBe(false);
  });

  it("requires a valid finish reason on run.finished", () => {
    const fin = events.at(-1);
    expect(fin?.type).toBe("run.finished");
    expect(validateEvent({ ...fin, data: { reason: "bored" } }).ok).toBe(false);
    expect(validateEvent({ ...fin, data: {} }).ok).toBe(false);
  });

  it("requires an action class on tool.requested", () => {
    const req = events.find((e) => e.type === "tool.requested");
    const { actionClass: _drop, ...data } = (req?.data ?? {}) as Record<string, unknown>;
    expect(validateEvent({ ...req, data }).ok).toBe(false);
  });

  it("reports issue paths and throws typed errors", () => {
    const r = validateEvent({ ...events[0], seq: "zero" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === "seq")).toBe(true);
    expect(() => parseEvent({})).toThrow(InvalidEventError);
    expect(() => parseEventJson("{not json")).toThrow(InvalidEventError);
  });
});

describe("json schema export", () => {
  it("contains one branch per event type", () => {
    const schema = buildJsonSchema();
    const branches = (schema.oneOf ?? schema.anyOf) as Array<{
      properties: { type: { const: string } };
    }>;
    expect(branches.map((b) => b.properties.type.const).sort()).toEqual([...EVENT_TYPES].sort());
    expect(schema.$schema).toContain("2020-12");
  });
});
