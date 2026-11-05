import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HandsExecutor } from "../src/executor.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function exec() {
  const base = mkdtempSync(join(tmpdir(), "alca-hx-"));
  dirs.push(base);
  mkdirSync(join(base, "work"));
  writeFileSync(join(base, "secret.txt"), "outside");
  return { base, x: new HandsExecutor({ workdir: join(base, "work"), maxOutput: 1024 }) };
}

describe("hands executor", () => {
  it("runs shell in the work directory with a clean env", async () => {
    const { x } = exec();
    process.env.ALCA_TEST_TOKEN = "should-not-leak";
    const r = (await x.handle("shell", { command: 'pwd; echo "[$ALCA_TEST_TOKEN]"' })) as {
      stdout: string;
      exitCode: number;
    };
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(x.root);
    expect(r.stdout).toContain("[]");
    delete process.env.ALCA_TEST_TOKEN;
  });

  it("writes, reads and lists inside; refuses paths outside, also through symlinks", async () => {
    const { base, x } = exec();
    await x.handle("write", { path: "a/../note.txt", content: "你好" });
    expect(await x.handle("read", { path: "note.txt" })).toMatchObject({ text: "你好" });
    expect(await x.handle("list", {})).toEqual([{ name: "note.txt", type: "file" }]);
    await expect(x.handle("read", { path: "../secret.txt" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(x.handle("read", { path: join(base, "secret.txt") })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(x.handle("write", { path: "../evil.txt", content: "x" })).rejects.toMatchObject({
      code: "forbidden",
    });
    symlinkSync(join(base, "secret.txt"), join(x.root, "link.txt"));
    await expect(x.handle("read", { path: "link.txt" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("caps output, enforces the timeout, refuses unknown ops", async () => {
    const { x } = exec();
    const big = (await x.handle("shell", { command: "yes | head -c 5000" })) as { stdout: string };
    expect(big.stdout.length).toBeLessThanOrEqual(1024);
    const slow = (await x.handle("shell", { command: "sleep 5", timeoutSec: 1 })) as { timedOut: boolean };
    expect(slow.timedOut).toBe(true);
    await expect(x.handle("eval", { code: "1" })).rejects.toMatchObject({ code: "unknown_op" });
  });
});
