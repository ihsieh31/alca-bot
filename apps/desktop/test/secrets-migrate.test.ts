// Phase D1 (next-round design §6.4): the Link identity and the VAPID key move
// from secrets.json into the vault; failures leave everything as it was; a
// vault that does not open never leads to a new identity; export / import.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentityJwkSync } from "@alca/link";
import { ensureDataKey, type SecretStore, Vault } from "@alca/os";
import { generateVapidKey } from "@alca/push";
import { openStore } from "@alca/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoreSecretsError,
  loadCoreSecrets,
  parseCoreSecretsFile,
  writeSecretsFileAndBackup,
} from "../src/core-secrets.ts";
import { auditSecretsMoved, openDataDir, openVault } from "../src/data-dir.ts";
import { writeCorePid } from "../src/db-cli.ts";
import { secretsCli, secretsStatus } from "../src/secrets-cli.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "alca-d1-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const file = (root: string) => join(root, "secrets.json");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
const vault = (root: string) => openVault(root, "file");
async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await secretsCli(args, (l) => lines.push(l));
  return { code, out: lines.join("\n") };
}

/** What a pre-D1 version left: all three values in secrets.json and its .bak. */
function legacy(root: string): Record<string, string> {
  const m: Record<string, string> = {
    "core.localToken": "b".repeat(64),
    "link.identityKey": JSON.stringify(generateIdentityJwkSync()),
    "push.vapidKey": JSON.stringify(generateVapidKey()),
  };
  const text = JSON.stringify(m, null, 2);
  writeFileSync(file(root), text, { mode: 0o600 });
  writeFileSync(`${file(root)}.bak`, text, { mode: 0o600 });
  return m;
}

/** A SecretStore over a real vault whose writes or read-backs can be made to fail. */
function flaky(root: string, o: { failSet?: boolean; badReadBack?: boolean }): SecretStore {
  const v = vault(root);
  return {
    get backend() {
      return v.backend;
    },
    get: (n) => v.get(n),
    set: (n, x) => v.set(n, x),
    delete: (n) => v.delete(n),
    names: () => v.names(),
    setMany: async (e) => {
      if (o.failSet) throw new Error("disk full");
      await v.setMany(e);
    },
    readBack: async (n) => (o.badReadBack ? "something else" : v.readBack(n)),
  };
}

describe("moving the long-term keys into the vault (§6.4)", () => {
  it("an older folder: keys move, the identity is unchanged, secrets.json and its .bak keep only the token", async () => {
    const root = tmp();
    const old = legacy(root);
    const r = await loadCoreSecrets(root, vault(root));
    expect(r.migration).toEqual({ state: "moved", to: "vault:file" });
    expect(r.core.linkIdentity).toEqual(JSON.parse(old["link.identityKey"] as string));
    expect(r.core.vapidKey).toEqual(JSON.parse(old["push.vapidKey"] as string));
    expect(r.core.localToken).toBe(old["core.localToken"]);
    const now = { "core.localToken": old["core.localToken"], "core.secretsIn": "vault" };
    expect(read(file(root))).toEqual(now);
    // §6.4 step 2: the .bak must not keep the plaintext keys.
    expect(read(`${file(root)}.bak`)).toEqual(now);
    expect(readFileSync(`${file(root)}.bak`, "utf8")).not.toContain('"d"');
    // A fresh vault instance (from the file, not a cache) has both.
    const fresh = vault(root);
    expect(await fresh.get("core.linkIdentity")).toBe(old["link.identityKey"]);
    expect(await fresh.get("core.vapidKey")).toBe(old["push.vapidKey"]);
    // Plaintext private key material is nowhere in the folder's files except the sealed vault.
    const d = JSON.parse(old["link.identityKey"] as string).d as string;
    for (const n of readdirSync(root)) expect(readFileSync(join(root, n), "utf8")).not.toContain(d);
    // A second start changes nothing and reports nothing.
    const again = await loadCoreSecrets(root, vault(root));
    expect(again.migration).toBeUndefined();
    expect(again.core).toEqual(r.core);
  });

  it("the vault write fails: secrets.json is untouched and the core runs on its values", async () => {
    const root = tmp();
    const old = legacy(root);
    const before = readFileSync(file(root), "utf8");
    const r = await loadCoreSecrets(root, flaky(root, { failSet: true }));
    expect(r.migration).toMatchObject({ state: "failed", error: "disk full" });
    expect(readFileSync(file(root), "utf8")).toBe(before);
    expect(readFileSync(`${file(root)}.bak`, "utf8")).toBe(before);
    expect(r.core.linkIdentity).toEqual(JSON.parse(old["link.identityKey"] as string));
    // The next start (vault working again) finishes the move.
    expect((await loadCoreSecrets(root, vault(root))).migration?.state).toBe("moved");
  });

  it("written but the read-back differs: secrets.json is untouched", async () => {
    const root = tmp();
    legacy(root);
    const before = readFileSync(file(root), "utf8");
    const r = await loadCoreSecrets(root, flaky(root, { badReadBack: true }));
    expect(r.migration?.state).toBe("failed");
    expect(readFileSync(file(root), "utf8")).toBe(before);
  });

  it("a crash between the vault write and the file rewrite finishes on the next start, scrubbing the .bak", async () => {
    const root = tmp();
    const old = legacy(root);
    await vault(root).setMany({
      "core.linkIdentity": old["link.identityKey"] as string,
      "core.vapidKey": old["push.vapidKey"] as string,
    });
    const r = await loadCoreSecrets(root, vault(root));
    expect(r.migration?.state).toBe("moved");
    expect(read(`${file(root)}.bak`)["link.identityKey"]).toBeUndefined();
    // Only the .bak still old (crash between the two file writes): scrubbed on start.
    writeFileSync(`${file(root)}.bak`, JSON.stringify(old));
    await loadCoreSecrets(root, vault(root));
    expect(read(`${file(root)}.bak`)["link.identityKey"]).toBeUndefined();
  });

  it("secrets.json still has a key that differs from the vault's: the file's copy wins (phones pinned it)", async () => {
    const root = tmp();
    const old = legacy(root);
    await vault(root).set("core.linkIdentity", JSON.stringify(generateIdentityJwkSync()));
    const r = await loadCoreSecrets(root, vault(root));
    expect(r.core.linkIdentity).toEqual(JSON.parse(old["link.identityKey"] as string));
    expect(await vault(root).get("core.linkIdentity")).toBe(old["link.identityKey"]);
  });

  it("the vault does not open (its key is gone): startup stops, no new identity, nothing rewritten", async () => {
    const root = tmp();
    const a = await loadCoreSecrets(root, vault(root));
    rmSync(join(root, "vault.key")); // the keychain item deleted, or the folder moved alone
    const files = Object.fromEntries(readdirSync(root).map((n) => [n, readFileSync(join(root, n), "utf8")]));
    await expect(loadCoreSecrets(root, vault(root))).rejects.toThrow(CoreSecretsError);
    await expect(loadCoreSecrets(root, vault(root))).rejects.toThrow(/alca secrets export/);
    for (const [n, text] of Object.entries(files)) expect(readFileSync(join(root, n), "utf8")).toBe(text);
    expect(existsSync(join(root, "vault.key"))).toBe(false);
    expect(a.core.localToken).toBe(read(file(root))["core.localToken"]);
  });

  it("secrets.json lost (no marker) and the vault does not open: stops, no new identity", async () => {
    const root = tmp();
    await loadCoreSecrets(root, vault(root));
    rmSync(file(root));
    rmSync(`${file(root)}.bak`);
    rmSync(join(root, "vault.key"));
    await expect(loadCoreSecrets(root, vault(root))).rejects.toThrow(CoreSecretsError);
    expect(existsSync(file(root))).toBe(false);
    expect(existsSync(join(root, "vault.key"))).toBe(false);
  });

  it("writeSecretsFileAndBackup writes the main file and the .bak with the same content", () => {
    const root = tmp();
    legacy(root);
    writeSecretsFileAndBackup(root, { "core.localToken": "d".repeat(64), "core.secretsIn": "vault" });
    expect(readFileSync(`${file(root)}.bak`, "utf8")).toBe(readFileSync(file(root), "utf8"));
    expect(statSync(`${file(root)}.bak`).mode & 0o777).toBe(0o600);
  });

  it("marked as moved but the vault has no identity: an error, not a new identity", async () => {
    const root = tmp();
    await loadCoreSecrets(root, vault(root));
    await vault(root).delete("core.linkIdentity");
    await expect(loadCoreSecrets(root, vault(root))).rejects.toThrow(/core\.linkIdentity 不在保管庫裡/);
    expect(await vault(root).get("core.linkIdentity")).toBeUndefined();
  });

  it("an older folder whose vault does not open still starts on the file's keys (and moves nothing)", async () => {
    const root = tmp();
    await vault(root).set("composio.apiKey", "k-1"); // a vault from before, sealed with vault.key
    rmSync(join(root, "vault.key"));
    const old = legacy(root);
    const r = await loadCoreSecrets(root, vault(root));
    expect(r.migration?.state).toBe("failed");
    expect(r.core.linkIdentity).toEqual(JSON.parse(old["link.identityKey"] as string));
    expect(read(file(root))["link.identityKey"]).toBe(old["link.identityKey"]);
  });

  it("a malformed key in the vault is an error, not a new identity", async () => {
    const root = tmp();
    await loadCoreSecrets(root, vault(root));
    await vault(root).set("core.vapidKey", '{"kty":"EC"}');
    await expect(loadCoreSecrets(root, vault(root))).rejects.toThrow(/core\.vapidKey 格式不對/);
  });

  it("openDataDir hands out the one vault, reports the move, and the audit row has no values", async () => {
    const root = tmp();
    const old = legacy(root);
    const d = await openDataDir(root);
    expect(d.migration?.state).toBe("moved");
    expect(await d.vault.get("core.linkIdentity")).toBe(old["link.identityKey"]);
    expect(d.vault.keyStatus()).toMatchObject({ where: "file", degraded: true });
    expect(statSync(file(root)).mode & 0o777).toBe(0o600);
    const store = openStore(d.dbPath);
    try {
      auditSecretsMoved(store, "vault:file");
      const row = store.db.prepare("SELECT action, detail FROM audit_log ORDER BY id DESC LIMIT 1").get() as {
        action: string;
        detail: string;
      };
      expect(row.action).toBe("secrets.migrated");
      expect(row.detail).not.toContain(JSON.parse(old["link.identityKey"] as string).d);
    } finally {
      store.close();
    }
  });
});

describe("alca secrets export / import / reset / status (§6.4)", () => {
  it("export writes the pre-D1 format (0600) an older version reads; import into another folder keeps the identity", async () => {
    const a = tmp();
    const first = await openDataDir(a);
    await ensureDataKey(first.vault); // Phase F2's key travels too
    const out = join(tmp(), "alca-secrets.json");
    expect((await cli(["export", "--to-file", out, "--data-dir", a])).code).toBe(2); // needs --confirm
    const drop = writeCorePid(a);
    expect((await cli(["export", "--to-file", out, "--confirm", "--data-dir", a])).code).toBe(3);
    drop();
    const r = await cli(["export", "--to-file", out, "--confirm", "--data-dir", a]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(first.core.localToken);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    // The downgrade path: what the pre-D1 parser expects (the three fields, valid).
    const exported = parseCoreSecretsFile(readFileSync(out));
    expect(JSON.parse(exported["link.identityKey"] as string)).toEqual(first.core.linkIdentity);
    expect(JSON.parse(exported["push.vapidKey"] as string)).toEqual(first.core.vapidKey);
    expect(exported["core.dbKey"]).toBeDefined();
    expect((await cli(["export", "--to-file", out, "--confirm", "--data-dir", a])).code).toBe(2); // no overwrite

    const b = tmp();
    const before = await openDataDir(b); // the new computer already started once
    expect((await cli(["import", out, "--data-dir", b])).code).toBe(2);
    const imp = await cli(["import", out, "--confirm", "--data-dir", b]);
    expect(imp.code).toBe(0);
    expect(imp.out).toContain("原本的身分被取代");
    const after = await openDataDir(b);
    expect(after.core).toEqual(first.core);
    expect(after.core.linkIdentity).not.toEqual(before.core.linkIdentity);
    expect(await after.vault.get("core.dbKey")).toBe(exported["core.dbKey"]);
    expect(readdirSync(b).some((n) => n.startsWith("secrets.json.reset-"))).toBe(true);
    expect(read(file(b))["link.identityKey"]).toBeUndefined();
  });

  it("import into a folder that does not exist yet creates it (0700) and starts with the same identity (BUG-2)", async () => {
    const a = tmp();
    const first = await openDataDir(a);
    const out = join(tmp(), "alca-secrets.json");
    expect((await cli(["export", "--to-file", out, "--confirm", "--data-dir", a])).code).toBe(0);
    const b = join(tmp(), "new", "alca-data");
    expect(existsSync(b)).toBe(false);
    const imp = await cli(["import", out, "--confirm", "--data-dir", b]);
    expect(imp.code).toBe(0);
    expect(statSync(b).mode & 0o777).toBe(0o700);
    for (const n of readdirSync(b)) expect(statSync(join(b, n)).mode & 0o777).toBe(0o600);
    const after = await openDataDir(b);
    expect(after.core).toEqual(first.core);
  });

  it("export from an older folder (keys still in secrets.json) works too", async () => {
    const root = tmp();
    const old = legacy(root);
    const out = join(tmp(), "x.json");
    expect((await cli(["export", "--to-file", out, "--confirm", "--data-dir", root])).code).toBe(0);
    expect(read(out)).toEqual(old);
  });

  it("export with a vault that does not open says so (exit 3) and writes nothing", async () => {
    const root = tmp();
    await openDataDir(root);
    rmSync(join(root, "vault.key"));
    const out = join(tmp(), "x.json");
    const r = await cli(["export", "--to-file", out, "--confirm", "--data-dir", root]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("保管庫打不開");
    expect(existsSync(out)).toBe(false);
  });

  it("reset removes only the identity and push key from the vault; API keys and the data key stay", async () => {
    const root = tmp();
    const a = await openDataDir(root);
    await a.vault.set("composio.apiKey", "k-123");
    const { ring } = await ensureDataKey(a.vault);
    expect((await cli(["reset", "--confirm", "--data-dir", root])).code).toBe(0);
    const v = vault(root);
    expect(await v.get("core.linkIdentity")).toBeUndefined();
    expect(await v.get("composio.apiKey")).toBe("k-123");
    expect(await v.get("core.dbKey")).toContain(ring.key.toString("base64"));
    const b = await openDataDir(root);
    expect(b.core.linkIdentity).not.toEqual(a.core.linkIdentity);
  });

  it("reset with a vault that does not open sets the vault aside too", async () => {
    const root = tmp();
    await openDataDir(root);
    rmSync(join(root, "vault.key"));
    const r = await cli(["reset", "--confirm", "--data-dir", root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("API 金鑰");
    expect(existsSync(join(root, "vault.json"))).toBe(false);
    expect(readdirSync(root).some((n) => n.startsWith("vault.json.reset-"))).toBe(true);
    await openDataDir(root); // starts with a new identity and a new vault
  });

  it("status says where each key is and that the vault key is degraded to a file, never values", async () => {
    const root = tmp();
    const old = legacy(root);
    let st = await secretsStatus(root, vault(root));
    expect(st.fields).toEqual({
      "core.localToken": "file",
      "link.identityKey": "file",
      "push.vapidKey": "file",
    });
    await openDataDir(root);
    st = await secretsStatus(root, vault(root));
    expect(st.fields).toEqual({
      "core.localToken": "file",
      "link.identityKey": "vault",
      "push.vapidKey": "vault",
    });
    expect(st.marker).toBe("vault");
    expect(st.vault).toMatchObject({ open: "ok", key: { where: "file", degraded: true } });
    expect(st.vault.coreEntries).toEqual(["core.linkIdentity", "core.vapidKey"]);
    const r = await cli(["status", "--data-dir", root]);
    expect(r.out).toContain("降級");
    expect(r.out).toContain("alca secrets export");
    expect(r.out).not.toContain(old["core.localToken"]);
    rmSync(join(root, "vault.key"));
    expect((await cli(["status", "--data-dir", root])).code).toBe(1);
  });
});

describe("the vault instance", () => {
  it("is a real Vault from openDataDir, shared (no second instance reads a stale cache)", async () => {
    const d = await openDataDir(tmp());
    expect(d.vault).toBeInstanceOf(Vault);
    await d.vault.set("x", "1");
    expect(await d.vault.readBack("x")).toBe("1");
  });
});
