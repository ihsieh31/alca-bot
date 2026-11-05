import { ALWAYS_CONFIRM_ACTIONS, type PermissionLevelT } from "@alca/config";
import { openStore, verifyAuditChain } from "@alca/store";
import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  type ActionRequest,
  classifyToolCall,
  decide,
  PolicyDeniedError,
  ruleProblem,
} from "../src/index.ts";

const req = (action: string, actionClass: string, args?: Record<string, unknown>): ActionRequest => ({
  initiator: { kind: "user", id: "u" },
  actor: { kind: "agent", id: "main" },
  action,
  actionClass,
  ...(args ? { args } : {}),
});

function gateway(rules: unknown[] = [], level: PermissionLevelT = "confirm_each_step") {
  const store = openStore(":memory:");
  let lv = level;
  const gw = new ActionGateway({ db: store.db, human: store.human, rules: () => rules, level: () => lv });
  return { store, gw, setLevel: (l: PermissionLevelT) => (lv = l) };
}

describe("decide", () => {
  it("maps the two approval levels", () => {
    expect(decide([], req("Read", "read"), "confirm_each_step").effect).toBe("allow");
    expect(decide([], req("Edit", "write"), "confirm_each_step").effect).toBe("ask");
    expect(decide([], req("Edit", "write"), "autonomous").effect).toBe("allow");
    expect(decide([], req("Bash", "execute"), "autonomous").effect).toBe("allow");
  });

  it("always-confirm classes ask under every level and every allow rule", () => {
    const allowAll = [{ id: "all", effect: "allow", action: "*" }];
    for (const c of ALWAYS_CONFIRM_ACTIONS) {
      for (const lv of ["autonomous", "confirm_each_step"] as const) {
        expect(decide(allowAll, req("x", c), lv).effect).toBe("ask");
        expect(decide([], req("x", c), lv).effect).toBe("ask");
      }
    }
  });

  it("deny wins over allow and ask, and over autonomous", () => {
    const rules = [
      { id: "a", effect: "allow", action: "*" },
      { id: "k", effect: "ask", action: "Bash" },
      { id: "d", effect: "deny", action: "Bash", target: "/etc" },
    ];
    const r = { ...req("Bash", "execute"), target: "/etc/passwd" };
    expect(decide(rules, r, "autonomous")).toMatchObject({ effect: "deny", ruleId: "d" });
    expect(decide(rules, req("Bash", "execute"), "autonomous")).toMatchObject({ effect: "ask", ruleId: "k" });
    expect(decide(rules, req("Edit", "write"), "confirm_each_step")).toMatchObject({ effect: "allow" });
  });

  it("a malformed rule anywhere fails closed", () => {
    for (const bad of [
      null,
      "allow",
      { id: "x", effect: "maybe", action: "*" },
      { id: "", effect: "allow", action: "*" },
      { id: "x", effect: "allow", action: "a*b*" },
      { id: "x", effect: "allow", action: "*", actionClass: "teleport" },
      { id: "x", effect: "allow", action: "*", extra: 1 },
    ]) {
      expect(ruleProblem(bad)).toBeTypeOf("string");
      expect(
        decide([{ id: "ok", effect: "allow", action: "*" }, bad], req("Read", "read"), "autonomous").effect,
      ).toBe("deny");
    }
    expect(decide([], req("Read", "nonsense"), "autonomous").effect).toBe("deny");
  });

  it("prefix rules match", () => {
    const rules = [{ id: "m", effect: "deny", action: "mcp__mail__*" }];
    expect(decide(rules, req("mcp__mail__list", "read"), "autonomous").effect).toBe("deny");
    expect(decide(rules, req("mcp__cal__list", "read"), "autonomous").effect).toBe("allow");
  });
});

describe("classifier (escalate only)", () => {
  it.each([
    ["rm -rf build", "delete"],
    ["git push origin main", "publish"],
    ["npm publish", "publish"],
    ["curl -X POST https://api.example.com/x", "send"],
    ["echo hi | mail someone@example.com", "send"],
    ["ls -la", "execute"],
    ["git status", "execute"],
  ])("Bash %s → %s", (command, cls) => {
    expect(classifyToolCall("Bash", { command })).toBe(cls);
  });
  it("names tools", () => {
    expect(classifyToolCall("Read")).toBe("read");
    expect(classifyToolCall("Write")).toBe("write");
    expect(classifyToolCall("mcp__gmail__send_email")).toBe("send");
    expect(classifyToolCall("mcp__x__lookup")).toBe("network");
    expect(classifyToolCall("SomethingNew")).toBe("execute");
    // ACP native tools: title + kind; the shell floor applies to their commands too.
    expect(classifyToolCall("git push origin main", { kind: "execute" })).toBe("publish");
    expect(classifyToolCall("Run shell", { kind: "execute", command: "rm -rf build" })).toBe("delete");
    expect(classifyToolCall("Delete notes.txt", { kind: "delete" })).toBe("delete");
    expect(classifyToolCall("ls -la", { kind: "execute" })).toBe("execute");
    expect(classifyToolCall("Write notes.txt", { kind: "edit" })).toBe("execute");
  });
});

describe("ActionGateway", () => {
  it("writes the audit row before executing, and audits denials", async () => {
    const { store, gw } = gateway([{ id: "d", effect: "deny", action: "Bash" }], "autonomous");
    let ran = false;
    await expect(
      gw.submit(req("Bash", "execute", { command: "ls" }), () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(ran).toBe(false);
    const r = await gw.submit(req("Read", "read"), () => {
      const n = (store.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
      return n;
    });
    expect(r).toMatchObject({ status: "done", value: 2 });
    expect(verifyAuditChain(store.db)).toEqual({ ok: true, count: 2 });
  });

  it("escalates a shell delete into an approval, persisted and resolved once", async () => {
    const { store, gw } = gateway([], "autonomous");
    const auth = gw.authorize(req("Bash", "execute", { command: "rm -rf ~/x" }), { summary: "刪除 ~/x" });
    expect(auth.request.actionClass).toBe("delete");
    expect(auth.decision.effect).toBe("ask");
    expect(store.human.approval(auth.approvalId!)).toMatchObject({ status: "pending", summary: "刪除 ~/x" });
    await expect(gw.execute(auth, () => 1)).rejects.toThrow(/approval pending/);
    expect(gw.resolveApproval(auth.approvalId!, "approved", { kind: "user", id: "u" }).resolved).toBe(true);
    expect(gw.resolveApproval(auth.approvalId!, "denied", { kind: "user", id: "phone" }).resolved).toBe(
      false,
    );
    expect(await gw.execute(auth, () => 42)).toBe(42);
    const decisions = store.db.prepare("SELECT decision FROM audit_log ORDER BY id").all() as Array<{
      decision: string;
    }>;
    expect(decisions.map((d) => d.decision)).toEqual(["ask", "allow"]);
  });

  it("a denied or expired approval never executes", async () => {
    const { gw } = gateway();
    const a = gw.authorize(req("Write", "write"));
    gw.resolveApproval(a.approvalId!, "denied", { kind: "user", id: "u" });
    await expect(gw.execute(a, () => 1)).rejects.toThrow(/approval denied/);
    const b = gw.authorize(req("Write", "write"));
    expect(gw.expireAllPending()).toBe(1);
    await expect(gw.execute(b, () => 1)).rejects.toThrow(/approval expired/);
    expect(gw.resolveApproval(b.approvalId!, "approved", { kind: "user", id: "u" }).resolved).toBe(false);
  });

  it("level changes apply to the next decision", () => {
    const { gw, setLevel } = gateway();
    expect(gw.authorize(req("Edit", "write")).decision.effect).toBe("ask");
    setLevel("autonomous");
    expect(gw.authorize(req("Edit", "write")).decision.effect).toBe("allow");
  });
});
