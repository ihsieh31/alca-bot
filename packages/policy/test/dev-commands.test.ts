import { describe, expect, it } from "vitest";
import { classifyToolCall, devCommand, shellCommandOf, shellFloor } from "../src/index.ts";

/**
 * Plan §4: recognizable build / test / format commands in the work folder are
 * `write` and no longer fall to the shell floor ("cannot read, ask"); a
 * publish, a send, a delete — and anything leaving the folder — keep asking.
 */

describe("devCommand", () => {
  it.each([
    "npm test",
    "pnpm test -- --run",
    "pnpm run typecheck",
    "yarn lint",
    "npm run test:unit",
    "pnpm exec vitest run src/sum.test.ts",
    "npx --no-install tsc --noEmit",
    "node --test",
    "node --test test/sum.test.ts",
    "tsc -p tsconfig.json",
    "vitest run",
    "biome check --write .",
    "prettier --write src",
    "cargo test",
    "cargo fmt",
    "go test ./...",
    "go vet ./...",
    "golangci-lint run",
    "python -m pytest -q",
    "pytest -x tests",
    "ruff check .",
    "uv run pytest",
    "make test",
    "make",
    "./gradlew test",
    "turbo run test",
    "dotnet test",
    "CI=1 npm test",
    "cd pkg && pnpm test",
    "npm test 2>&1 | tail -n 50",
    "pnpm test > test-output.txt 2>&1",
    "cargo build && cargo test",
  ])("%s is a development command", (command) => {
    expect(devCommand(command)).toBe(true);
  });

  it.each([
    ["npm install", "installs download and run packages"],
    ["npx tsc", "plain npx may download"],
    ["pnpm dlx create-thing", "dlx downloads"],
    ["npm run deploy", "not a build / test name"],
    ['node -e \'require("fs").rmSync("x")\'', "inline code"],
    ["node", "stdin code"],
    ["node scripts/build.js", "a script file is not a test runner"],
    ["cd /etc && make", "leaves the folder"],
    ["pytest ../other-repo", "a parent path"],
    ["npm test > /tmp/out.txt", "redirected outside"],
    ["tsc -p ~/elsewhere/tsconfig.json", "home path"],
    ["npm test && curl https://example.com", "network next to it"],
    ["$TOOL test", "a variable program"],
    ["npm test $(cat x)", "a substitution"],
    ["ls", "nothing to build"],
    ["cargo publish", "not a build sub-command"],
    ["go run main.go", "runs a program"],
    ["python script.py", "runs a program"],
    ["make deploy", "not a build target"],
    ["pnpm test <<EOF\nx\nEOF", "here-document"],
  ])("%s is not (%s)", (command) => {
    expect(devCommand(command)).toBe(false);
  });
});

describe("classification and the shell floor for bash", () => {
  const bash = (command: string) => classifyToolCall("bash", { command });

  it("development commands are write and skip the floor", () => {
    for (const c of ["node --test", "pnpm exec vitest run", "npx --no-install tsc", "turbo run test"]) {
      expect(bash(c)).toBe("write");
      expect(shellFloor("bash", { command: c })).toBeUndefined();
      expect(shellFloor("Bash", { command: c })).toBeUndefined();
    }
  });

  it("git push, curl -X POST and rm keep their always-confirm class, dev command or not", () => {
    expect(bash("git push origin main")).toBe("publish");
    expect(bash("npm test && git push")).toBe("publish");
    expect(bash("curl -X POST https://example.com/hook -d x")).toBe("send");
    expect(bash("rm -rf /tmp/elsewhere")).toBe("delete");
    expect(bash("rm -rf build && npm test")).toBe("delete");
    expect(bash("npm publish")).toBe("publish");
  });

  it("what Alca cannot read still asks (the floor), now for the coding harness's bash too", () => {
    expect(shellCommandOf("bash", { command: "ls" })).toBe("ls");
    expect(shellFloor("bash", { command: "npx some-package" })).toMatch(/下載並執行/);
    expect(shellFloor("bash", { command: "node -e 'x()'" })).toMatch(/直接執行一段程式碼/);
    expect(shellFloor("bash", { command: "mystery-tool --go" })).toMatch(/不認得/);
    expect(shellFloor("bash", { command: "cat src/a.ts" })).toBeUndefined();
  });

  it("bash_input's text is a command line too", () => {
    expect(shellCommandOf("bash_input", { input: "git push\n" })).toBe("git push\n");
    expect(classifyToolCall("bash_input", { input: "git push\n" })).toBe("publish");
    expect(shellFloor("bash_input", { input: "python3 -c 'x'" })).toBeDefined();
  });
});
