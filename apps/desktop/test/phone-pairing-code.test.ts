import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedEngine, streamText } from "@alca/engines";
import { parseCode } from "@alca/link";
import { startRendezvous } from "@alca/rendezvous";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairingCode } from "../../phone-pwa/scripts/pairing-code.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/**
 * Mac test 2026-11 B5: the phone screenshot script's pairing code. The real
 * page (Chromium) is not run here — that part waits for the Mac — but the
 * code it types is checked against what the pairing button wants. Fictional data only.
 */

vi.setConfig({ testTimeout: 30_000 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** What app/pairing.ts enables the 配對 button on. */
const buttonEnabled = (typed: string) => typed.replace(/\D/g, "").length >= 9;

describe("pairingCode (B5)", () => {
  it("passes a 9–10 digit code; a refusal stops with the server's words", () => {
    expect(pairingCode({ code: "123456789" })).toBe("123456789");
    expect(pairingCode({ code: "1234567890" })).toBe("1234567890");
    expect(() => pairingCode({ error: "需要核准金鑰" })).toThrow(/需要核准金鑰/);
    expect(() => pairingCode({ code: 12345 })).toThrow(/9–10 位/);
    // the old script typed String(undefined): no digits, the button never enabled
    expect(buttonEnabled(String(undefined))).toBe(false);
  });

  it("with the approve-key headers the desktop answers a code the pairing button accepts", async () => {
    const relay = await startRendezvous({ port: 0 });
    cleanups.push(() => relay.close());
    const dir = mkdtempSync(join(tmpdir(), "alca-pair-code-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const app: DesktopApp = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      agents: "direct",
      browser: "off",
      engineOverride: new ScriptedEngine(() => streamText("好", 1)),
      rendezvous: relay.url,
    });
    cleanups.push(() => app.close());
    for (let i = 0; i < 200 && app.link?.host.status !== "online"; i++)
      await new Promise((r) => setTimeout(r, 20));
    const post = async (headers: Record<string, string>) => {
      const res = await fetch(`${app.server.url}/api/link/pairings`, {
        method: "POST",
        headers: { authorization: `Bearer ${app.token}`, ...headers, "content-type": "application/json" },
        body: JSON.stringify({ scopes: ["chat", "approve"] }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    // the token alone (what the phone script sent before): refused, so no code
    const bare = await post({});
    expect(bare.status).toBe(403);
    expect(() => pairingCode(bare.body)).toThrow();
    const keyed = await post(app.uiHeaders);
    expect(keyed.status).toBe(201);
    const code = pairingCode(keyed.body);
    expect(buttonEnabled(code)).toBe(true);
    expect(parseCode(code).secret).toHaveLength(6);
  });
});
