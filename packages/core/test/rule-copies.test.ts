// R9.6: the router and worker rules in English. The Chinese prompt is
// byte-identical to before; the English one carries no Chinese rule line.
import { describe, expect, it } from "vitest";
import { botLanguage, botPromptLanguage } from "../src/conversation-rules.ts";
import {
  buildStablePrompt,
  harnessProfile,
  ROUTER_RULES,
  ROUTER_RULES_EN,
  routerProfile,
  WORKER_RULES,
  WORKER_RULES_EN,
  workerProfile,
} from "../src/index.ts";
import { registerEnglish, ruleIn } from "../src/rule-copies.ts";

const CJK = /[\u3400-\u9fff]/;

describe("English router and worker rules", () => {
  it("every Chinese line has an English copy, in the same order, with no CJK", () => {
    expect(ROUTER_RULES_EN).toHaveLength(ROUTER_RULES.length);
    expect(WORKER_RULES_EN).toHaveLength(WORKER_RULES.length);
    for (const line of [...ROUTER_RULES_EN, ...WORKER_RULES_EN]) expect(line).not.toMatch(CJK);
    ROUTER_RULES.forEach((zh, i) => {
      expect(ruleIn(zh, "en")).toBe(ROUTER_RULES_EN[i]);
      expect(ruleIn(zh, "zh")).toBe(zh);
    });
  });

  it("the Chinese prompts keep the Chinese lines; the English ones swap every one", () => {
    const zhRouter = buildStablePrompt({ ...routerProfile(), language: "zh" });
    const enRouter = buildStablePrompt({ ...routerProfile(), language: "en" });
    for (const [i, zh] of ROUTER_RULES.entries()) {
      expect(zhRouter).toContain(zh);
      expect(enRouter).not.toContain(zh);
      expect(enRouter).toContain(ROUTER_RULES_EN[i]);
    }
    const enWorker = buildStablePrompt({ ...workerProfile(), language: "en" });
    const enCoding = buildStablePrompt({
      ...harnessProfile(workerProfile(), "coding", "en"),
      language: "en",
    });
    for (const [i, zh] of WORKER_RULES.entries()) {
      expect(buildStablePrompt(workerProfile())).toContain(zh);
      expect(enWorker).not.toContain(zh);
      expect(enCoding).toContain(WORKER_RULES_EN[i]);
    }
  });

  it("a copy must match its list line by line", () => {
    expect(() => registerEnglish(["一", "二"], ["one"])).toThrow(/line by line/);
  });
});

describe("botPromptLanguage", () => {
  it("a pinned language wins over the instructions; auto judges them as before", () => {
    expect(botPromptLanguage({ language: "en", instructions: "用中文回答" })).toBe("en");
    expect(botPromptLanguage({ language: "zh", instructions: "Answer in English" })).toBe("zh");
    for (const s of ["Answer in English", "幫我整理文件", "", null])
      expect(botPromptLanguage({ language: "auto", instructions: s })).toBe(botLanguage(s));
    expect(botPromptLanguage(undefined)).toBe("zh");
  });
});

describe("reply language (mac device test 2026-11-05 BUG-5)", () => {
  it("an English prompt has no Chinese standing line and follows the latest message's language", () => {
    for (const profile of [
      routerProfile(),
      workerProfile(),
      harnessProfile(workerProfile(), "general", "en"),
    ]) {
      const en = buildStablePrompt({ ...profile, language: "en" }, ["worker_start"]);
      expect(en).not.toContain("繁體中文");
      expect(en).toContain("Reply in the language of the user's latest message");
      expect(en).toContain("relayed worker results included");
    }
    const zh = buildStablePrompt(routerProfile(), ["worker_start"]);
    expect(zh).toContain("用使用者最新訊息的語言回覆");
    expect(zh).toContain("轉述工人結果也一樣");
    expect(zh).not.toContain("預設使用繁體中文回覆");
  });

  it("the English router prompt carries no CJK outside the tool list", () => {
    const en = buildStablePrompt({ ...routerProfile(), language: "en" }, ["worker_start"]);
    expect(en).not.toMatch(CJK);
  });
});
