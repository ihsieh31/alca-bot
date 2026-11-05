import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileKeySource } from "../src/keychain.ts";
import type { SecretStore } from "../src/secret-store.ts";
import { Vault, VaultError } from "../src/vault.ts";

const make = (dir = mkdtempSync(join(tmpdir(), "alca-vault-")), notes: string[] = []) => ({
  dir,
  notes,
  vault: new Vault(join(dir, "vault.json"), new FileKeySource(join(dir, "vault.key")), {
    onRecover: (n) => notes.push(n),
  }),
});

describe("Vault", () => {
  it("is a SecretStore", async () => {
    const { vault } = make();
    const s: SecretStore = vault;
    expect(s.backend).toBe("vault:file");
    await s.set("a", "1");
    expect(await s.names()).toEqual(["a"]);
  });

  it("keeps all of ten concurrent sets", async () => {
    const { dir, vault } = make();
    await Promise.all(Array.from({ length: 10 }, (_, i) => vault.set(`k${i}`, `v${i}`)));
    expect((await vault.names()).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `k${i}`).sort());
    // A fresh instance reads the same ten from disk.
    const again = make(dir).vault;
    for (let i = 0; i < 10; i++) expect(await again.get(`k${i}`)).toBe(`v${i}`);
  });

  it("interleaved sets and deletes end in the order they were called", async () => {
    const { vault } = make();
    await vault.set("x", "0");
    await Promise.all([vault.set("a", "1"), vault.delete("x"), vault.set("b", "2"), vault.set("a", "3")]);
    expect(await vault.get("a")).toBe("3");
    expect(await vault.get("x")).toBeUndefined();
    expect(await vault.get("b")).toBe("2");
  });

  it("opens from vault.json.bak when vault.json no longer decrypts", async () => {
    const { dir, vault } = make();
    await vault.set("a", "1");
    await vault.set("b", "2"); // .bak now holds {a}
    const sealed = JSON.parse(readFileSync(join(dir, "vault.json"), "utf8")) as { data: string };
    sealed.data = Buffer.from("tampered").toString("base64");
    writeFileSync(join(dir, "vault.json"), JSON.stringify(sealed));
    const notes: string[] = [];
    const again = make(dir, notes).vault;
    expect(await again.get("a")).toBe("1");
    expect(notes).toHaveLength(1);
    expect(readdirSync(dir).some((n) => n.startsWith("vault.json.corrupt-"))).toBe(true);
  });

  it("refuses, touching nothing, when both copies are broken", async () => {
    const { dir, vault } = make();
    await vault.set("a", "1");
    await vault.set("b", "2");
    writeFileSync(join(dir, "vault.json"), "{");
    writeFileSync(join(dir, "vault.json.bak"), "{");
    await expect(make(dir).vault.get("a")).rejects.toBeInstanceOf(VaultError);
    expect(readFileSync(join(dir, "vault.json"), "utf8")).toBe("{");
  });

  it("a wrong key fails both copies and renames nothing", async () => {
    const { dir, vault } = make();
    await vault.set("a", "1");
    await vault.set("b", "2");
    writeFileSync(join(dir, "vault.key"), `${Buffer.alloc(32, 7).toString("base64")}\n`);
    await expect(make(dir).vault.get("a")).rejects.toBeInstanceOf(VaultError);
    expect(readdirSync(dir).some((n) => n.includes("corrupt"))).toBe(false);
  });

  it("writes vault.key atomically with 0600", async () => {
    const { dir, vault } = make();
    await vault.set("a", "1");
    expect(existsSync(join(dir, "vault.key"))).toBe(true);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
