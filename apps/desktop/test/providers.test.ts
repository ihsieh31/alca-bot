// Desktop × 模型與供應商 (P11) with the demo engines: the registry with status
// and fixes, a key into the vault that never comes back out (API answers,
// the team view, the log), the live model list through the saved key, a bot
// on OpenAI (Responses) answering through a mock, custom provider CRUD, and a
// custom ACP agent (the fake one) running a bot's turn.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_ACP_SCRIPT } from "@alca/engines";
import { type MockLlm, startMockLlm } from "@alca/engines/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

const KEY = "sk-test-desktop-providers-0001";

describe("desktop × 模型與供應商", () => {
  let app: DesktopApp;
  let dir: string;
  let llm: MockLlm;
  const logs: string[] = [];
  const api = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json; raw: string }> => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${app.token}`,
        ...app.uiHeaders,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await res.text();
    let parsed: Json = null;
    try {
      parsed = JSON.parse(raw);
    } catch {}
    return { status: res.status, body: parsed, raw };
  };
  const until = async <T>(
    fn: () => T | undefined | false | Promise<T | undefined | false>,
    ms = 15_000,
  ): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const said = async (t: string) =>
    (
      (await api("GET", `/api/threads/${t}`)).body.messages as Array<{ role: string; content: string }>
    ).filter((m) => m.role === "assistant");

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-desk-prov-"));
    llm = await startMockLlm(() => ({ text: "我在 OpenAI Responses 上。" }), { key: KEY });
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const k of ["log", "warn", "error"] as const)
      console[k] = (...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
        orig[k](...a);
      };
    app = await startDesktop({ engine: "demo", dataDir: dir, port: 0, browser: "off" });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    await llm?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists every provider with a status and a one-line fix; six pinned", async () => {
    const list = (await api("GET", "/api/providers")).body.providers as Json[];
    expect(list.filter((p) => p.pinned).map((p) => p.id)).toEqual([
      "claude-code",
      "codex",
      "gemini-cli",
      "opencode",
      "openai",
      "openrouter",
    ]);
    expect(list.length).toBeGreaterThanOrEqual(22);
    const openai = list.find((p) => p.id === "openai");
    expect(openai).toMatchObject({
      kind: "api",
      status: "needs_key",
      hasKey: false,
      family: "openai-responses",
    });
    expect(openai.hint).toContain("API key");
    expect(list.find((p) => p.id === "ollama")).toMatchObject({ status: "ready", keyRequired: false });
    for (const p of list) expect(["ready", "needs_login", "needs_key", "not_installed"]).toContain(p.status);
    // the bot editor's engine list comes from the same registry
    const engines = (await api("GET", "/api/team")).body.engines as Json[];
    expect(engines.map((e) => e.id)).toEqual(
      expect.arrayContaining(["default", "claude-code", "gemini-cli", "openai", "xai"]),
    );
    expect(engines.find((e) => e.id === "openai")).toMatchObject({ needsKey: true, pinned: true });
  });

  it("a key goes to the vault and never comes back: not in answers, the team view, the store or the log", async () => {
    expect((await api("PUT", "/api/providers/openai/key", { key: "has space" })).status).toBe(400);
    const set = await api("PUT", "/api/providers/openai/key", { key: KEY });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ hasKey: true, status: "ready" });
    expect(set.raw).not.toContain(KEY);
    expect((await api("GET", "/api/providers")).raw).not.toContain(KEY);
    expect((await api("GET", "/api/team")).raw).not.toContain(KEY);
    expect(await app.team.providers?.apiKey("openai")).toBe(KEY);
    // nowhere in the data dir in the clear (the vault file is encrypted)
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(dir);
    for (const f of files) expect(readFileSync(f).includes(Buffer.from(KEY)), f).toBe(false);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("a keyless service on the LAN may use http; a key never goes over http to another machine", async () => {
    const lan = await api("POST", "/api/providers", {
      kind: "openai",
      label: "客廳的 Ollama",
      baseUrl: "http://192.168.1.20:11434/v1",
      models: ["llama3.1"],
    });
    expect(lan.status).toBe(201);
    expect(
      (await api("PUT", `/api/providers/${lan.body.id}/key`, { key: "sk-lan-key-1234567" })).status,
    ).toBe(400);
    for (const baseUrl of ["http://192.168.1.20:11434/v1", "http://10.0.0.5/v1", "http://example.com/v1"])
      expect(
        (
          await api("POST", "/api/providers", {
            kind: "openai",
            label: "x",
            baseUrl,
            models: ["m"],
            key: "sk-1234567890",
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await api("POST", "/api/providers", {
          kind: "openai",
          label: "x",
          baseUrl: "http://8.8.8.8/v1",
          models: ["m"],
        })
      ).status,
    ).toBe(400);
    expect((await api("DELETE", `/api/providers/${lan.body.id}`)).status).toBe(200);
  });

  it("settings: base URL, wire and default model; the model list is fetched live with the saved key", async () => {
    expect((await api("PATCH", "/api/providers/openai", { baseUrl: "http://example.com/v1" })).status).toBe(
      400,
    );
    expect((await api("PATCH", "/api/providers/openai", { family: "anthropic" })).status).toBe(400);
    const v = await api("PATCH", "/api/providers/openai", {
      baseUrl: llm.openaiBase,
      defaultModel: "gpt-4o-mini",
    });
    expect(v.body).toMatchObject({ baseUrl: llm.openaiBase, defaultModel: "gpt-4o-mini" });
    const models = (await api("GET", "/api/providers/openai/models?refresh=1")).body;
    expect(models.source).toBe("api");
    expect(models.models.map((m: Json) => m.id)).toContain("mock/fast");
    expect(llm.requests.at(-1)?.headers.authorization).toBe(`Bearer ${KEY}`);
    // a provider without a key falls back to the built-in list
    const x = (await api("GET", "/api/providers/xai/models")).body;
    expect(x).toMatchObject({ source: "builtin" });
    expect(x.models.length).toBeGreaterThan(0);
  });

  it("a bot on OpenAI (Responses) answers through it, as its own engine", async () => {
    const b = (await api("POST", "/api/bots", { name: "寫手", engineId: "openai", model: "gpt-4o-mini" }))
      .body;
    expect(b).toMatchObject({ engineId: "openai", model: "gpt-4o-mini" });
    const t = (await api("POST", "/api/threads", { botId: b.id })).body.id as string;
    await api("POST", `/api/threads/${t}/messages`, { text: "你在哪？" });
    await until(async () => (await said(t)).some((m) => m.content.includes("OpenAI Responses")));
    const sent = llm.requests.filter((r) => r.api === "responses").at(-1);
    expect(sent?.body).toMatchObject({ model: "gpt-4o-mini", store: false });
    expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`);
    const run = app.core.store.db
      .prepare("SELECT engine FROM runs WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(t) as { engine: string };
    expect(run.engine).toBe("openai");
    // an unknown provider id is refused
    expect((await api("PATCH", `/api/bots/${b.id}`, { engineId: "nope" })).status).toBe(400);
  });

  it("custom providers: OpenAI-compatible and ACP; CRUD; a custom ACP agent runs a bot's turn", async () => {
    expect(
      (await api("POST", "/api/providers", { kind: "openai", label: "x", baseUrl: llm.openaiBase })).status,
    ).toBe(400);
    expect((await api("POST", "/api/providers", { kind: "acp", label: "x" })).status).toBe(400);
    expect((await api("POST", "/api/providers", { kind: "bogus", label: "x" })).status).toBe(400);
    const oa = await api("POST", "/api/providers", {
      kind: "openai",
      label: "我的伺服器",
      baseUrl: llm.openaiBase,
      models: "local-a, local-b",
      key: "sk-test-custom-key-0002",
    });
    expect(oa.status).toBe(201);
    expect(oa.body).toMatchObject({ custom: true, kind: "api", hasKey: true, defaultModel: "local-a" });
    expect(oa.raw).not.toContain("sk-test-custom-key-0002");
    const agent = await api("POST", "/api/providers", {
      kind: "acp",
      label: "我的代理",
      command: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_ACP_SCRIPT],
    });
    expect(agent.status).toBe(201);
    expect(agent.body).toMatchObject({ custom: true, kind: "acp", status: "ready" });
    const list = (await api("GET", "/api/providers")).body.providers as Json[];
    expect(list.filter((p) => p.custom).map((p) => p.label)).toEqual(["我的伺服器", "我的代理"]);

    const b = (await api("POST", "/api/bots", { name: "代理人", engineId: agent.body.id })).body;
    const t = (await api("POST", "/api/threads", { botId: b.id })).body.id as string;
    await api("POST", `/api/threads/${t}/messages`, { text: "哈囉代理" });
    await until(async () => (await said(t)).some((m) => m.content.includes("echo:")));

    expect((await api("DELETE", `/api/providers/${oa.body.id}`)).body).toEqual({ removed: true });
    expect(await app.team.providers?.apiKey(oa.body.id)).toBeUndefined();
    expect((await api("DELETE", `/api/providers/${agent.body.id}`)).status).toBe(200);
    expect((await api("GET", `/api/bots`)).body.find((x: Json) => x.id === b.id).engineId).toBeNull();
    expect((await api("DELETE", "/api/providers/openai")).status).toBe(404);
  });
});
