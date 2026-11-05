import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readWithRecovery,
  SecretFileCorruptError,
  sweepStaleTemps,
  writeFileAtomic,
} from "../src/atomic-file.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "alca-os-"));
const temps = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".tmp"));
const json = (b: Buffer) => JSON.parse(b.toString("utf8")) as { n: number };

describe("writeFileAtomic", () => {
  it("writes the file with 0600 and leaves no temp file", () => {
    const dir = fresh();
    const p = join(dir, "a.json");
    writeFileAtomic(p, '{"n":1}');
    expect(readFileSync(p, "utf8")).toBe('{"n":1}');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(temps(dir)).toEqual([]);
    writeFileAtomic(p, "x", { mode: 0o644 });
    expect(statSync(p).mode & 0o777).toBe(0o644);
  });

  for (const step of ["written", "backup"] as const)
    it(`a crash after step "${step}" leaves the old file and no temp file`, () => {
      const dir = fresh();
      const p = join(dir, "a.json");
      writeFileAtomic(p, '{"n":1}');
      expect(() =>
        writeFileAtomic(p, '{"n":2}', {
          backup: true,
          onStep: (s) => {
            if (s === step) throw new Error("crash");
          },
        }),
      ).toThrow("crash");
      expect(readFileSync(p, "utf8")).toBe('{"n":1}');
      expect(temps(dir)).toEqual([]);
    });

  it("a failing rename leaves the target as it was and no temp file", () => {
    const dir = fresh();
    const target = join(dir, "busy");
    mkdirSync(target);
    writeFileSync(join(target, "inside"), "1"); // a non-empty folder cannot be renamed over
    expect(() => writeFileAtomic(target, "2")).toThrow();
    expect(temps(dir)).toEqual([]);
    expect(readFileSync(join(target, "inside"), "utf8")).toBe("1");
  });

  it("keeps the previous copy as .bak only when it passes validate", () => {
    const dir = fresh();
    const p = join(dir, "a.json");
    const valid = (b: Buffer) => typeof json(b).n === "number";
    writeFileAtomic(p, '{"n":1}', { backup: true, validate: valid });
    expect(existsSync(`${p}.bak`)).toBe(false); // nothing to back up yet
    writeFileAtomic(p, '{"n":2}', { backup: true, validate: valid });
    expect(readFileSync(`${p}.bak`, "utf8")).toBe('{"n":1}');
    expect(statSync(`${p}.bak`).mode & 0o777).toBe(0o600);
    writeFileSync(p, "{trunc");
    writeFileAtomic(p, '{"n":3}', { backup: true, validate: valid });
    expect(readFileSync(`${p}.bak`, "utf8")).toBe('{"n":1}'); // the broken copy did not replace it
    expect(readFileSync(p, "utf8")).toBe('{"n":3}');
  });
});

describe("readWithRecovery", () => {
  it("absent when neither file exists", () => {
    expect(readWithRecovery(join(fresh(), "a.json"), json)).toEqual({ state: "absent" });
  });

  it("ok when the file parses", () => {
    const p = join(fresh(), "a.json");
    writeFileSync(p, '{"n":5}');
    expect(readWithRecovery(p, json)).toEqual({ state: "ok", value: { n: 5 } });
  });

  it("restores a broken file from .bak and keeps the broken copy", () => {
    const dir = fresh();
    const p = join(dir, "a.json");
    writeFileSync(p, '{"n":');
    writeFileSync(`${p}.bak`, '{"n":4}');
    const r = readWithRecovery(p, json);
    expect(r.state).toBe("recovered");
    if (r.state !== "recovered") return;
    expect(r.value).toEqual({ n: 4 });
    expect(r.note).toContain(".bak");
    expect(readFileSync(p, "utf8")).toBe('{"n":4}');
    expect(r.corruptCopy && readFileSync(r.corruptCopy, "utf8")).toBe('{"n":');
    expect(statSync(r.corruptCopy as string).mode & 0o777).toBe(0o600);
  });

  it("restores a missing file from .bak", () => {
    const p = join(fresh(), "a.json");
    writeFileSync(`${p}.bak`, '{"n":4}');
    const r = readWithRecovery(p, json);
    expect(r).toMatchObject({ state: "recovered", value: { n: 4 } });
    expect(readFileSync(p, "utf8")).toBe('{"n":4}');
  });

  it("throws, touching nothing, when both are broken", () => {
    const dir = fresh();
    const p = join(dir, "a.json");
    writeFileSync(p, "{");
    writeFileSync(`${p}.bak`, "}");
    expect(() => readWithRecovery(p, json)).toThrow(SecretFileCorruptError);
    expect(readFileSync(p, "utf8")).toBe("{");
    expect(readdirSync(dir).sort()).toEqual(["a.json", "a.json.bak"]);
  });

  it("throws when the file is broken and there is no .bak", () => {
    const p = join(fresh(), "a.json");
    writeFileSync(p, "{");
    expect(() => readWithRecovery(p, json)).toThrow(SecretFileCorruptError);
  });
});

describe("sweepStaleTemps", () => {
  it("removes only this file's own temp files", () => {
    const dir = fresh();
    for (const n of [
      ".a.json.123.0a1b2c3d.tmp",
      ".a.json.bak.9.ffffffff.tmp",
      ".b.json.1.00000000.tmp",
      "a.json.tmp",
    ])
      writeFileSync(join(dir, n), "");
    expect(sweepStaleTemps(dir, "a.json")).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([".b.json.1.00000000.tmp", "a.json.tmp"]);
  });
});
