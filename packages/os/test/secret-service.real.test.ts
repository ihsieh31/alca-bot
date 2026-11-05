// The real freedesktop Secret Service through `secret-tool` (Phase D1).
// Runs only with ALCA_TEST_SECRET_SERVICE=1 inside a D-Bus session with an
// unlocked keyring, e.g.:
//   dbus-run-session -- sh -c 'echo -n pw | gnome-keyring-daemon --unlock --components=secrets >/dev/null;
//     ALCA_TEST_SECRET_SERVICE=1 pnpm vitest run packages/os/test/secret-service.real.test.ts'
// CI has no Secret Service, so it is skipped there.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultKeySource, keychainAccount, SecretServiceKeySource } from "../src/keychain.ts";
import { Vault } from "../src/vault.ts";

const on = process.env.ALCA_TEST_SECRET_SERVICE === "1" && process.platform === "linux";
const d = mkdtempSync(join(tmpdir(), "alca-ss-real-"));
const account = keychainAccount(d);

describe.skipIf(!on)("real Secret Service", () => {
  afterAll(() => {
    try {
      execFileSync("secret-tool", ["clear", "service", "alca-agent", "account", account]);
    } catch {
      // already gone
    }
  });

  it("the vault key goes into the keyring, not a file, and a new process reads it", async () => {
    const src = defaultKeySource(d);
    const v = new Vault(join(d, "vault.json"), src);
    await v.set("core.linkIdentity", "{}");
    expect(v.keyStatus()).toEqual({ where: "secret-service", degraded: false });
    expect(existsSync(join(d, "vault.key"))).toBe(false);
    const back = await new SecretServiceKeySource(undefined, account).load();
    expect(back).toHaveLength(32);
    expect(await new Vault(join(d, "vault.json"), defaultKeySource(d)).get("core.linkIdentity")).toBe("{}");
  });

  it("without a D-Bus session the same code falls back to the file and says why", async () => {
    const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      const e = mkdtempSync(join(tmpdir(), "alca-ss-none-"));
      const v = new Vault(join(e, "vault.json"), defaultKeySource(e));
      await v.set("x", "1");
      expect(v.keyStatus()).toMatchObject({ where: "file", degraded: true });
      expect(existsSync(join(e, "vault.key"))).toBe(true);
    } finally {
      process.env.DBUS_SESSION_BUS_ADDRESS = saved;
    }
  });
});
