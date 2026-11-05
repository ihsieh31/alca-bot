// Phase D1: the keychain backends tell "no such item" from "did not answer",
// and the vault key's fall back to the 0600 file is reported, with why.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CommandResult,
  KeychainUnavailableError,
  LazyKeySource,
  MacKeychainKeySource,
  SecretServiceKeySource,
} from "../src/keychain.ts";
import { Vault, VaultError } from "../src/vault.ts";

const dir = () => mkdtempSync(join(tmpdir(), "alca-kc-"));
const answer = (r: CommandResult) => async () => r;

describe("macOS Keychain answers", () => {
  it("exit 44 is 'no item'; any other failure is 'did not answer', with the reason", async () => {
    expect(await new MacKeychainKeySource(answer({ code: 44, out: "" }), "a").load()).toBeUndefined();
    await expect(
      new MacKeychainKeySource(
        answer({ code: 51, out: "", err: "User interaction is not allowed." }),
        "a",
      ).load(),
    ).rejects.toThrow(/結束碼 51：User interaction is not allowed/);
    await expect(
      new MacKeychainKeySource(answer({ code: 1, out: "", missing: true }), "a").load(),
    ).rejects.toThrow(KeychainUnavailableError);
  });
});

describe("Secret Service answers", () => {
  it("exit 1 with nothing on stderr is 'no item'; with a message it is 'did not answer'", async () => {
    expect(
      await new SecretServiceKeySource(answer({ code: 1, out: "", err: "" }), "a").load(),
    ).toBeUndefined();
    await expect(
      new SecretServiceKeySource(
        answer({ code: 1, out: "", err: "Cannot autolaunch D-Bus without X11 $DISPLAY" }),
        "a",
      ).load(),
    ).rejects.toThrow(/D-Bus/);
    await expect(
      new SecretServiceKeySource(answer({ code: 1, out: "", missing: true }), "a").load(),
    ).rejects.toThrow(/secret-tool/);
  });

  it("a store that exits 0 but does not keep the key is refused (read back)", async () => {
    const exec = async (_c: string, args: string[]) =>
      args[0] === "store" ? { code: 0, out: "" } : { code: 1, out: "" };
    await expect(new SecretServiceKeySource(exec, "a").save(Buffer.alloc(32, 1))).rejects.toThrow(/讀不回/);
  });
});

describe("LazyKeySource status (§6.4 明確標示)", () => {
  it("a keychain that keeps the key: not degraded", async () => {
    const items = new Map<string, string>();
    const exec = async (_c: string, args: string[], input?: string) => {
      if (args[0] === "store") {
        items.set("k", input ?? "");
        return { code: 0, out: "" };
      }
      const v = items.get("k");
      return v ? { code: 0, out: v } : { code: 1, out: "" };
    };
    const src = new LazyKeySource({ dir: dir(), keychains: [new SecretServiceKeySource(exec, "a")] });
    expect(src.status()).toEqual({ where: "undecided", degraded: false });
    await new Vault(join(dir(), "vault.json"), src).set("x", "1");
    expect(src.status()).toEqual({ where: "secret-service", degraded: false });
  });

  it("no Secret Service: the vault still works, from the 0600 file, and status says why", async () => {
    const d = dir();
    const none = answer({ code: 1, out: "", err: "Cannot autolaunch D-Bus without X11 $DISPLAY" });
    const src = new LazyKeySource({ dir: d, keychains: [new SecretServiceKeySource(none, "a")] });
    const v = new Vault(join(d, "vault.json"), src);
    await v.set("x", "1");
    expect(src.status()).toMatchObject({ where: "file", degraded: true });
    expect(src.status().reason).toContain("D-Bus");
    expect(v.keyStatus()).toEqual(src.status());
  });

  it("forced to the file, no keychain on this OS, an older vault.key: each says so", async () => {
    const forced = new LazyKeySource({ dir: dir(), backend: "file", keychains: [] });
    expect(forced.status()).toMatchObject({ where: "file", degraded: true, forced: true });
    expect(forced.status().reason).toContain("ALCA_VAULT_BACKEND=file");
    const bare = new LazyKeySource({ dir: dir(), keychains: [] });
    expect(bare.status().reason).toContain("沒有 Alca 支援的鑰匙圈");
    const d = dir();
    await new Vault(join(d, "vault.json"), new LazyKeySource({ dir: d, keychains: [] })).set("x", "1");
    const kc = new SecretServiceKeySource(answer({ code: 1, out: "" }), "a");
    const older = new LazyKeySource({ dir: d, keychains: [kc] });
    expect(await new Vault(join(d, "vault.json"), older).get("x")).toBe("1");
    expect(older.status().reason).toContain("已有 vault.key");
  });

  it("a vault whose keychain does not answer cannot open, and the error carries the keychain's reason", async () => {
    const d = dir();
    const items = new Map<string, string>();
    const ok = async (_c: string, args: string[], input?: string) => {
      if (args[0] === "store") items.set("k", input ?? "");
      return args[0] === "store" ? { code: 0, out: "" } : { code: 0, out: items.get("k") ?? "" };
    };
    await new Vault(
      join(d, "vault.json"),
      new LazyKeySource({ dir: d, keychains: [new SecretServiceKeySource(ok, "a")] }),
    ).set("x", "1");
    const locked = answer({ code: 1, out: "", err: "Cannot create an item in a locked collection" });
    const v = new Vault(
      join(d, "vault.json"),
      new LazyKeySource({ dir: d, keychains: [new SecretServiceKeySource(locked, "a")] }),
    );
    const err = await v.get("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).code).toBe("key_missing");
    expect((err as Error).message).toContain("locked collection");
  });
});
