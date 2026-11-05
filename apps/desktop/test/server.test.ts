import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StartupRefusedError } from "@alca/core";
import { ScriptedEngine, type ScriptStep, streamText } from "@alca/engines";
import { type AlcaEvent, checkSequence, parseEvent } from "@alca/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type DesktopApp, demoTools, startDesktop } from "../src/index.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function engine() {
  return new ScriptedEngine(({ pass, req }): ScriptStep[] => {
    if (pass === 0 && req.userMessage.includes("寫")) {
      return [
        ...streamText("好，我來寫。", 3),
        { type: "tool.call", id: "w1", name: "write_note", input: { title: "待辦", body: "買菜" } },
        { type: "done", stop: "tool_use" },
      ];
    }
    if (pass === 1) return streamText(`完成：${req.toolResults?.[0]?.output}`);
    return streamText("哈囉，這是串流回覆。", 3);
  });
}

async function boot(): Promise<
  DesktopApp & {
    api: (
      method: string,
      path: string,
      body?: unknown,
      token?: string,
      // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
    ) => Promise<{ status: number; body: any }>;
  }
> {
  const dir = mkdtempSync(join(tmpdir(), "alca-desktop-"));
  const app = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    // P1/P2 behaviour of a single turn (the router / worker split is tested in agents.test.ts).
    agents: "direct",
    engineOverride: engine(),
    tools: demoTools(),
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => app.close(),
  );
  const api = async (method: string, path: string, body?: unknown, token = app.token) => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...app.uiHeaders,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return Object.assign(app, { api });
}

/** Read the SSE stream, collecting protocol events until `until` returns true. */
async function readEvents(
  app: DesktopApp,
  until: (events: AlcaEvent[]) => boolean,
  onEvent?: (e: AlcaEvent) => void,
): Promise<AlcaEvent[]> {
  const ac = new AbortController();
  const res = await fetch(`${app.server.url}/api/events`, {
    headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders },
    signal: ac.signal,
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: AlcaEvent[] = [];
  let buf = "";
  const timeout = setTimeout(() => ac.abort(), 8000);
  try {
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let cut = buf.indexOf("\n\n");
      while (cut >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (data) {
          const e = parseEvent(JSON.parse(data.slice(6)));
          events.push(e);
          onEvent?.(e);
        }
        cut = buf.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timeout);
    ac.abort();
  }
  return events;
}

describe("desktop server", () => {
  it("binds loopback, stores the token owner-only, and refuses non-loopback hosts", async () => {
    const app = await boot();
    expect(app.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(statSync(join(app.dataDir, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(app.openUrl).toContain(`#token=${app.token}`);
    const dir = mkdtempSync(join(tmpdir(), "alca-desktop-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    await expect(
      startDesktop({ engine: "demo", dataDir: dir, port: 0, host: "0.0.0.0" }),
    ).rejects.toBeInstanceOf(StartupRefusedError);
  });

  it("requires the local token, checks Host, and serves the UI with a CSP", async () => {
    const app = await boot();
    expect((await fetch(`${app.server.url}/api/health`)).status).toBe(200);
    expect((await app.api("GET", "/api/threads", undefined, "wrong")).status).toBe(401);
    expect((await fetch(`${app.server.url}/api/threads`)).status).toBe(401);
    const rebinding = await new Promise<number>((resolve) => {
      const r = request(`${app.server.url}/api/health`, { headers: { host: "evil.example:80" } }, (res) =>
        resolve(res.statusCode ?? 0),
      );
      r.end();
    });
    expect(rebinding).toBe(403);
    const crossOrigin = await fetch(`${app.server.url}/api/threads`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, origin: "http://evil.example" },
    });
    expect(crossOrigin.status).toBe(403);
    const html = await fetch(`${app.server.url}/`);
    expect(html.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await html.text()).toContain('lang="zh-Hant-TW"');
    const js = await fetch(`${app.server.url}/ui/app.ts`);
    expect(js.headers.get("content-type")).toContain("javascript");
    const code = await js.text();
    expect(code).not.toMatch(/:\s*Promise<void>/); // types stripped
    expect((await fetch(`${app.server.url}/ui/tokens.css`)).status).toBe(200);
    // G2 (R9.3): the shared string table is served next to the UI, types stripped, nothing outside it.
    const i18n = await fetch(`${app.server.url}/ui/i18n/index.ts`);
    expect(i18n.status).toBe(200);
    expect(await i18n.text()).toMatch(/export function t\s*\(/);
    expect((await fetch(`${app.server.url}/ui/i18n/zh/shell.ts`)).status).toBe(200);
    expect((await fetch(`${app.server.url}/ui/i18n/../../src/index.ts`)).status).toBe(404);
    expect((await fetch(`${app.server.url}/ui/../src/server.ts`)).status).toBe(404);
  });

  it("e2e: create thread, send, stream events, resolve an approval, get the answer", async () => {
    const app = await boot();
    const created = await app.api("POST", "/api/threads", { title: "測試" });
    expect(created.status).toBe(201);
    const threadId = created.body.id as string;

    let approved = false;
    const streamed = readEvents(
      app,
      (ev) => ev.some((e) => e.type === "run.finished"),
      (e) => {
        if (e.type === "approval.requested" && !approved) {
          approved = true;
          void app.api("POST", `/api/approvals/${e.data.approvalId}`, { decision: "approved" });
        }
      },
    );
    await new Promise((r) => setTimeout(r, 50)); // let the stream attach
    const sent = await app.api("POST", `/api/threads/${threadId}/messages`, { text: "幫我寫筆記" });
    expect(sent.status).toBe(202);
    const events = await streamed;

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("message.delta");
    expect(types).toContain("approval.requested");
    expect(types).toContain("approval.resolved");
    expect(types.at(-1)).toBe("run.finished");
    expect(checkSequence(events)).toMatchObject({ ok: true, openRuns: [] });

    const detail = await app.api("GET", `/api/threads/${threadId}`);
    expect(detail.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "幫我寫筆記",
      "好，我來寫。",
      "完成：已寫入「待辦」",
    ]);
    expect(detail.body.activeRunId).toBeNull();
    // A second answer to the same card changes nothing.
    const req = events.find((e) => e.type === "approval.requested")!;
    const again = await app.api("POST", `/api/approvals/${(req.data as { approvalId: string }).approvalId}`, {
      decision: "denied",
    });
    expect(again.body).toEqual({ resolved: false });
    const replay = await app.api("GET", `/api/runs/${sent.body.runId}/events`);
    expect(replay.body).toHaveLength(events.length);
  });

  it("rejects bad input, unknown ids, and a second turn on a busy thread", async () => {
    const app = await boot();
    const t = (await app.api("POST", "/api/threads", {})).body.id as string;
    expect((await app.api("POST", `/api/threads/${t}/messages`, { text: "  " })).status).toBe(400);
    expect((await app.api("POST", "/api/threads/thr_nope/messages", { text: "x" })).status).toBe(404);
    expect((await app.api("POST", "/api/approvals/apr_nope", { decision: "maybe" })).status).toBe(400);
    expect((await app.api("POST", "/api/approvals/apr_nope", { decision: "approved" })).status).toBe(404);
    expect((await app.api("POST", `/api/threads/${t}/messages`, { text: "幫我寫" })).status).toBe(202);
    expect((await app.api("POST", `/api/threads/${t}/messages`, { text: "再一次" })).status).toBe(409);
    expect((await app.api("POST", `/api/threads/${t}/interrupt`, {})).body).toEqual({ interrupted: true });
    const list = await app.api("GET", "/api/threads");
    expect(list.body[0]).toMatchObject({ id: t, busy: false });
  });
});
