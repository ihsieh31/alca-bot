import { randomBytes } from "node:crypto";
import type { ScriptContext } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { openStore, Sealer, type Store } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AddonCompletion,
  AppSource,
  type Candidate,
  OFFER_SOURCE,
  parseCandidates,
  proposalOf,
  proposalText,
  scoreCandidate,
} from "../src/index.ts";
import { call, type Harness, lastLine, makeAgents, say, until } from "./agents-helpers.ts";
import { tool } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const DUE_7 = new Date(Date.UTC(2026, 10, 7, 15, 59)).toISOString(); // Sat 11/7 23:59 in Taipei
const DUE_8 = new Date(Date.UTC(2026, 10, 8, 15, 59)).toISOString(); // Sun 11/8 23:59 in Taipei
const T0 = Date.parse("2026-11-04T02:00:00Z"); // Wed 10:00 in Taipei

/** A fake bot engine for the candidate step: cites the first evidence id it was shown. */
function fakeComplete(make?: (ids: string[]) => unknown) {
  const calls: string[] = [];
  const complete: AddonCompletion = async ({ prompt }) => {
    calls.push(prompt);
    const ids = [...prompt.matchAll(/id=(\S+)/gu)].map((m) => m[1] as string);
    const body = make
      ? make(ids)
      : {
          candidates: [
            {
              fact: "11 月 7 日要交報告",
              action: "排寫作進度",
              category: "study",
              due_at: "2026-11-07T15:59:00Z",
              evidence_ids: ids.slice(0, 1),
            },
          ],
        };
    return { text: JSON.stringify(body), inputTokens: 1200, outputTokens: 80 };
  };
  return { complete, calls };
}

function worker({ req, pass }: ScriptContext) {
  const msg = req.userMessage;
  // Plan §5: the homework is a general-harness worker; its proposal comes in report_result.proposal.
  if (pass > 0 && req.toolResults?.[0]?.id === "w-send")
    return call("rep", "report_result", {
      status: "done",
      summary: "查好了：報告 11/7 23:59 截止。",
      proposal: "報告 11 月 7 日 23:59 截止。要我幫你排寫作進度嗎？",
    });
  if (msg.includes("主動留意發現了一件事")) {
    if (pass === 0)
      return [
        { type: "tool.call" as const, id: "w-send", name: "send_mail", input: { to: "x@example.org" } },
        { type: "done" as const, stop: "tool_use" as const },
      ];
    return say("查好了：報告 11/7 23:59 截止。\n提案：報告 11 月 7 日 23:59 截止。要我幫你排寫作進度嗎？");
  }
  if (lastLine(msg).includes("請去做")) return say("排好了。");
  return say("x");
}

function setup(o: { make?: (ids: string[]) => unknown; now?: () => number; store?: Store } = {}) {
  let now = T0;
  const clock = () => new Date(o.now?.() ?? now);
  const fake = fakeComplete(o.make);
  const send = tool("send_mail", "send");
  h = makeAgents({
    router: () => say("好"),
    worker,
    tools: [send],
    system: { now: clock, addonComplete: fake.complete },
    ...(o.store ? { store: o.store } : {}),
  });
  const bot = h.store.bots.ensureDefault().id;
  const remember = (body: string, dueAt: string) =>
    h!.agents.learning!.memory.remember(
      bot,
      { kind: "project", subject: `due:${body}`, body, quote: body, confidence: 1, dueAt },
      {},
      { scope: "shared" },
    );
  return {
    h,
    bot,
    send,
    fake,
    remember,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("P14 C: 主動留意", () => {
  it("off → never scans; on with nothing new → quiet with 0 tokens", async () => {
    const { h, bot, fake } = setup();
    expect((await h.agents.proactive.scan(bot, { force: true })).outcome).toBe("off");
    h.agents.addons.set(bot, "proactive", { enabled: true });
    const r = await h.agents.proactive.scan(bot, { force: true });
    expect(r.outcome).toBe("quiet");
    expect(fake.calls).toHaveLength(0);
    expect(h.agents.addons.usage(bot, "proactive")).toMatchObject({ runs: 0, tokens: 0 });
  });

  it("a deadline → one candidate → read-only homework → an offer card; 好 starts a normal worker", async () => {
    const { h, bot, send, fake, remember } = setup();
    remember("11月7日要交報告", "2026-11-07T15:59:00Z");
    h.agents.addons.set(bot, "proactive", { enabled: true });
    const r = await h.agents.proactive.scan(bot, { force: true });
    expect(r.outcome).toBe("homework");
    expect(r.scores?.[0]?.score.total).toBeGreaterThan(0.55);
    expect(fake.calls[0]).toContain('<alca:evidence trust="untrusted">');
    expect(fake.calls[0]).toContain("11月7日要交報告");
    // The homework worker tried a send: refused before the gate, no card, nothing sent.
    const offer = await until(() => h.store.offers.list({ source: OFFER_SOURCE })[0]);
    expect(send.calls).toHaveLength(0);
    expect(h.events.some((e: AlcaEvent) => e.type === "approval.requested")).toBe(false);
    expect(offer).toMatchObject({
      status: "pending",
      queued: false,
      category: "study",
      text: "報告 11 月 7 日 23:59 截止。要我幫你排寫作進度嗎？",
    });
    expect(offer.evidence[0]).toMatch(/^due:mem_/);
    expect(h.agentEvents.some((e) => e.type === "offer.created")).toBe(true);
    expect(h.agents.proactive.pending(bot).map((o) => o.id)).toEqual([offer.id]);
    const usage = h.agents.addons.usage(bot, "proactive");
    expect(usage?.runs).toBe(2);
    expect(usage?.tokens).toBeGreaterThanOrEqual(1280);

    // The same evidence is not offered twice.
    expect((await h.agents.proactive.scan(bot, { force: true })).outcome).toBe("quiet");

    const done = h.agents.proactive.answer(offer.id, "yes");
    expect(done.status).toBe("accepted");
    expect(done.workerId).toBeTruthy();
    await until(() => h.store.workers.get(done.workerId!)?.status === "succeeded");
    expect(h.store.workers.get(done.workerId!)?.initiator.kind).toBe("user");
  }, 20_000);

  it("quiet hours queue the card; it is shown when the window opens; turning off clears the queue", async () => {
    let now = Date.parse("2026-11-04T15:00:00Z"); // 23:00 in Taipei
    // The second scan's evidence is another matter (gap P8: the same fact twice is a duplicate).
    let n = 0;
    const make = (ids: string[]) => ({
      candidates: [
        n++ === 0
          ? {
              fact: "11 月 7 日要交報告",
              action: "排寫作進度",
              category: "study",
              due_at: DUE_7,
              evidence_ids: ids.slice(0, 1),
            }
          : {
              fact: "11 月 8 日要繳電費",
              action: "整理繳費資料",
              category: "money_account",
              due_at: DUE_8,
              evidence_ids: ids.slice(0, 1),
            },
      ],
    });
    const { h, bot, remember } = setup({ now: () => now, make });
    remember("11月7日要交報告", "2026-11-07T15:59:00Z");
    h.agents.addons.set(bot, "proactive", { enabled: true, settings: { dailyRunCap: 1 } });
    const r = await h.agents.proactive.scan(bot, { force: true });
    // One run allowed today: no homework, the candidate text is used; it is night, so it waits.
    expect(r.outcome).toBe("queued");
    expect(r.offer?.text).toBe(proposalText("11 月 7 日要交報告", "排寫作進度"));
    expect(h.agentEvents.some((e) => e.type === "offer.created")).toBe(false);
    expect(h.agents.proactive.pending(bot)).toEqual([]);
    // The cap: the next scan does not run and says so once.
    expect((await h.agents.proactive.scan(bot, { force: true })).outcome).toBe("capped");
    expect(h.agentEvents.filter((e) => e.type === "addon.capped")).toHaveLength(1);

    now = Date.parse("2026-11-05T01:00:00Z"); // 09:00
    const shown = h.agents.proactive.release(bot);
    expect(shown?.id).toBe(r.offer?.id);
    expect(h.agentEvents.some((e) => e.type === "offer.created")).toBe(true);

    remember("11月8日要繳電費", "2026-11-08T15:59:00Z");
    h.agents.addons.set(bot, "proactive", { settings: { dailyRunCap: 5, minIntervalHours: 3 } });
    const second = await h.agents.proactive.scan(bot, { force: true });
    // Shown an hour ago: the minimum gap queues the next one.
    expect(["queued", "homework"]).toContain(second.outcome);
    h.agents.addons.set(bot, "proactive", { enabled: false });
    expect(h.store.offers.list({ source: OFFER_SOURCE, queued: true, status: ["pending"] })).toEqual([]);
  }, 20_000);

  it("先不用 declines; 別再提這類 stores a suppress rule that zeroes the next candidate of that kind", async () => {
    const { h, bot, remember, advance } = setup();
    remember("11月7日要交報告", "2026-11-07T15:59:00Z");
    h.agents.addons.set(bot, "proactive", { enabled: true, settings: { dailyTokenCap: 1000 } });
    const r = await h.agents.proactive.scan(bot, { force: true });
    expect(r.outcome).toBe("offered");
    expect(h.agents.proactive.answer(r.offer!.id, "never").status).toBe("declined");
    const sup = h.store.memory.list().find((m) => m.subject.startsWith("suppress:"));
    expect(sup?.body).toBe("不要主動提：讀書・排寫作進度");
    expect(sup?.origin).toBe("user");

    advance(86400_000); // a new day: the token cap is fresh
    remember("11月9日要交另一份報告", "2026-11-09T15:59:00Z");
    const again = await h.agents.proactive.scan(bot, { force: true });
    expect(again.outcome).toBe("no_candidate");
    expect(again.scores?.[0]?.score.reason).toBe("suppressed");
  }, 20_000);

  it("sealed store (review #2/#3): no candidate words in offers.topic or the add-on state; 別再提這類 still matches", async () => {
    const key = new Sealer({ current: 1, keys: { "1": randomBytes(32).toString("base64") } });
    const { h, bot, remember, advance } = setup({ store: openStore(":memory:", undefined, { sealer: key }) });
    remember("11月7日要交報告", "2026-11-07T15:59:00Z");
    h.agents.addons.set(bot, "proactive", { enabled: true, settings: { dailyTokenCap: 1000 } });
    const r = await h.agents.proactive.scan(bot, { force: true });
    expect(r.outcome).toBe("offered");
    const raw = h.store.db
      .prepare("SELECT topic, text, action FROM offers WHERE id = ?")
      .get(r.offer!.id) as Record<string, string>;
    for (const v of Object.values(raw)) expect(v).not.toContain("寫作");
    const state = h.store.db.prepare("SELECT state_json FROM bot_addons WHERE bot_id = ?").get(bot) as {
      state_json: string;
    };
    expect(state.state_json.startsWith('{"$enc":1')).toBe(true);
    expect(h.store.offers.get(r.offer!.id)?.topic).toBe("排寫作進度");
    h.agents.proactive.answer(r.offer!.id, "never");
    advance(86400_000);
    remember("11月9日要交另一份報告", "2026-11-09T15:59:00Z");
    const again = await h.agents.proactive.scan(bot, { force: true });
    expect(again.scores?.[0]?.score.reason).toBe("suppressed");
  }, 20_000);

  it("sealed store (review extra): the homework worker's title is generic; the fact is only in the sealed goal", async () => {
    const key = new Sealer({ current: 1, keys: { "1": randomBytes(32).toString("base64") } });
    const { h, bot, remember } = setup({ store: openStore(":memory:", undefined, { sealer: key }) });
    remember("11月7日要交報告", "2026-11-07T15:59:00Z");
    h.agents.addons.set(bot, "proactive", { enabled: true });
    expect((await h.agents.proactive.scan(bot, { force: true })).outcome).toBe("homework");
    const rows = h.store.db.prepare("SELECT id, title, goal FROM workers").all() as Array<{
      id: string;
      title: string;
      goal: string;
    }>;
    const hw = rows.find((w) => w.title.startsWith("主動留意"));
    expect(hw?.title).toBe("主動留意・讀書");
    expect(hw?.goal.startsWith('{"$enc":1')).toBe(true);
    expect(h.store.workers.get(hw!.id)?.goal).toContain("報告");
    for (const w of rows) expect(w.title).not.toContain("報告");
  }, 20_000);

  it("output that is not the schema or cites unknown evidence is dropped", async () => {
    const ev = [{ id: "due:a", source: "deadlines" as const, title: "x" }];
    expect(parseCandidates("not json", ev)).toEqual([]);
    expect(
      parseCandidates(
        '{"candidates":[{"fact":"f","action":"a","category":"study","evidence_ids":["due:zzz"]}]}',
        ev,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(
        '{"candidates":[{"fact":"f","action":"a","category":"nope","evidence_ids":["due:a"]}]}',
        ev,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(
        '{"candidates":[{"fact":"f","action":"a","category":"study","evidence_ids":["due:a"]}]}',
        ev,
      ),
    ).toHaveLength(1);
  });

  it("scores: sooner is higher, overdue is 0, the category accept rate moves the order", () => {
    const now = new Date(T0);
    const c = (dueDays: number | null, category: Candidate["category"] = "errand"): Candidate => ({
      fact: "續訂",
      action: "提醒續訂",
      category,
      evidenceIds: ["x"],
      ...(dueDays !== null ? { dueAt: new Date(T0 + dueDays * 86400_000).toISOString() } : {}),
    });
    const base = {
      now,
      profile: [],
      doable: 1,
      stats: { accepted: 0, total: 0 },
      suppress: [],
      evidenceUsed: false,
    };
    const soon = scoreCandidate({ ...base, candidate: c(1) }).total;
    const later = scoreCandidate({ ...base, candidate: c(10) }).total;
    expect(soon).toBeGreaterThan(later);
    expect(scoreCandidate({ ...base, candidate: c(-1) }).total).toBe(0);
    const liked = scoreCandidate({ ...base, candidate: c(3), stats: { accepted: 4, total: 4 } }).total;
    const disliked = scoreCandidate({ ...base, candidate: c(3), stats: { accepted: 0, total: 3 } }).total;
    expect(liked).toBeGreaterThan(disliked);
    expect(scoreCandidate({ ...base, candidate: c(3), evidenceUsed: true }).total).toBe(0);
    expect(scoreCandidate({ ...base, candidate: c(3), suppress: ["續訂"] }).reason).toBe("suppressed");
  });

  it("calendar items through a host reader; started events are skipped; a read failure is not quiet", async () => {
    let fail = false;
    const cal = new AppSource("calendar", async () => {
      if (fail) throw new Error("連線失敗");
      return [
        { id: "e1", title: "牙醫", startsAt: "2026-11-06T02:00:00Z" },
        { id: "e0", title: "已經開始", startsAt: "2026-11-03T02:00:00Z" },
      ];
    });
    const now = new Date(T0);
    const r = await cal.read({ botId: "b", cursor: {}, now });
    expect(r.ok && r.items.map((i) => i.id)).toEqual(["cal:e1"]);
    const again = await cal.read({ botId: "b", cursor: r.ok ? r.cursor : {}, now });
    expect(again.ok && again.items).toEqual([]);
    fail = true;
    expect((await cal.read({ botId: "b", cursor: {}, now })).ok).toBe(false);
  });
});

describe("P14 C: the homework's proposal (plan §5)", () => {
  it("reads report_result.proposal first, and still reads the older 提案： line", () => {
    expect(proposalOf("報告週五截止。要我排進度嗎？", "查好了")).toBe("報告週五截止。要我排進度嗎？");
    expect(proposalOf("提案：報告週五截止。要我排進度嗎？", "")).toBe("報告週五截止。要我排進度嗎？");
    expect(proposalOf(undefined, "查好了\n提案：報告週五截止。要我排進度嗎？\n")).toBe(
      "報告週五截止。要我排進度嗎？",
    );
    expect(proposalOf("  ", "沒有提案")).toBeUndefined();
  });
});
