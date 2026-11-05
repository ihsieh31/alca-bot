import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentityJwkSync } from "@alca/link";
import { generateVapidKey } from "@alca/push";
import { afterEach, describe, expect, it } from "vitest";
import { CoreSecretsError, loadCoreSecrets as loadWith } from "../src/core-secrets.ts";
import { openDataDir, openVault } from "../src/data-dir.ts";
import { writeCorePid } from "../src/db-cli.ts";
import { secretsCli, secretsStatus } from "../src/secrets-cli.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-secrets-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const file = (root: string) => join(root, "secrets.json");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
async function run(args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await secretsCli(args, (l) => lines.push(l));
  return { code, out: lines.join("\n") };
}
/** A pre-D1 secrets.json: all three values in the file (what an older version left). */
function legacy(root: string, drop: string[] = []): Record<string, string> {
  const m: Record<string, string> = {
    "core.localToken": "a".repeat(64),
    "link.identityKey": JSON.stringify(generateIdentityJwkSync()),
    "push.vapidKey": JSON.stringify(generateVapidKey()),
  };
  for (const d of drop) delete m[d];
  writeFileSync(join(root, "secrets.json"), JSON.stringify(m, null, 2));
  writeFileSync(join(root, "secrets.json.bak"), JSON.stringify(m, null, 2));
  return m;
}
/** The core's loader with the folder's vault (file key: tests never touch a keychain). */
const loadCoreSecrets = (root: string) => loadWith(root, openVault(root, "file"));

describe("secrets.json (next-round §1)", () => {
  it("first start makes the token (0600, with a .bak) and the keys in the vault", async () => {
    const root = tmp();
    const d = await openDataDir(root);
    expect(d.core.localToken).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file(root)).mode & 0o777).toBe(0o600);
    expect(read(`${file(root)}.bak`)).toEqual(read(file(root)));
    expect(d.secrets["core.localToken"]).toBe(d.core.localToken);
    // Phase D1: the long-term keys are only in the vault, never in secrets.json.
    expect(Object.keys(read(file(root))).sort()).toEqual(["core.localToken", "core.secretsIn"]);
    expect(JSON.parse((await d.vault.get("core.linkIdentity")) as string)).toEqual(d.core.linkIdentity);
    expect(JSON.parse((await d.vault.get("core.vapidKey")) as string)).toEqual(d.core.vapidKey);
    expect(statSync(join(root, "vault.json")).mode & 0o777).toBe(0o600);
    expect(d.migration).toBeUndefined(); // nothing to move on a first start
  });

  it("a second start changes nothing", async () => {
    const root = tmp();
    const a = (await loadCoreSecrets(root)).core;
    const before = readFileSync(file(root), "utf8");
    const b = (await loadCoreSecrets(root)).core;
    expect(b).toEqual(a);
    expect(readFileSync(file(root), "utf8")).toBe(before);
  });

  it("a truncated file is restored from .bak and the identity stays the same", async () => {
    const root = tmp();
    const a = (await loadCoreSecrets(root)).core;
    const text = readFileSync(file(root), "utf8");
    writeFileSync(file(root), text.slice(0, 40));
    const r = await loadCoreSecrets(root);
    expect(r.recovered).toContain(".bak");
    expect(r.core.linkIdentity).toEqual(a.linkIdentity);
    expect(r.core.vapidKey).toEqual(a.vapidKey);
    expect(readFileSync(file(root), "utf8")).toBe(text);
    expect(readdirSync(root).some((n) => n.startsWith("secrets.json.corrupt-"))).toBe(true);
  });

  it("both copies broken: throws with how to recover and makes no new identity", async () => {
    const root = tmp();
    await loadCoreSecrets(root);
    writeFileSync(file(root), "{");
    writeFileSync(`${file(root)}.bak`, "{");
    await expect(openDataDir(root)).rejects.toThrow(CoreSecretsError);
    await expect(loadCoreSecrets(root)).rejects.toThrow(/alca secrets reset --confirm/);
    expect(readFileSync(file(root), "utf8")).toBe("{");
  });

  it("only link.identityKey malformed and no good .bak: throws instead of regenerating", async () => {
    const root = tmp();
    const m = legacy(root);
    m["link.identityKey"] = '{"kty":"EC"}';
    writeFileSync(file(root), JSON.stringify(m));
    rmSync(`${file(root)}.bak`);
    await expect(loadCoreSecrets(root)).rejects.toThrow(CoreSecretsError);
    expect(read(file(root))["link.identityKey"]).toBe('{"kty":"EC"}'); // untouched
    expect(existsSync(join(root, "vault.json"))).toBe(false); // and nothing new in the vault
  });

  it("only push.vapidKey malformed with a good .bak: restored, not regenerated", async () => {
    const root = tmp();
    const m = legacy(root);
    const vapid = m["push.vapidKey"] as string;
    m["push.vapidKey"] = "not json";
    writeFileSync(file(root), JSON.stringify(m));
    const r = await loadCoreSecrets(root);
    expect(r.recovered).toBeDefined();
    expect(r.core.vapidKey).toEqual(JSON.parse(vapid));
    expect(r.migration?.state).toBe("moved");
  });

  it("an absent field (an older file) is the only thing generated", async () => {
    const root = tmp();
    const m = legacy(root, ["push.vapidKey"]);
    const b = (await loadCoreSecrets(root)).core;
    expect(b.linkIdentity).toEqual(JSON.parse(m["link.identityKey"] as string));
    expect(b.localToken).toBe(m["core.localToken"]);
    expect(await openVault(root, "file").get("core.vapidKey")).toBe(JSON.stringify(b.vapidKey));
  });

  it("a stale temp file from a crash is swept", async () => {
    const root = tmp();
    await loadCoreSecrets(root);
    writeFileSync(join(root, ".secrets.json.4242.0a0b0c0d.tmp"), "half");
    await loadCoreSecrets(root);
    expect(existsSync(join(root, ".secrets.json.4242.0a0b0c0d.tmp"))).toBe(false);
  });
});

describe("alca secrets", () => {
  it("status names fields and the backup, never values", async () => {
    const root = tmp();
    const { core } = await loadCoreSecrets(root);
    const r = await run(["status", "--data-dir", root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("core.localToken");
    expect(r.out).not.toContain(core.localToken);
    expect(await secretsStatus(root)).toMatchObject({ file: "ok", backup: "ok" });
    writeFileSync(file(root), "{");
    writeFileSync(`${file(root)}.bak`, "{");
    expect((await run(["status", "--data-dir", root])).code).toBe(1);
  });

  it("reset needs --confirm, refuses while the core runs, then sets the files aside", async () => {
    const root = tmp();
    const a = (await loadCoreSecrets(root)).core;
    expect((await run(["reset", "--data-dir", root])).code).toBe(2);
    const drop = writeCorePid(root);
    expect((await run(["reset", "--confirm", "--data-dir", root])).code).toBe(3);
    drop();
    expect((await run(["reset", "--confirm", "--data-dir", root])).code).toBe(0);
    expect(existsSync(file(root))).toBe(false);
    expect(readdirSync(root).filter((n) => n.includes(".reset-"))).toHaveLength(2);
    const b = (await loadCoreSecrets(root)).core;
    expect(b.linkIdentity).not.toEqual(a.linkIdentity);
  });
});
