// G1, across the two ends: the phone runs the *built* page modules
// (dist/link/*.js with @noble vendored under dist/vendor/), the computer runs
// packages/link/src. Same implementation, two packagings: they must pair on
// PAKE v2 and the built copy must pass the RFC 9382 vectors by itself.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import * as src from "../../../packages/link/src/browser.ts";
import { RFC9382_VECTORS } from "../../../packages/link/test/fixtures/rfc9382-vectors.ts";
import { buildPwa } from "../scripts/build.ts";

const dist = buildPwa(mkdtempSync(join(tmpdir(), "alca-pwa-pake-")), {});
// Node needs to be told the copied files are ES modules (a browser loads them as type=module).
writeFileSync(join(dist, "package.json"), '{"type":"module"}\n');
afterAll(() => rmSync(dist, { recursive: true, force: true }));

type Built = typeof src;
const built = (): Promise<Built> => import(pathToFileURL(join(dist, "link", "browser.js")).href);
const builtSpake = (): Promise<typeof import("../../../packages/link/src/spake2.ts")> =>
  import(pathToFileURL(join(dist, "link", "spake2.js")).href);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [relative(dist, p)];
  });

describe("PAKE v2 on the built phone page", () => {
  it("vendors only the noble group code, with both licenses, and no bare imports", () => {
    const vendor = walk(dist).filter((f) => f.startsWith("vendor/"));
    expect(vendor).toContain("vendor/noble/curves/abstract/weierstrass.js");
    expect(vendor).toContain("vendor/noble/curves/LICENSE");
    expect(vendor).toContain("vendor/noble/hashes/LICENSE");
    expect(vendor.some((f) => /ed25519|frost|oprf|nist\.js/.test(f))).toBe(false);
    // PAKE v1 is removed: its modules are not shipped and no built file carries its labels.
    expect(walk(dist).filter((f) => /(^|\/)(pake|p256)\.js$/.test(f))).toEqual([]);
    for (const f of walk(dist).filter((x) => x.endsWith(".js"))) {
      const code = readFileSync(join(dist, f), "utf8");
      expect(code, f).not.toMatch(/^(?:import|export)\b[^;'"`]*?\bfrom\s*["'](?![./])/m);
      expect(code, f).not.toMatch(/spake2-p256|alca-link\/v1 (?:pair|enroll)|hashToPoint|pakeStart/);
    }
    expect(readFileSync(join(dist, "sw.js"), "utf8")).toContain(
      '"./vendor/noble/curves/abstract/weierstrass.js"',
    );
  });

  it("the built copy passes the RFC 9382 Appendix B vectors on its own", async () => {
    const b = await builtSpake();
    for (const v of RFC9382_VECTORS) {
      const ids = { a: v.A, b: v.B };
      const a = b.spake2Start("A", BigInt(`0x${v.w}`), ids, BigInt(`0x${v.x}`));
      const bb = b.spake2Start("B", BigInt(`0x${v.w}`), ids, BigInt(`0x${v.y}`));
      const ra = await b.spake2Finish(a, bb.share, new Uint8Array(0));
      const rb = await b.spake2Finish(bb, a.share, new Uint8Array(0));
      expect(hex(ra.confirm)).toBe(v.cA);
      expect(hex(rb.confirm)).toBe(v.cB);
      expect(hex(ra.ke)).toBe(v.Ke);
    }
  });

  it("built phone ↔ source computer: pairing runs v2 and both pin the right keys", async () => {
    const B = await built();
    const [phoneWire, coreWire] = src.wirePair();
    const phoneId = await B.generateIdentity();
    const coreId = await src.generateIdentity(true);
    const code = { nameplate: "381", secret: "204957" };
    let seenPake: number | undefined;
    const [dev, core] = await Promise.all([
      B.pairAsDevice(phoneWire as never, {
        code,
        identity: phoneId,
        device: { name: "iPhone", kind: "phone", platform: "t" },
      }),
      src.pairAsCore(coreWire, {
        code,
        identity: coreId,
        coreName: "Mac",
        onPake: (v) => {
          seenPake = v;
        },
        accept: async () => ({ deviceId: "dev_1", scopes: ["chat"], mailbox: "m" }),
      }),
    ]);
    expect(dev.pake).toBe(2);
    expect(core.pake).toBe(2);
    expect(seenPake).toBe(2);
    expect(hex(dev.corePublicRaw)).toBe(hex(coreId.publicRaw));
    expect(hex(core.publicRaw)).toBe(hex(phoneId.publicRaw));
  });

  it("built phone ↔ source computer: enrollment runs v2", async () => {
    const B = await built();
    const [phoneWire, coreWire] = src.wirePair();
    const coreId = await src.generateIdentity(true);
    const mailbox = await src.mailboxOf(coreId.publicRaw);
    const code = B.newEnrollCode();
    const [dev, core] = await Promise.all([
      B.enrollAsDevice(phoneWire as never, {
        mailbox,
        identity: await B.generateIdentity(),
        device: { name: "iPhone", kind: "phone", platform: "t" },
        code,
      }),
      src.enrollAsCore(coreWire, {
        identity: coreId,
        mailbox,
        coreName: "Mac",
        handler: { askCode: async () => code, accept: async () => ({ deviceId: "dev_2", scopes: ["chat"] }) },
      }),
    ]);
    expect(dev.pake).toBe(2);
    expect(core.pake).toBe(2);
  });
});
