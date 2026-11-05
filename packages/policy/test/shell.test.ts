import { describe, expect, it } from "vitest";
import { classifyToolCall, escalate, splitCommands } from "../src/index.ts";

const bash = (command: string) => classifyToolCall("Bash", { command });

/** Commands seen in a real-Mac test run (2026-11-04) and the wrappers around them. */
describe("shell classification × bypasses", () => {
  it.each([
    // the report's examples
    ["git push origin main", "publish"],
    ["git -C /tmp/x push origin main", "publish"],
    ["git -C /Users/me/alca-mactest-work push origin main", "publish"],
    ["git -c user.name=x push", "publish"],
    ["/bin/rm -f a.txt", "delete"],
    ["rm a.txt", "delete"],
    // git global options and aliases
    ["git --git-dir=/w/.git --work-tree=/w push", "publish"],
    ["git --git-dir /w/.git push origin HEAD", "publish"],
    ["git --no-pager -P -C a -C b push --force", "publish"],
    ["/usr/bin/git -C . push", "publish"],
    ["git -c alias.ship=push ship origin main", "publish"],
    ["git -c 'alias.go=!git push' go", "publish"],
    ["git -C repo clean -fdx", "delete"],
    ["git -C repo reset --hard HEAD~3", "delete"],
    ["git branch -D old", "delete"],
    ["git -C r rm -r src", "delete"],
    // absolute / relative / escaped / quoted program names
    ["/usr/bin/rm -rf build", "delete"],
    ["./node_modules/.bin/rimraf x; /bin/rmdir y", "delete"],
    ["\\rm -rf build", "delete"],
    ['"rm" -rf build', "delete"],
    ["'/bin/rm' x", "delete"],
    // wrappers
    ["env FOO=1 git push", "publish"],
    ["env -i PATH=/usr/bin /bin/rm x", "delete"],
    ["env -u HOME -C /w git push", "publish"],
    ["env -S 'git push origin main'", "publish"],
    ["FOO=1 BAR=2 rm x", "delete"],
    ["command rm x", "delete"],
    ["command -p git push", "publish"],
    ["sudo rm -rf /var/x", "delete"],
    ["sudo -u root -E /bin/rm x", "delete"],
    ["sudo --user root git push", "publish"],
    ["doas -u me rm x", "delete"],
    ["nohup git push &", "publish"],
    ["time nice -n 5 rm x", "delete"],
    ["timeout 30 git push", "publish"],
    ["timeout -s KILL 30s git -C . push", "publish"],
    ["exec rm x", "delete"],
    ["ls *.log | xargs rm", "delete"],
    ["find . -name '*.tmp' -print0 | xargs -0 -n 1 /bin/rm -f", "delete"],
    ["xargs -I{} git -C {} push < repos.txt", "publish"],
    ["find . -name '*.o' -exec rm {} \\;", "delete"],
    ["find . -delete", "delete"],
    // shells and eval
    ["sh -c 'git push'", "publish"],
    ['bash -lc "cd /w && git -C . push origin main"', "publish"],
    ["zsh -c 'rm -rf build'", "delete"],
    ["/bin/sh -ec '/bin/rm x'", "delete"],
    ["eval 'git push'", "publish"],
    ["bash -c \"sh -c 'rm x'\"", "delete"],
    // command lists, subshells, substitutions
    ["cd /w && git add -A && git commit -m wip && git push", "publish"],
    ["(cd /w; git push)", "publish"],
    ["true || rm x", "delete"],
    ["echo $(rm x)", "delete"],
    ['echo "`git push`"', "publish"],
    ["git status 2>&1 | cat; rm -f out 2>/dev/null", "delete"],
    ["cat x > /dev/null && rm x", "delete"],
    ["git -C x \\\n  push", "publish"],
    // other always-confirm classes keep working
    ["curl -X POST https://api.example.com/x", "send"],
    ["curl --json '{}' https://api.example.com/x", "send"],
    ["sudo curl -d a=1 https://x", "send"],
    ["gh pr comment 3 --body hi", "send"],
    ["gh -R a/b release create v1", "publish"],
    ["pnpm --filter x publish", "publish"],
    ["docker push me/img", "publish"],
    ["stripe payment_intents create --amount 100", "payment"],
    ["git push; stripe charges create", "payment"],
  ])("%s → %s", (command, cls) => {
    expect(bash(command)).toBe(cls);
  });

  it.each([
    "ls -la",
    "git status",
    "git -C /w log --oneline",
    "git -c core.pager=cat diff",
    "git branch -d merged",
    "env",
    "sudo -l",
    "find . -name '*.ts'",
    "cat firm.txt",
    "echo hi > out.txt",
    "curl https://example.com",
  ])("%s stays a plain execute", (command) => {
    expect(bash(command)).toBe("execute");
  });

  // Plan §4: ordinary build / test / format work in the folder is a write, like the file tools.
  it.each(["pnpm test", "npm run build", "cargo test"])("%s is a write", (command) => {
    expect(bash(command)).toBe("write");
  });

  it("splits command lists but not quoted separators or redirections", () => {
    expect(splitCommands("a 'b; c' && d \"e|f\" 2>&1")).toEqual([
      ["a", "b; c"],
      ["d", "e|f", "2>&1"],
    ]);
    expect(splitCommands("x $(y z) `w`")).toEqual([["x"], ["y", "z"], ["w"]]);
  });

  it("a declared execute is escalated to publish / delete for the always-confirm floor", () => {
    expect(escalate("execute", "Bash", { command: "git -C /w push" })).toBe("publish");
    expect(escalate("execute", "Bash", { command: "/bin/rm -f a" })).toBe("delete");
    expect(escalate("execute", "Bash", { command: "ls" })).toBe("execute");
  });

  it("an ACP shell tool's command gets the same reading", () => {
    expect(classifyToolCall("Run shell", { kind: "execute", command: "git -C . push" })).toBe("publish");
    expect(classifyToolCall("/bin/rm -f a.txt", { kind: "execute" })).toBe("delete");
  });

  it("deeply nested or huge input does not hang", () => {
    const deep = `${"sh -c '".repeat(20)}rm x${"'".repeat(20)}`;
    expect(["delete", "execute"]).toContain(bash(deep));
    const t = Date.now();
    bash(`git ${"-c a=b ".repeat(5000)}status`);
    bash(`${"x ".repeat(50000)}`);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
