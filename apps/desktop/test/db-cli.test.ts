import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBackups, MIGRATIONS, openStore } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import { dbCli, runningCorePid, writeCorePid } from "../src/db-cli.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-dbcli-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[]): { code: number; out: string } {
  const lines: string[] = [];
  const code = dbCli(args, (l) => lines.push(l));
  return { code, out: lines.join("\n") };
}

describe("alca db (P13 A5)", () => {
  it("backs up, lists and restores; refuses while a core runs", () => {
    const root = tmp();
    const dbPath = join(root, "state.sqlite");
    const a = openStore(dbPath, MIGRATIONS.slice(0, -1));
    a.threads.create("thr_keep", "留下來的");
    a.close();
    const b = openStore(dbPath); // upgrade → automatic backup
    expect(b.migration.backup).toBeDefined();
    b.threads.create("thr_late", "之後的");
    b.close();

    expect(run(["backups", "--data-dir", root]).out).toContain("state-v");
    const json = JSON.parse(run(["backups", "--data-dir", root, "--json"]).out) as unknown[];
    expect(json).toHaveLength(1);
    expect(run(["backup", "--data-dir", root]).code).toBe(0);
    expect(listBackups(dbPath)).toHaveLength(2);

    const oldest = listBackups(dbPath).at(-1)?.name as string;
    const drop = writeCorePid(root);
    expect(runningCorePid(root)).toBe(process.pid);
    const busy = run(["restore", oldest, "--data-dir", root]);
    expect(busy.code).toBe(3);
    drop();
    expect(runningCorePid(root)).toBeUndefined();

    const ok = run(["restore", oldest, "--data-dir", root]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("沒有刪除");
    const c = openStore(dbPath);
    expect(c.threads.get("thr_keep")?.title).toBe("留下來的");
    expect(c.threads.get("thr_late")).toBeUndefined();
    c.close();
  });

  it("a stale pid file does not block; bad input gets a plain message", () => {
    const root = tmp();
    openStore(join(root, "state.sqlite")).close();
    writeFileSync(join(root, "core.pid"), "999999999\n");
    expect(runningCorePid(root)).toBeUndefined();
    const r = run(["restore", "state-v1-20261104T000000Z.sqlite", "--data-dir", root]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("無法還原");
    expect(existsSync(join(root, "state.sqlite"))).toBe(true);
    expect(run(["restore", "--data-dir", root]).code).toBe(2);
  });
});
