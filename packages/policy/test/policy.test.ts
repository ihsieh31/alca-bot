import { describe, expect, it } from "vitest";
import { type ActionRequest, evaluate, type PolicyRule } from "../src/index.ts";

const req = (action: string, actionClass: string): ActionRequest => ({
  initiator: { kind: "user", id: "u" },
  actor: { kind: "agent", id: "main" },
  action,
  actionClass,
});

describe("policy evaluate", () => {
  it("deny beats allow, unmatched asks, bad rules fail closed", () => {
    const rules: PolicyRule[] = [
      { id: "a", effect: "allow", action: "*" },
      { id: "d", effect: "deny", action: "shell.rm" },
    ];
    expect(evaluate(rules, req("fs.read", "read")).effect).toBe("allow");
    expect(evaluate(rules, req("shell.rm", "delete")).effect).toBe("deny");
    expect(evaluate([], req("fs.read", "read")).effect).toBe("ask");
    expect(
      evaluate([{ id: "x", effect: "maybe" as never, action: "*" }], req("fs.read", "read")).effect,
    ).toBe("deny");
  });

  it("an allow-all rule cannot skip confirmation for payment/send/delete/publish", () => {
    const rules: PolicyRule[] = [{ id: "a", effect: "allow", action: "*" }];
    for (const c of ["payment", "send", "delete", "publish"]) {
      expect(evaluate(rules, req("x", c)).effect).toBe("ask");
    }
  });
});
