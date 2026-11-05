// Mac device test 2026-11-05 BUG-1: a brand-new data folder picked up the old
// shared `vault-key` item (the person's main key) and kept writing to it.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type KeySource, LazyKeySource } from "../src/keychain.ts";
import { Vault } from "../src/vault.ts";

/** A keychain item held in a shared map, counting reads and writes. */
class FakeItem implements KeySource {
  readonly kind = "keychain-macos";
  loads = 0;
  saves = 0;
  readonly items: Map<string, Buffer>;
  readonly account: string;
  private readonly refuse: boolean;
  constructor(items: Map<string, Buffer>, account: string, refuse = false) {
    this.items = items;
    this.account = account;
    this.refuse = refuse;
  }
  async load() {
    this.loads++;
    return this.items.get(this.account);
  }
  async save(key: Buffer) {
    this.saves++;
    if (this.refuse) throw new Error("refused");
    this.items.set(this.account, Buffer.from(key));
  }
}

const dir = () => mkdtempSync(join(tmpdir(), "alca-kc-legacy-"));

describe("LazyKeySource and the old shared item", () => {
  it("a brand-new folder never reads or writes the shared item; the first save makes its own", async () => {
    const items = new Map<string, Buffer>([["vault-key", Buffer.alloc(32, 7)]]);
    const own = new FakeItem(items, "vault-key-0123456789ab");
    const shared = new FakeItem(items, "vault-key");
    const d = dir();
    const src = new LazyKeySource({ dir: d, keychains: [own], legacy: [shared] });
    const v = new Vault(join(d, "vault.json"), src);
    await v.set("k", "v");
    expect(shared.loads).toBe(0);
    expect(shared.saves).toBe(0);
    expect(own.saves).toBe(1);
    expect(items.get("vault-key-0123456789ab")?.equals(Buffer.alloc(32, 7))).toBe(false);
    expect(items.get("vault-key")?.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(src.kind).toBe("keychain-macos");
    expect(existsSync(join(d, "vault.key"))).toBe(false);
    // Reopening reads its own item only.
    const again = new LazyKeySource({ dir: d, keychains: [own], legacy: [shared] });
    expect(await new Vault(join(d, "vault.json"), again).get("k")).toBe("v");
    expect(shared.loads).toBe(0);
  });

  it("an existing vault on the shared item opens, then moves to its own item; later saves skip the shared one", async () => {
    const items = new Map<string, Buffer>();
    const shared = new FakeItem(items, "vault-key");
    const d = dir();
    // Sealed under the shared item before E7.
    await new Vault(join(d, "vault.json"), shared).set("k", "v");
    const sharedKey = items.get("vault-key");
    shared.saves = 0;
    const own = new FakeItem(items, "vault-key-aaaaaaaaaaaa");
    const src = new LazyKeySource({ dir: d, keychains: [own], legacy: [shared] });
    const v = new Vault(join(d, "vault.json"), src);
    expect(await v.get("k")).toBe("v");
    expect(items.get("vault-key-aaaaaaaaaaaa")?.equals(sharedKey as Buffer)).toBe(true);
    await v.set("k2", "v2");
    expect(shared.saves).toBe(0);
    // The next start finds its own item first and never touches the shared one.
    const loadsBefore = shared.loads;
    const next = new LazyKeySource({ dir: d, keychains: [own], legacy: [shared] });
    expect(await new Vault(join(d, "vault.json"), next).get("k2")).toBe("v2");
    expect(shared.loads).toBe(loadsBefore);
  });

  it("if the folder's item refuses the copy, the shared item stays read only", async () => {
    const items = new Map<string, Buffer>();
    const shared = new FakeItem(items, "vault-key");
    const d = dir();
    await new Vault(join(d, "vault.json"), shared).set("k", "v");
    shared.saves = 0;
    const own = new FakeItem(items, "vault-key-bbbbbbbbbbbb", true);
    const src = new LazyKeySource({ dir: d, keychains: [own], legacy: [shared] });
    expect(await new Vault(join(d, "vault.json"), src).get("k")).toBe("v");
    await src.save(Buffer.alloc(32, 1)); // never the shared item
    expect(shared.saves).toBe(0);
    expect(items.has("vault-key-bbbbbbbbbbbb")).toBe(false);
  });

  it("a key that does not open the vault is not copied", async () => {
    const items = new Map<string, Buffer>([["vault-key", Buffer.alloc(32, 9)]]);
    const d = dir();
    const other = new FakeItem(new Map(), "elsewhere");
    await new Vault(join(d, "vault.json"), other).set("k", "v");
    const own = new FakeItem(items, "vault-key-cccccccccccc");
    const src = new LazyKeySource({
      dir: d,
      keychains: [own],
      legacy: [new FakeItem(items, "vault-key")],
    });
    await expect(new Vault(join(d, "vault.json"), src).get("k")).rejects.toThrow();
    expect(items.has("vault-key-cccccccccccc")).toBe(false);
  });
});
