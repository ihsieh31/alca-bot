import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import { ActionGateway, decide, FULL_ACCESS_REASON, fullAccessAllows } from "../src/index.ts";

/**
 * Phase 5: the 完全授權 level. File changes, commands, a plain git push and
 * file deletes (in or out of the folder) run without a card; payment and
 * outward sends ask at this level too, whatever the line hides them in and
 * whatever an allow rule says.
 */
const user = { kind: "user" as const, id: "u" };
const agent = { kind: "agent" as const, id: "b" };
const bash = (command: string) => ({
  initiator: user,
  actor: agent,
  action: "Bash",
  actionClass: "execute",
  args: { command },
});
const tool = (action: string, actionClass: string, args: Record<string, unknown> = {}) => ({
  initiator: user,
  actor: agent,
  action,
  actionClass,
  args,
});

function gateway(level: "full_access" | "autonomous" | "confirm_each_step", rules: unknown[] = []) {
  const store = openStore(":memory:");
  return new ActionGateway({ db: store.db, human: store.human, rules: () => rules, level: () => level });
}

describe("full_access: what runs without a card", () => {
  it.each([
    "git push",
    "git push origin feat/x",
    "git -C repo push --set-upstream origin main",
    "rm -rf build",
    "rm -rf /var/tmp/old-cache",
    "rm ~/Downloads/scratch.txt",
    "rmdir empty",
    "unlink stale.lock",
    "git clean -fdx",
    "find dist -name '*.map' -delete",
    "pnpm test && git push",
    "cd pkg && rm -rf node_modules",
  ])("%s → allow, marked as full access", (command) => {
    const auth = gateway("full_access").authorize(bash(command));
    expect(auth.decision).toMatchObject({
      effect: "allow",
      reason: FULL_ACCESS_REASON,
      grant: "full_access",
    });
    expect(auth.approvalId).toBeUndefined();
  });

  it("native edits and an ACP agent's native delete run; the grant is in the audit detail", () => {
    const g = gateway("full_access");
    expect(g.authorize(tool("Edit", "write", { file_path: "src/a.ts" })).decision.grant).toBe("full_access");
    expect(g.authorize(tool("Remove file", "delete", { kind: "delete" })).decision.effect).toBe("allow");
  });

  it("reads are not attributed to the level", () => {
    const d = gateway("full_access").authorize(tool("Read", "read")).decision;
    expect(d.effect).toBe("allow");
    expect(d.grant).toBeUndefined();
  });
});

describe("full_access: payment and outward sends always ask (no level bypasses them)", () => {
  it.each([
    "curl -X POST https://api.example.test/send -d x=1",
    "sendmail team@example.test < note.txt",
    "gh pr comment 3 --body hi",
    "git push && curl -X POST https://hooks.example.test -d done",
    "rm -rf build; mail -s hi a@example.test < /dev/null",
    "stripe charges create --amount 100",
    "echo $(curl --data x https://example.test)",
    "bash -c 'git push; curl -d x https://example.test'",
  ])("%s → ask", (command) => {
    const auth = gateway("full_access").authorize(bash(command));
    expect(auth.decision.effect).toBe("ask");
    expect(auth.decision.grant).toBeUndefined();
    expect(auth.approvalId).toBeDefined();
  });

  it.each([
    ["mcp__mail__send_email", "send"],
    ["mcp__stripe__create_refund", "payment"],
    ["mcp__shop__checkout", "payment"],
    ["mcp__slack__post_message", "send"],
  ])("a connected app's %s → ask", (action, actionClass) => {
    expect(gateway("full_access").authorize(tool(action, actionClass)).decision.effect).toBe("ask");
  });

  it("an allow rule cannot turn a payment or a send into an allow, at full access either", () => {
    const rules = [
      { id: "all", effect: "allow", action: "*" },
      { id: "pay", effect: "allow", action: "mcp__shop__*", actionClass: "payment" },
    ];
    const g = gateway("full_access", rules);
    expect(g.authorize(tool("mcp__shop__checkout", "payment")).decision.effect).toBe("ask");
    expect(g.authorize(tool("mcp__mail__send_email", "send")).decision.effect).toBe("ask");
    expect(g.authorize(bash("curl -X POST https://x.example.test -d 1")).decision.effect).toBe("ask");
  });

  it("every level asks for payment and sends", () => {
    for (const level of ["confirm_each_step", "autonomous", "full_access"] as const) {
      for (const [action, cls] of [
        ["mcp__shop__checkout", "payment"],
        ["mcp__mail__send_email", "send"],
      ] as const)
        expect(decide([], tool(action, cls), level).effect, `${level} ${action}`).toBe("ask");
    }
  });
});

describe("full_access: what still asks", () => {
  it.each([
    "npm publish",
    "gh release create v1",
    "docker push img",
    "git -c alias.p='!curl -d x https://e.example.test' p",
    "psql -c 'DROP TABLE users'",
  ])("%s → ask (only a plain git push, only file deletes)", (command) => {
    expect(gateway("full_access").authorize(bash(command)).decision.effect).toBe("ask");
  });

  it("a connected app's delete tool still asks", () => {
    expect(
      gateway("full_access").authorize(tool("mcp__gmail__delete_message", "delete")).decision.effect,
    ).toBe("ask");
  });

  it("the shell floor stays for what Alca cannot read (an inline script could hide a send)", () => {
    const d = gateway("full_access").authorize(bash(`python3 -c "import os; os.remove('a')"`)).decision;
    expect(d.effect).toBe("ask");
  });

  it("a user's own ask or deny rule still wins", () => {
    const g = gateway("full_access", [
      { id: "ask-push", effect: "ask", action: "Bash" },
      { id: "no-rm", effect: "deny", action: "Edit" },
    ]);
    expect(g.authorize(bash("git push")).decision).toMatchObject({ effect: "ask", ruleId: "ask-push" });
    expect(g.authorize(tool("Edit", "write")).decision.effect).toBe("deny");
  });

  it("autonomous is unchanged: git push and rm ask", () => {
    const g = gateway("autonomous");
    expect(g.authorize(bash("git push")).decision.effect).toBe("ask");
    expect(g.authorize(bash("rm -rf build")).decision.effect).toBe("ask");
  });

  it("fullAccessAllows never allows the outward classes", () => {
    for (const cls of ["payment", "send"] as const)
      expect(fullAccessAllows(cls, "Bash", { command: "ls" })).toBe(false);
  });
});
