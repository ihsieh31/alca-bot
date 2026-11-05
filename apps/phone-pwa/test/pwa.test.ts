import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { startRendezvous } from "@alca/rendezvous";
import { afterAll, describe, expect, it } from "vitest";
import { argSummary, IdNames } from "../app/timeline.ts";
import { buildPwa } from "../scripts/build.ts";

const dist = buildPwa(mkdtempSync(join(tmpdir(), "alca-pwa-test-")), {});
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [relative(dist, p)];
  });

describe("phone PWA build", () => {
  it("emits browser-loadable modules only (no .ts, node: or @alca/ imports)", () => {
    const js = walk(dist).filter((f) => f.endsWith(".js"));
    expect(js).toContain("app/main.js");
    expect(js).toContain("link/browser.js");
    for (const f of ["app/memory.js", "app/skills.js", "app/learn-view.js"]) expect(js).toContain(f);
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain("./styles/memory.css");
    expect(walk(dist)).toContain("styles/memory.css");
    for (const f of js) {
      const code = readFileSync(join(dist, f), "utf8");
      expect(code, f).not.toMatch(/from\s+"[^"]+\.ts"/);
      expect(code, f).not.toMatch(/from\s+"(node:|@alca\/)/);
    }
  });

  it("G2: copies the shared string table and gives the service worker its words in both languages", () => {
    const js = walk(dist);
    for (const f of ["app/i18n/index.js", "app/i18n/zh-Hant-TW.js", "app/i18n/en.js", "app/i18n/zh/shell.js"])
      expect(js).toContain(f);
    expect(readFileSync(join(dist, "app/main.js"), "utf8")).toContain('from "./i18n/index.js"');
    const sw = readFileSync(join(dist, "sw.js"), "utf8");
    expect(sw).not.toContain("__WORDS__");
    expect(sw).not.toMatch(/^\s*import[\s{]/m);
    expect(sw).toContain("打開 Alca 回答。");
    expect(sw).toContain("Open Alca to answer.");
  });

  it("writes a service worker that precaches exactly the built files under a content version", () => {
    const sw = readFileSync(join(dist, "sw.js"), "utf8");
    expect(sw).not.toContain("__VERSION__");
    expect(sw).not.toContain("__ASSETS__");
    for (const f of walk(dist).filter((f) => f !== "sw.js")) expect(sw, f).toContain(`"./${f}"`);
    const again = buildPwa(mkdtempSync(join(tmpdir(), "alca-pwa-test-")), {});
    const version = (s: string) => /"([0-9a-f]{12})"/.exec(s)?.[1];
    expect(version(readFileSync(join(again, "sw.js"), "utf8"))).toBe(version(sw));
    rmSync(again, { recursive: true, force: true });
  });

  it("has an installable manifest whose icons exist", () => {
    const m = JSON.parse(readFileSync(join(dist, "manifest.webmanifest"), "utf8")) as {
      display: string;
      start_url: string;
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
    };
    expect(m.display).toBe("standalone");
    expect(m.icons.some((i) => i.sizes === "512x512" && i.purpose?.includes("maskable"))).toBe(true);
    for (const i of m.icons) expect(existsSync(join(dist, i.src.replace(/^\.?\//, ""))), i.src).toBe(true);
  });

  it("is served by the self-hosted relay next to the Link socket", async () => {
    const relay = await startRendezvous({ port: 0, pwaDir: dist });
    try {
      const page = await fetch(`${relay.url}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("app/main.js");
      const sw = await fetch(`${relay.url}/sw.js`);
      expect(sw.status).toBe(200);
      expect(sw.headers.get("content-type")).toMatch(/javascript/);
      for (const p of ["/diag", "/diag/", "/diag?x=1"]) {
        const r = await fetch(`${relay.url}${p}`, { redirect: "manual" });
        expect(r.status, p).toBe(302);
        expect(r.headers.get("location")).toBe("/#diag");
      }
      // Other app routes still fall back to the shell.
      expect((await fetch(`${relay.url}/diagnostics`, { redirect: "manual" })).status).toBe(200);
    } finally {
      await relay.close();
    }
  });
});

describe("tool rows", () => {
  it("names our ids in words, says where a paged recall picks up and never shows raw JSON", () => {
    const id = "spl_01M6G116YBKWE2DDTCF6MH7HPG";
    const other = "spl_01M6G116YBKWE2DDTCF6MH7HPZ";
    const names = new IdNames();
    expect(argSummary({ id }, names)).toBe("第 1 份結果");
    expect(argSummary({ id, offset: 1500 }, names)).toBe("第 1 份結果（從第 1500 字起）");
    expect(argSummary({ id: other }, names)).toBe("第 2 份結果");
    expect(argSummary({ workerId: "wkr_01M6G116YBKWE2DDTCF6MH7HPG" }, names)).toBe("第 1 個任務");
    expect(argSummary({ ref: "@8" }, names)).toBe("畫面上第 8 個元素");
    expect(argSummary({ id }, names)).toBe("第 1 份結果");
    expect(argSummary({ url: "https://example.com" })).toBe("https://example.com");
    expect(argSummary({})).toBe("");
    expect(argSummary({ limit: 5, nested: { a: 1 } })).toBe("");
    for (const shown of [argSummary({ id }), argSummary({ id: other }, names)])
      expect(shown).not.toMatch(/spl_|[{}]/);
  });
});
