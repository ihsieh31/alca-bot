// A bot on the Codex CLI (P9): the engine picker offers it, a bot picks it,
// and its router turn runs through `codex exec --json` (the fake CLI).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_CODEX_SCRIPT } from "@alca/engines";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

describe("desktop × a bot on the Codex CLI (fake CLI)", () => {
  let app: DesktopApp;
  let dir: string;
  const api = async (method: string, path: string, body?: unknown): Promise<Json> => {
    const res = await fetch(`${app.server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${app.token}`,
        ...app.uiHeaders,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return res.json();
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-desk-codex-"));
    app = await startDesktop({
      engine: "demo",
      dataDir: dir,
      port: 0,
      browser: "off",
      workdir: dir,
      codexCommand: [process.execPath, "--disable-warning=ExperimentalWarning", FAKE_CODEX_SCRIPT],
    });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("offers Codex CLI in the engine picker and runs a bot's turn on it", async () => {
    const team = await api("GET", "/api/team");
    expect(team.engines).toContainEqual(
      expect.objectContaining({ id: "codex", label: "Codex CLI", kind: "cli" }),
    );
    const bot = await api("POST", "/api/bots", { name: "程式手", engineId: "codex", model: "gpt-5-codex" });
    expect(bot.engineId).toBe("codex");
    const t = (await api("POST", "/api/threads", { botId: bot.id })).id as string;
    await api("POST", `/api/threads/${t}/messages`, { text: "看一下這個專案" });
    const start = Date.now();
    let said = "";
    while (Date.now() - start < 15_000) {
      const d = await api("GET", `/api/threads/${t}`);
      said = (d.messages as Json[])
        .filter((m) => m.role === "assistant")
        .map((m) => m.content)
        .join("\n");
      if (said.includes("Codex 收到")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(said).toContain("Codex 收到：看一下這個專案");
    const run = app.core.store.db
      .prepare(
        "SELECT engine, bot_id FROM runs WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(t) as { engine: string; bot_id: string };
    expect(run).toEqual({ engine: "codex", bot_id: bot.id });
    // P9 memory extraction is per bot and off (rules) by default.
    expect(bot.memoryExtract).toBe("rules");
    const set = await api("PATCH", `/api/bots/${bot.id}`, { memoryExtract: "model" });
    expect(set.memoryExtract).toBe("model");
    expect((await api("PATCH", `/api/bots/${bot.id}`, { memoryExtract: "always" })).error).toBeTruthy();
  });
});
