// Plan §5 acceptance: a general worker signs in with a vault password on the
// formal path (router → workers → gate → Alca Browser on a fake CDP), and
// the password is in no event, no store table (journal, ledger, messages,
// jobs, audit), no Space recording and no browser event. Fictional data only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserAgent, BrowserHost, browserTools, generalBrowserTools } from "@alca/browser";
import { FileKeySource, SiteLogins, Vault } from "@alca/connectors";
import { hostToolsFrom } from "@alca/core";
import type { ScriptContext, ScriptStep } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type FakePage, fakeBrowser } from "../../../packages/browser/testing/fake-cdp.ts";
import {
  call,
  type Harness,
  lastLine,
  makeAgents,
  say,
  until,
} from "../../../packages/core/test/agents-helpers.ts";

const SITE: Record<string, FakePage> = {
  "https://library.example.com/login": {
    title: "虛構圖書館登入",
    nodes: [
      { role: "textbox", name: "借書證號", id: 1, facts: { tag: "input" } },
      { role: "textbox", name: "密碼", id: 2, facts: { tag: "input", type: "password" } },
    ],
  },
};
const PASSWORD = "Fict1onal-Library-Pw";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every row of every table, as text. */
function dumpStore(x: Harness): string {
  const db = x.store.db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())).join("\n");
}

describe("vault password fill on the formal path (plan §5)", () => {
  it("fills the field in the page, and the value appears in no event, record or journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-general-"));
    dirs.push(dir);
    const logins = new SiteLogins(
      new Vault(join(dir, "vault.json"), new FileKeySource(join(dir, "vault.key"))),
    );
    const secretId = await logins.save({
      origin: "https://library.example.com",
      password: PASSWORD,
      username: "R-0001",
    });
    const { cdp, proc } = fakeBrowser(SITE);
    const host = new BrowserHost({ launchShared: async () => proc });
    const browserEvents: unknown[] = [];
    host.subscribe((e) => browserEvents.push(e));
    const worker = ({ pass }: ScriptContext): ScriptStep[] => {
      switch (pass) {
        case 0:
          return call("o", "browser_open", { url: "https://library.example.com/login" });
        case 1:
          return call("s", "browser_script", { script: "return 1" });
        case 2:
          return call("f", "browser_fill_secret", { ref: "@2", secretId });
        case 3:
          return call("s2", "browser_script", { script: "const s = await snapshot(); log(s); return s" });
        case 4:
          return call("rep", "report_result", {
            status: "done",
            summary: "已用金庫的密碼登入欄位填好。",
            claims: [{ text: "密碼已填", evidenceRef: "https://library.example.com/login" }],
          });
        default:
          return say("完成");
      }
    };
    const router = ({ req, pass }: ScriptContext): ScriptStep[] => {
      if (req.userMessage.includes("<alca:worker")) return say("收到");
      return pass === 0
        ? call("w", "worker_start", {
            title: "登入圖書館",
            goal: lastLine(req.userMessage),
            harness: "general",
          })
        : say("派了");
    };
    h = makeAgents({
      router,
      worker,
      level: "autonomous",
      tools: hostToolsFrom(browserTools(host)),
      system: {
        webFetch: false,
        generalTools: () => hostToolsFrom(generalBrowserTools(host, { secrets: logins })),
      },
    });
    const workerEvents: AlcaEvent[] = [];
    const publishTo = h.core.bus.publishTo.bind(h.core.bus);
    h.core.bus.publishTo = (key, e) => {
      if (key.startsWith("worker:")) workerEvents.push(e);
      publishTo(key, e);
    };
    const t = h.core.createThread();
    await h.core.send(t.id, "幫我登入虛構圖書館").done;
    await until(
      () =>
        h?.store.threads
          .messages(t.id)
          .find((m) => m.role === "system" && m.content.includes("<alca:worker")),
      25_000,
    );

    // The value reached the page (host → browser), into the password field.
    const typed = cdp.calls.filter((c) => c.method === "Input.insertText").map((c) => c.params.text);
    expect(typed).toContain(PASSWORD);
    const fill = workerEvents.find(
      (e): e is Extract<AlcaEvent, { type: "tool.completed" }> =>
        e.type === "tool.completed" && String(e.data.result ?? "").includes("金庫"),
    );
    expect(fill?.data.ok).toBe(true);
    // The snapshot after the fill shows the field masked.
    expect(JSON.stringify(workerEvents)).toContain("••••");

    // …and nowhere else.
    const space = host.list(h.store.bots.default()?.id ?? "")[0];
    const recording = space
      ? JSON.stringify(new BrowserAgent(host).recording(space.spaceId, space.botId))
      : "";
    for (const [where, text] of [
      ["thread events", JSON.stringify(h.events)],
      ["worker events", JSON.stringify(workerEvents)],
      ["agent events", JSON.stringify(h.agentEvents)],
      ["store (journal, ledger, messages, jobs, audit)", dumpStore(h)],
      ["browser events", JSON.stringify(browserEvents)],
      ["recording", recording],
    ])
      expect(text, where).not.toContain(PASSWORD);
    const w = h.store.workers.byThread(t.id)[0];
    expect(h.store.dispatches.get(w?.grants.dispatchId ?? "")).toMatchObject({ outcome: "done" });
  }, 40_000);
});
