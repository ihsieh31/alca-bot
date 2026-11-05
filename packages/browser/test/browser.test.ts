import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  assertOwnProfile,
  CdpClosedError,
  CdpConnection,
  CdpError,
  checkNavigableUrl,
  chromiumArgs,
  findChromium,
  PipeTransport,
  UnsafeProfileError,
} from "../src/index.ts";

describe("CDP connection over the pipe framing", () => {
  it("matches responses by id, routes events by session, rejects on close", async () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const conn = new CdpConnection(new PipeTransport(toBrowser, fromBrowser));
    const sent: Array<{ id: number; method: string; sessionId?: string }> = [];
    toBrowser.on("data", (b: Buffer) => {
      for (const part of b.toString().split("\0").filter(Boolean)) sent.push(JSON.parse(part));
    });
    const seen: string[] = [];
    conn.on("Page.loadEventFired", () => seen.push("s1"), "S1");
    conn.on("Page.loadEventFired", () => seen.push("any"), "*");
    const a = conn.send("Browser.getVersion");
    const b = conn.send("Page.navigate", { url: "x" }, "S1");
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.map((m) => [m.method, m.sessionId])).toEqual([
      ["Browser.getVersion", undefined],
      ["Page.navigate", "S1"],
    ]);
    // Two messages in one chunk, one split across chunks.
    const r1 = JSON.stringify({ id: sent[0]?.id, result: { product: "C" } });
    const r2 = JSON.stringify({ id: sent[1]?.id, error: { code: -32000, message: "nope" } });
    const ev = JSON.stringify({ method: "Page.loadEventFired", params: {}, sessionId: "S2" });
    fromBrowser.write(`${r1}\0${r2.slice(0, 10)}`);
    fromBrowser.write(`${r2.slice(10)}\0${ev}\0`);
    expect(await a).toEqual({ product: "C" });
    await expect(b).rejects.toBeInstanceOf(CdpError);
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(["any"]);
    const c = conn.send("Target.getTargets");
    fromBrowser.end();
    await expect(c).rejects.toBeInstanceOf(CdpClosedError);
    await expect(conn.send("x")).rejects.toBeInstanceOf(CdpClosedError);
  });
});

describe("launching our own Chromium", () => {
  it("refuses everyday browsers' default profile directories", () => {
    const home = "/home/u";
    expect(() => assertOwnProfile("/home/u/.config/google-chrome", home, {})).toThrow(UnsafeProfileError);
    expect(() => assertOwnProfile("/home/u/.config/google-chrome/Default", home, {})).toThrow(
      UnsafeProfileError,
    );
    expect(() => assertOwnProfile("/home/u/Library/Application Support/Google/Chrome", home, {})).toThrow();
    expect(() => assertOwnProfile("/home/u/.alca/browser/profile", home, {})).not.toThrow();
  });
  it("uses the pipe, never a debugging port, and its own profile", () => {
    const args = chromiumArgs({ executablePath: "x", userDataDir: "/tmp/p", headless: true });
    expect(args).toContain("--remote-debugging-pipe");
    expect(args.some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
    expect(args).toContain("--user-data-dir=/tmp/p");
    expect(args).toContain("--headless=new");
    // R3: WebRTC cannot go peer-to-peer from this browser.
    expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  });
  it("finds a binary from $ALCA_CHROMIUM, then bundled, then system paths", () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    expect(findChromium({ env: { ALCA_CHROMIUM: "/opt/c" }, exists: has(["/opt/c"]) })).toBe("/opt/c");
    expect(findChromium({ env: { ALCA_CHROMIUM: "/opt/missing" }, exists: has(["/usr/bin/chromium"]) })).toBe(
      undefined,
    );
    expect(
      findChromium({
        env: {},
        bundledDir: "/b",
        exists: has(["/b/chrome-linux64/chrome", "/usr/bin/chromium"]),
      }),
    ).toBe("/b/chrome-linux64/chrome");
    expect(findChromium({ env: {}, exists: has(["/usr/bin/chromium"]) })).toBe("/usr/bin/chromium");
  });
  it("only navigates to web pages", () => {
    expect(checkNavigableUrl("example.com")).toBe("https://example.com/");
    expect(checkNavigableUrl("about:blank")).toBe("about:blank");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "data:text/html,x"])
      expect(() => checkNavigableUrl(bad)).toThrow();
  });
});
