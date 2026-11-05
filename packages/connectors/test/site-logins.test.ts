import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileKeySource, httpsOrigin, SiteLogins, Vault } from "../src/index.ts";

// Plan §5: website passwords in the vault as the general harness's SecretSource (fictional data only).
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const vault = () => {
  const dir = mkdtempSync(join(tmpdir(), "alca-logins-"));
  dirs.push(dir);
  return { dir, v: new Vault(join(dir, "vault.json"), new FileKeySource(join(dir, "vault.key"))) };
};

const PW = "Fict1onal-Passw0rd";

describe("SiteLogins (plan §5)", () => {
  it("gives the password only for the exact https origin and an allowed bot", async () => {
    const { dir, v } = vault();
    const logins = new SiteLogins(v);
    const id = await logins.save({
      origin: "https://library.example.com/login?next=/",
      password: PW,
      username: "reader01",
      label: "圖書館",
      botIds: ["bot_a"],
    });
    expect(await logins.value("bot_a", id, "https://library.example.com")).toBe(PW);
    for (const [bot, origin] of [
      ["bot_b", "https://library.example.com"],
      ["bot_a", "http://library.example.com"],
      ["bot_a", "https://evil.library.example.com"],
      ["bot_a", "https://library.example.com:8443"],
      ["bot_a", "https://library.example.com.evil.example"],
      ["bot_a", "not a url"],
    ])
      expect(await logins.value(bot as string, id, origin as string), `${bot} ${origin}`).toBeUndefined();
    expect(await logins.value("bot_a", "../etc", "https://library.example.com")).toBeUndefined();
    // Listing never carries the password; the file on disk is sealed.
    const listed = JSON.stringify([
      await logins.all(),
      await logins.list("bot_a", "https://library.example.com"),
    ]);
    expect(listed).toContain("reader01");
    expect(listed).not.toContain(PW);
    expect(readFileSync(join(dir, "vault.json"), "utf8")).not.toContain(PW);
    await logins.remove(id);
    expect(await logins.value("bot_a", id, "https://library.example.com")).toBeUndefined();
  });

  it("only keeps https logins", async () => {
    const { v } = vault();
    await expect(
      new SiteLogins(v).save({ origin: "http://plain.example.com", password: PW }),
    ).rejects.toThrow(/HTTPS/);
    expect(httpsOrigin("https://a.example.com/x")).toBe("https://a.example.com");
    expect(httpsOrigin("ftp://a.example.com")).toBeUndefined();
  });
});
