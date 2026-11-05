import type { ScriptContext, ScriptStep } from "@alca/engines";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkResultData,
  ReadCheck,
  type RoutineItem,
  readResultSchema,
  routineOutputSchema,
} from "../src/index.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";

/**
 * Design §0.2.4: structured results. A dispatch may carry a `resultSchema`;
 * `report_result.data` is checked against it with the same checker as tool
 * arguments, and a mismatch goes back to the model to fix. Routines and the
 * reviewer read the structured value instead of fishing JSON out of text.
 * Fictional data only.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const schema = routineOutputSchema(["m1", "m2"]);
const base = { status: "done" as const, summary: "好", changes: [], claims: [] };

describe("report_result.data against the dispatch's schema", () => {
  it("valid data is kept; wrong type, unknown id and a missing done data are refused; other statuses ignore it", () => {
    expect(checkResultData(base, { quiet: true }, schema)).toMatchObject({ data: { quiet: true } });
    expect(checkResultData(base, { quiet: 5 }, schema)).toMatch(/quiet: 應該是 boolean/);
    expect(checkResultData(base, { quiet: false, items: [{ id: "zzz", note: "編的" }] }, schema)).toMatch(
      /items\[0\]\.id: 只能是 m1 \/ m2/,
    );
    expect(checkResultData(base, undefined, schema)).toMatch(/status=done 時要附 data/);
    expect(checkResultData({ ...base, status: "partial" }, undefined, schema)).toEqual({
      ...base,
      status: "partial",
    });
    expect(
      checkResultData({ ...base, status: "blocked", unblock: "登入" }, { quiet: 5 }, schema),
    ).not.toBeTypeOf("string");
    // No schema: nothing to check, data is not taken.
    expect(checkResultData(base, { anything: 1 }, undefined)).toEqual(base);
  });

  it("a schema too big for the id enum falls back to plain strings", () => {
    const many = Array.from({ length: 400 }, (_, i) => `msg-${i}-${"x".repeat(20)}`);
    const s = routineOutputSchema(many) as {
      properties: { items: { items: { properties: { id: object } } } };
    };
    expect(s.properties.items.items.properties.id).toEqual({ type: "string" });
  });
});

describe("a routine's AI run reports structured data (design §0.2.4)", () => {
  it("a wrong type is sent back, the fixed report is taken, and the run is ai_done, not ai_invalid", async () => {
    let source: RoutineItem[] = [];
    const errors: string[] = [];
    const check = new ReadCheck(
      "inbox",
      async () => source,
      () => "信箱",
    );
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0 && !req.userMessage.includes("<alca:records")) return say("好");
      if (pass === 0)
        return call("r1", "report_result", { status: "done", summary: "一封要回", data: { quiet: "no" } });
      if (pass === 1) {
        errors.push(req.toolResults?.[0]?.output ?? "");
        return call("r2", "report_result", {
          status: "done",
          summary: "一封要回",
          data: { quiet: false, items: [{ id: "m1", note: "客戶在等報價" }], summary: "一封要回" },
        });
      }
      return say("完成");
    };
    h = makeAgents({ router: () => say("收到"), worker, checks: [check] });
    const t = h.core.createThread("例行");
    const r = h.agents.routines.create({
      threadId: t.id,
      name: "收信",
      kind: "interval",
      intervalSec: 3600,
      check: { kind: "inbox" },
    });
    source = [{ id: "m1", title: "報價" }];
    expect((await h.agents.routines.runNow(r.id))?.outcome).toBe("new");
    await until(() => (h?.store.routines.runs(r.id)[0]?.outcome === "ai_done" ? true : undefined), 20_000);
    expect(errors[0]).toMatch(/quiet: 應該是 boolean/);
    expect(h.store.routines.runs(r.id).map((x) => x.outcome)).toEqual(["ai_done", "new"]);
    expect(h.store.routines.get(r.id)?.cursor).toEqual({ seen: ["m1"] });
    const w = h.store.workers.byThread(t.id)[0];
    expect(w?.grants.resultSchema).toBeDefined();
  }, 30_000);
});

describe("the reviewer answers with review_verdict (design §0.2.4)", () => {
  it("a verdict that fails its schema is fixed once; the gaps reach the worker", async () => {
    const reviews: number[] = [];
    const fed: string[] = [];
    let reports = 0;
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (req.sessionKey?.includes("~review")) {
        reviews.push(pass);
        if (reports === 1) {
          // First review: a wrong type, then the fixed verdict (not met).
          if (pass === 0) return call("v1", "review_verdict", { met: "maybe", gaps: [] });
          if (pass === 1) return call("v2", "review_verdict", { met: false, gaps: ["少了第三項"] });
          return say("（不該到這裡）");
        }
        return pass === 0 ? call("v3", "review_verdict", { met: true, gaps: [] }) : say("好");
      }
      if (pass === 0) {
        if (req.userMessage.includes("獨立審查者")) fed.push(req.userMessage);
        reports++;
        return call(`r${reports}`, "report_result", {
          status: "done",
          summary: `清單整理好了（第 ${reports} 版）`,
        });
      }
      return say("完成");
    };
    const router = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (req.userMessage.includes("<alca:worker")) return say("收到回報");
      return pass === 0
        ? call("s", "worker_start", {
            title: "整理清單",
            goal: lastLine(req.userMessage),
            harness: "general",
          })
        : say("派了");
    };
    h = makeAgents({ router, worker, level: "autonomous" });
    h.store.bots.update(h.store.bots.ensureDefault().id, { harness: JSON.stringify({ reviewer: true }) });
    const t = h.core.createThread();
    await h.core.send(t.id, "整理清單").done;
    await until(
      () =>
        h?.store.threads
          .messages(t.id)
          .find((m) => m.role === "system" && m.content.includes("<alca:worker")),
      25_000,
    );
    expect(reports).toBe(2);
    // Review 1: wrong type, then fixed; review 2: met, then its closing pass.
    expect(reviews).toEqual([0, 1, 0, 1]);
    expect(fed.join("\n")).toContain("少了第三項");
    const dsp = h.store.workers.byThread(t.id)[0]?.grants.dispatchId ?? "";
    expect(h.store.dispatches.get(dsp)).toMatchObject({ status: "settled", outcome: "done" });
    const verdicts = h.store.dispatches.events(dsp).filter((e) => e.kind.startsWith("review."));
    expect(verdicts.map((e) => e.kind)).toEqual(["review.result", "review.result"]);
  }, 40_000);
});

describe("the router asks for a structured result (worker_start resultSchema, design §0.2.4)", () => {
  const PRICES = {
    type: "object",
    properties: {
      hotels: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, price: { type: "integer", minimum: 0 } },
          required: ["name", "price"],
          additionalProperties: false,
        },
      },
    },
    required: ["hotels"],
    additionalProperties: false,
  };

  it("readResultSchema keeps the supported subset and refuses the rest", () => {
    expect(readResultSchema(undefined, 8192)).toBeUndefined();
    expect(readResultSchema(PRICES, 8192)).toEqual(PRICES);
    expect(readResultSchema(JSON.stringify(PRICES), 8192)).toEqual(PRICES);
    expect(() => readResultSchema({ type: "object", oneOf: [] }, 8192)).toThrow(/不支援 oneOf/);
    expect(() => readResultSchema({ type: "array", items: { type: "string" } }, 8192)).toThrow(/最外層/);
    expect(() => readResultSchema({ type: "object", properties: { a: { type: "date" } } }, 8192)).toThrow(
      /a\.type/,
    );
    expect(() => readResultSchema("{not json", 8192)).toThrow(/不是合法的 JSON/);
    expect(() => readResultSchema(PRICES, 100)).toThrow(/太大/);
  });

  it("the schema rides on the grants, a wrong data is sent back, and the router reads the checked data", async () => {
    const toolOut: string[] = [];
    const reports: string[] = [];
    const router = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (req.userMessage.includes("<alca:worker")) {
        if (pass === 0) reports.push(req.userMessage);
        return say("收到回報");
      }
      if (pass === 0)
        return call("s0", "worker_start", {
          title: "比價",
          goal: lastLine(req.userMessage),
          harness: "general",
          resultSchema: { type: "object", anyOf: [] },
        });
      if (pass === 1) {
        toolOut.push(req.toolResults?.[0]?.output ?? "");
        return call("s1", "worker_start", {
          title: "比價",
          goal: "比三家飯店的價格",
          harness: "general",
          resultSchema: PRICES,
        });
      }
      return say("派了");
    };
    const fixes: string[] = [];
    const worker = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (pass === 0)
        return call("r1", "report_result", {
          status: "done",
          summary: "三家比好了",
          data: { hotels: [{ name: "海景飯店", price: "很便宜" }] },
        });
      if (pass === 1) {
        fixes.push(req.toolResults?.[0]?.output ?? "");
        return call("r2", "report_result", {
          status: "done",
          summary: "三家比好了",
          data: { hotels: [{ name: "海景飯店", price: 3200 }] },
        });
      }
      return say("完成");
    };
    h = makeAgents({ router, worker, level: "autonomous" });
    const t = h.core.createThread();
    await h.core.send(t.id, "比三家飯店的價格").done;
    await until(() => reports[0], 20_000);
    expect(toolOut[0]).toMatch(/不支援 anyOf/);
    const ws = h.store.workers.byThread(t.id);
    expect(ws).toHaveLength(1);
    expect(ws[0]?.grants.resultSchema).toEqual(PRICES);
    expect(fixes[0]).toMatch(/hotels\[0\]\.price: 應該是 integer/);
    expect(reports[0]).toContain(
      '結構化結果（data，已照 resultSchema 檢查）：{"hotels":[{"name":"海景飯店","price":3200}]}',
    );
    const dsp = ws[0]?.grants.dispatchId ?? "";
    expect(h.store.dispatches.get(dsp)).toMatchObject({ status: "settled", outcome: "done" });
  }, 30_000);
});
