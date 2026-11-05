// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell command lines, not templates
import { openStore } from "@alca/store";
import { describe, expect, it } from "vitest";
import { ActionGateway, classifyToolCall, shellLooks, shellNeedsPerson } from "../src/index.ts";

/**
 * Mac test 2026-11-04b A4: haiku joined ls / cat / git status / git diff into
 * one line with `echo "=== exit: $? ==="`. A line of read-only commands joined
 * by `;`, `&&`, `||` or a pipe is as readable as its parts, special parameters
 * like `$?` included — it runs under 自主 and needs no card under 每步確認.
 * Anything Alca cannot read still asks (and the A8 / A9 floors stay as they were).
 */
const gateway = (level: "autonomous" | "confirm_each_step") => {
  const store = openStore(":memory:");
  return new ActionGateway({ db: store.db, human: store.human, rules: () => [], level: () => level });
};
const req = (command: string) => ({
  initiator: { kind: "user" as const, id: "u" },
  actor: { kind: "agent" as const, id: "b" },
  action: "Bash",
  actionClass: "execute",
  args: { command },
});

describe("read-only combinations (A4): no card", () => {
  it.each([
    'ls; cat readme.txt; git status; git diff; echo "=== exit: $? ==="',
    'cd ~/work && ls -la && echo "=== exit: $? ===" && cat readme.txt; echo "exit: $?"',
    'git status 2>&1; echo "exit=$?"',
    'ls || echo "failed: $?"',
    "ls | head -5; echo ${?}",
    "ls 2>/dev/null; echo $?",
    "echo $# $$ $! $0 $1 $@ $*",
    "[[ $? -eq 0 ]] && ls",
    "test $? -eq 0 && echo ok",
    'echo "$(( $? + 1 ))"; git log --oneline -3',
    'echo "$HOME" && pwd && echo ${HOME}',
    "git diff --stat && git show HEAD --stat | head -20",
  ])("%s", (command) => {
    expect(shellNeedsPerson(command)).toBeUndefined();
    expect(shellLooks(command)).toBe(true);
    expect(classifyToolCall("Bash", { command })).toBe("execute");
    expect(gateway("autonomous").preview(req(command)).effect).toBe("allow");
  });
});

describe("anything Alca cannot read still asks", () => {
  it.each([
    // command substitution, eval, a variable as the program
    ["echo $(rm -rf build)", "delete"],
    ["ls; echo `rm x`", "delete"],
    ['eval "rm x"; echo $?', "delete"],
    ["X=rm; $X a.txt; echo $?", undefined],
    ['ls && "$CMD" --flag', undefined],
    ["echo $(( $(rm x) ))", "delete"],
    // expansions whose value is run again
    ["echo ${!X}", undefined],
    ["echo ${X@P}", undefined],
    ["echo $((X))", undefined],
    ["echo $(( $X + 1 ))", undefined],
    ["[[ $N -gt 3 ]] && ls", undefined],
    ["let n=X+1; echo $n", undefined],
    ["X=$'a[\\x24(id)]'; echo ok", undefined],
    // interpreters, network, unknown programs
    ['ls; python3 -c "print(1)"', undefined],
    ["ls && curl -s https://example.com/?q=$?", undefined],
    ["git status; frobnicate", undefined],
    // A9: rm / find -exec rm / git push stay their always-confirm class
    ["ls; rm a.txt", "delete"],
    ["find . -name x -exec rm {} \\; ; echo $?", "delete"],
    ["git status && git -C . push; echo $?", "publish"],
  ] as const)("%s", (command, cls) => {
    if (cls) expect(classifyToolCall("Bash", { command })).toBe(cls);
    else expect(shellNeedsPerson(command)).toBeTruthy();
    expect(shellLooks(command)).toBe(false);
    expect(gateway("autonomous").preview(req(command)).effect).toBe("ask");
  });

  it.each([
    // A9: writes are not "looking" (the core's work-folder check reads their targets)
    'ls > list.txt; echo "$?"',
    "echo hi >> ~/notes.txt",
    "git status | tee status.txt",
    "ls; touch a",
    "git log -c --output=x.txt",
  ])("%s writes, so it is not read-only", (command) => {
    expect(shellLooks(command)).toBe(false);
  });

  it("every step confirm: an always-confirm class asks even when joined to reads", () => {
    const g = gateway("confirm_each_step");
    expect(g.preview(req("ls; rm a.txt")).effect).toBe("ask");
    expect(g.preview(req("git status; git push")).effect).toBe("ask");
  });
});
