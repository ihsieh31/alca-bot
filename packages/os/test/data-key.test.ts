import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DATA_KEY_NAME,
  DataKeyError,
  deriveSubkey,
  ensureDataKey,
  getDataKey,
  rotateDataKey,
} from "../src/data-key.ts";
import { FileKeySource } from "../src/keychain.ts";
import type { SecretStore } from "../src/secret-store.ts";
import { Vault, VaultError } from "../src/vault.ts";

const make = (d = mkdtempSync(join(tmpdir(), "alca-dek-"))) => ({
  d,
  v: new Vault(join(d, "vault.json"), new FileKeySource(join(d, "vault.key"))),
});

describe("data key for Phase F2 (core.dbKey)", () => {
  it("get never creates; ensure creates once, persisted (a fresh vault reads the same key)", async () => {
    const { d, v } = make();
    expect(await getDataKey(v)).toBeUndefined();
    expect(await v.names()).toEqual([]);
    const a = await ensureDataKey(v);
    expect(a.created).toBe(true);
    expect(a.ring.key).toHaveLength(32);
    expect(a.ring.current).toBe(1);
    const b = await ensureDataKey(make(d).v);
    expect(b.created).toBe(false);
    expect(b.ring.key.equals(a.ring.key)).toBe(true);
  });

  it("rotation adds key 2 and keeps key 1 for older rows", async () => {
    const { v } = make();
    const { ring: one } = await ensureDataKey(v);
    const two = await rotateDataKey(v);
    expect(two.current).toBe(2);
    expect(two.ids).toEqual([1, 2]);
    expect(two.keyFor(1)?.equals(one.key)).toBe(true);
    expect(two.key.equals(one.key)).toBe(false);
    expect((await getDataKey(v))?.current).toBe(2);
  });

  it("a malformed entry is an error, never replaced by a new key", async () => {
    const { v } = make();
    await v.set(DATA_KEY_NAME, '{"v":1,"current":1,"keys":{"1":"c2hvcnQ="}}');
    await expect(getDataKey(v)).rejects.toThrow(DataKeyError);
    await expect(ensureDataKey(v)).rejects.toThrow(DataKeyError);
    expect(await v.get(DATA_KEY_NAME)).toContain("c2hvcnQ=");
  });

  it("a key that does not read back is not returned", async () => {
    const { v } = make();
    const liar: SecretStore = {
      backend: v.backend,
      get: (n) => v.get(n),
      set: (n, x) => v.set(n, x),
      delete: (n) => v.delete(n),
      names: () => v.names(),
      readBack: async () => "other",
    };
    await expect(ensureDataKey(liar)).rejects.toThrow(/讀回不一致/);
  });

  it("a vault that does not open: the error surfaces, no key is made", async () => {
    const { d, v } = make();
    await v.set("x", "1");
    rmSync(join(d, "vault.key"));
    const again = make(d).v;
    await expect(ensureDataKey(again)).rejects.toThrow(VaultError);
  });

  it("deriveSubkey: deterministic per label, unrelated across labels", async () => {
    const { ring } = await ensureDataKey(make().v);
    const fts = deriveSubkey(ring.key, "alca fts");
    expect(fts).toHaveLength(32);
    expect(deriveSubkey(ring.key, "alca fts").equals(fts)).toBe(true);
    expect(deriveSubkey(ring.key, "alca other").equals(fts)).toBe(false);
    expect(fts.equals(ring.key)).toBe(false);
    expect(() => deriveSubkey(ring.key, "")).toThrow(DataKeyError);
  });
});

describe("Vault.readBack / setMany / deleteMany", () => {
  it("readBack decrypts the file again instead of trusting the in-memory copy", async () => {
    const { d, v } = make();
    await v.set("a", "1");
    await make(d).v.set("a", "2"); // another writer changed the file
    expect(await v.get("a")).toBe("1"); // cached
    expect(await v.readBack("a")).toBe("2");
  });

  it("setMany is one write; deleteMany removes only the names given", async () => {
    const { d, v } = make();
    await v.setMany({ a: "1", b: "2", c: "3" });
    expect((await make(d).v.names()).sort()).toEqual(["a", "b", "c"]);
    await v.deleteMany(["a", "b", "zzz"]);
    expect(await make(d).v.names()).toEqual(["c"]);
  });
});
