import { describe, expect, it } from "vitest";
import {
  actionRule,
  appliesOf,
  candidateFromRemember,
  parseCommands,
  parseDue,
  parseSuppress,
  ruleExtract,
} from "../src/index.ts";

const NOW = new Date("2026-11-04T08:00:00Z"); // Wed 16:00 in Taipei

describe("P14 B2: action rules, suppress, deadlines", () => {
  it("classifies the kind of action in a text", () => {
    expect(appliesOf("幫我寫信給開源團隊")).toEqual(["send_message"]);
    expect(appliesOf("draft a reply email and post it on the forum")).toEqual(["send_message", "publish"]);
    expect(appliesOf("買一張去花蓮的票，順便訂房")).toEqual(["purchase", "booking"]);
    expect(appliesOf("今天天氣如何")).toEqual([]);
  });

  it("an instruction about a kind of action becomes a preference that applies to it", () => {
    expect(actionRule("寫信不要提到我的學校")).toMatchObject({
      appliesTo: ["send_message"],
      body: "寫信不要提到我的學校",
    });
    expect(actionRule("買東西一律選可退款")?.appliesTo).toEqual(["purchase"]);
    expect(actionRule("Never mention my employer in emails")?.appliesTo).toEqual(["send_message"]);
    expect(actionRule("我昨天寫了一封信")).toBeUndefined();
    const [c] = ruleExtract("另外，發文的時候不要加 hashtag");
    expect(c).toMatchObject({ kind: "preference", appliesTo: ["publish"] });
    const cmd = parseCommands("記住寫信不要提到我的學校")[0]!;
    expect(candidateFromRemember(cmd)).toMatchObject({
      kind: "preference",
      appliesTo: ["send_message"],
      confidence: 1,
    });
  });

  it("「別再提 X」 names a topic not to offer again", () => {
    expect(parseSuppress("別再提副業了")).toEqual([{ topic: "副業", quote: "別再提副業了" }]);
    expect(parseSuppress("以後少提健身的建議")[0]?.topic).toBe("健身");
    expect(parseSuppress("stop suggesting side projects")[0]?.topic).toBe("side projects");
    expect(parseSuppress("我們再提一次這個方案")).toEqual([]);
  });

  it("finds a deadline at the end of that local day", () => {
    const iso = (s: string) => parseDue(s, NOW)?.toISOString();
    expect(iso("11月20日要交報告")).toBe("2026-11-20T15:59:00.000Z");
    expect(iso("11/20 截止報名")).toBe("2026-11-20T15:59:00.000Z");
    expect(iso("明天要繳電費")).toBe("2026-11-05T15:59:00.000Z");
    expect(iso("下週三考試")).toBe("2026-11-11T15:59:00.000Z");
    expect(iso("週五要開會")).toBe("2026-11-06T15:59:00.000Z");
    expect(iso("3月1日要續約")).toBe("2027-03-01T15:59:00.000Z");
    expect(iso("11月20日天氣很好")).toBeUndefined();
    const [c] = ruleExtract("下週三考物理", { now: NOW });
    expect(c).toMatchObject({ kind: "project", dueAt: "2026-11-11T15:59:00.000Z" });
  });
});
