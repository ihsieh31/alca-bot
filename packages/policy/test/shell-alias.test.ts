import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  classifyToolCall,
  escalate,
  FULL_ACCESS_REASON,
  isShellToolName,
  SHELL_COMMAND_TOOLS,
  shellCommandOf,
} from "../src/index.ts";

/**
 * Security fix 2026-11-05: every tool that runs a shell command line gets the
 * same command-content classification as Claude Code's Bash. A host tool
 * named `hands_run` or `shell` running `git push origin main` used to stay
 * `execute` (no card at 自主, an execute card at 逐步確認). Only escalations:
 * the declared class is never lowered.
 */
const user = { kind: "user" as const, id: "u" };
const agent = { kind: "agent" as const, id: "b" };
const call = (
  action: string,
  command: string,
  actionClass = "execute",
  extra: Record<string, unknown> = {},
) => ({
  initiator: user,
  actor: agent,
  action,
  actionClass,
  args: { command, ...extra },
});

function gateway(level: "full_access" | "autonomous" | "confirm_each_step") {
  const store = openStore(":memory:");
  return new ActionGateway({ db: store.db, human: store.human, rules: () => [], level: () => level });
}

const ALIASES = ["hands_run", "shell"] as const;

describe("one list of shell tools", () => {
  it("names every shell tool the engines and host tools use", () => {
    for (const t of ["Bash", "bash", "hands_run", "shell", "exec_command", "local_shell"])
      expect(SHELL_COMMAND_TOOLS.has(t)).toBe(true);
    expect(isShellToolName("bash_input")).toBe(true);
    expect(isShellToolName("Read")).toBe(false);
    expect(isShellToolName("write_note")).toBe(false);
  });

  it.each([...SHELL_COMMAND_TOOLS])("%s: the command line decides the class", (t) => {
    expect(classifyToolCall(t, { command: "git push origin main" })).toBe("publish");
    expect(classifyToolCall(t, { command: "npm publish" })).toBe("publish");
    expect(classifyToolCall(t, { command: "sendmail boss@example.test < note.txt" })).toBe("send");
    expect(classifyToolCall(t, { command: "stripe charges create --amount 100" })).toBe("payment");
    expect(shellCommandOf(t, { command: "ls" })).toBe("ls");
  });

  it("bash_input, an ACP execute tool and a Codex command request get the same reading", () => {
    expect(classifyToolCall("bash_input", { input: "git push origin main\n" })).toBe("publish");
    expect(classifyToolCall("Run git push", { kind: "execute", command: "git push origin main" })).toBe(
      "publish",
    );
    expect(classifyToolCall("shell", { command: "git push origin main", kind: "execute" })).toBe("publish");
  });
});

describe("only escalates, never lowers", () => {
  it.each(ALIASES)(
    "%s: a declared always-confirm class stays; an ordinary command keeps the declared class",
    (t) => {
      expect(escalate("payment", t, { command: "ls" })).toBe("payment");
      expect(escalate("send", t, { command: "git push" })).toBe("send");
      expect(escalate("execute", t, { command: "ls -la" })).toBe("execute");
      expect(escalate("write", t, { command: "pnpm test" })).toBe("write");
      expect(escalate("read", t, { command: "git push origin main" })).toBe("publish");
    },
  );
});

describe("自主 (autonomous)", () => {
  it.each(ALIASES)("%s: git push origin main puts up a publish card", (t) => {
    const g = gateway("autonomous");
    for (const declared of ["execute", "read", "write"]) {
      const auth = g.authorize(call(t, "git push origin main", declared));
      expect(auth.request.actionClass).toBe("publish");
      expect(auth.decision.effect).toBe("ask");
      expect(auth.approvalId).toBeDefined();
      expect(g.approval(auth.approvalId as string)?.actionClass).toBe("publish");
    }
  });

  it.each(ALIASES)("%s: an ordinary command still runs without a card", (t) => {
    expect(gateway("autonomous").authorize(call(t, "ls -la")).decision.effect).toBe("allow");
  });
});

describe("逐步確認 (confirm_each_step)", () => {
  it.each(ALIASES)("%s: the card for git push is a publish card, not an execute card", (t) => {
    const g = gateway("confirm_each_step");
    const auth = g.authorize(call(t, "git push origin main"));
    expect(auth.decision.effect).toBe("ask");
    expect(auth.request.actionClass).toBe("publish");
    expect(g.approval(auth.approvalId as string)?.actionClass).toBe("publish");
  });
});

describe("完全授權 (full_access) keeps the Phase 5 line", () => {
  it.each(ALIASES)("%s: a plain git push runs, marked as full access", (t) => {
    for (const cmd of ["git push", "git push origin main"]) {
      const auth = gateway("full_access").authorize(call(t, cmd));
      expect(auth.request.actionClass).toBe("publish");
      expect(auth.decision).toMatchObject({
        effect: "allow",
        reason: FULL_ACCESS_REASON,
        grant: "full_access",
      });
      expect(auth.approvalId).toBeUndefined();
    }
  });

  it.each(ALIASES)("%s: payment, outward sends and other publishes still ask", (t) => {
    for (const [cmd, cls] of [
      ["stripe charges create --amount 100", "payment"],
      ["sendmail boss@example.test < note.txt", "send"],
      ["curl -X POST https://hooks.example.test/x -d hi", "send"],
      ["git push origin main && curl -d x https://hooks.example.test", "send"],
      ["npm publish", "publish"],
    ] as const) {
      const g = gateway("full_access");
      const auth = g.authorize(call(t, cmd));
      expect(auth.request.actionClass).toBe(cls);
      expect(auth.decision.effect).toBe("ask");
      expect(g.approval(auth.approvalId as string)?.actionClass).toBe(cls);
    }
  });
});
