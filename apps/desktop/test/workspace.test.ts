// Desktop × P13 agent features: a bot's working folder (checked on PATCH),
// Alca's own file tools writing there, the thread's undo list and undo,
// 提前做 requested through the API turning into a draft (router mode, demo).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedEngine, streamText } from "@alca/engines";
import type { AlcaEvent } from "@alca/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

let app: DesktopApp | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> => {
  const a = app as DesktopApp;
  const res = await fetch(`${a.server.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${a.token}`,
      ...a.uiHeaders,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const until = async <T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 15_000) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("desktop × P13 working folder + undo", () => {
  it("PATCH checks the folder; file_write lands there; the turn is listed and undone once", async () => {
    // The real path: on macOS tmpdir() is /var/folders/… → /private/var/folders/… and Alca reports
    // folders as they really are (mac test 2026-11-04).
    const root = realpathSync(mkdtempSync(join(tmpdir(), "alca-desk-p13-")));
    dirs.push(root);
    const data = join(root, "data");
    mkdirSync(data);
    writeFileSync(join(data, "config.json"), JSON.stringify({ permissions: { level: "autonomous" } }));
    const engine = new ScriptedEngine(({ pass }) =>
      pass === 0
        ? [
            {
              type: "tool.call",
              id: "c1",
              name: "file_write",
              input: { path: "notes/todo.md", content: "- 買牛奶" },
            },
            { type: "done", stop: "tool_use" },
          ]
        : streamText("寫好了"),
    );
    app = await startDesktop({
      engine: "demo",
      agents: "direct",
      dataDir: data,
      port: 0,
      browser: "off",
      engineOverride: engine,
    });
    const bot = app.core.defaultBotId;
    const team = (await api("GET", "/api/team")).body;
    expect(team.bots[0].workDirNow).toBe(join(data, "bots", bot, "work"));
    expect((await api("PATCH", `/api/bots/${bot}`, { workDir: "relative/x" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot}`, { workDir: data })).status).toBe(400);
    // Mac test 2026-11-04b E4: the literal ~/.ssh (as typed) was accepted at b0343040.
    for (const d of ["~/.ssh", "~/Library", "~/.claude"]) {
      const r = await api("PATCH", `/api/bots/${bot}`, { workDir: d });
      expect(r.status, d).toBe(400);
      expect(JSON.stringify(r.body), d).toContain("金鑰、帳號或其他程式資料");
    }
    expect((await api("PATCH", `/api/bots/${bot}`, { quietHours: "晚上" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot}`, { shellReview: "maybe" })).status).toBe(400);
    const proj = join(root, "proj");
    const ok = await api("PATCH", `/api/bots/${bot}`, {
      workDir: proj,
      shellReview: "on",
      earlyWork: "on",
      quietHours: "23:00-07:00",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ workDir: proj, workDirNow: proj, shellReview: "on", earlyWork: "on" });

    const t = (await api("POST", "/api/threads", {})).body.id as string;
    await api("POST", `/api/threads/${t}/messages`, { text: "記下來" });
    await until(() => existsSync(join(proj, "notes/todo.md")));
    expect(readFileSync(join(proj, "notes/todo.md"), "utf8")).toBe("- 買牛奶");
    await until(() => !app?.core.isBusy(t));
    const list = (await api("GET", `/api/undo/${t}`)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ canUndo: true, paths: [{ path: "notes/todo.md", created: true }] });
    const undone = await api("POST", `/api/undo/${t}/${list[0].turnRunId}`);
    expect(undone.status).toBe(200);
    expect(existsSync(join(proj, "notes/todo.md"))).toBe(false);
    expect((await api("POST", `/api/undo/${t}/${list[0].turnRunId}`)).status).toBe(409);
    expect((await api("GET", `/api/undo/${t}`)).body[0].canUndo).toBe(false);
    // Direct mode has no router: 提前做 needs one.
    expect((await api("POST", "/api/early", { threadId: t, goal: "準備" })).status).toBe(409);
  }, 30_000);

  it("提前做 through the API (router mode, demo engines): a background worker, then a draft; no card", async () => {
    const data = mkdtempSync(join(tmpdir(), "alca-desk-p13e-"));
    dirs.push(data);
    app = await startDesktop({ engine: "demo", dataDir: data, port: 0, browser: "off" });
    const cards: AlcaEvent[] = [];
    app.core.bus.subscribe("*", (e) => {
      if (e.type === "approval.requested") cards.push(e);
    });
    const bot = app.core.defaultBotId;
    const t = (await api("POST", "/api/threads", {})).body.id as string;
    const off = (await api("POST", "/api/early", { threadId: t, goal: "準備明天的會議資料" })).body;
    expect(off).toMatchObject({ status: "skipped" });
    await api("PATCH", `/api/bots/${bot}`, { earlyWork: "on" });
    const item = (await api("POST", "/api/early", { threadId: t, goal: "準備明天的會議資料", title: "會議" }))
      .body;
    const ready = await until(async () =>
      ((await api("GET", `/api/early?thread=${t}`)).body as Json[]).find(
        (i) => i.id === item.id && i.status === "ready",
      ),
    );
    expect(ready.draftIds).toHaveLength(1);
    const drafts = (await api("GET", `/api/drafts?thread=${t}`)).body as Json[];
    expect(drafts.map((d) => d.id)).toContain(ready.draftIds[0]);
    expect(cards).toEqual([]);
  }, 30_000);
});
