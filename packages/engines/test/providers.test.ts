import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acpCommand,
  detectProvider,
  findOnPath,
  listModels,
  MODEL_FAMILIES,
  PINNED_IDS,
  PROVIDERS,
  type ProviderDef,
  providerDef,
} from "../src/index.ts";
import { type MockLlm, startMockLlm } from "../testing/mock-llm.ts";

let mock: MockLlm | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

/** A directory of fake binaries (shell scripts) to put on PATH. */
function fakeBin(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-bin-"));
  for (const [name, body] of Object.entries(scripts)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}
const def = (id: string) => providerDef(id) as ProviderDef;
const noKey = { hasKey: () => false };

describe("provider catalog", () => {
  it("one built-in list per vendor family, shared by its CLI and API presets, and PROVIDERS.md lists the same ids", () => {
    const ids = (id: string) => PROVIDERS.find((p) => p.id === id)?.models.map((m) => m.id) ?? [];
    const fam = (f: keyof typeof MODEL_FAMILIES) => MODEL_FAMILIES[f].map((m) => m.id);
    expect(ids("claude-code")).toEqual([...fam("claudeAliases"), ...fam("claude")]);
    expect(ids("anthropic")).toEqual(fam("claude"));
    expect(ids("openai")).toEqual(fam("openai"));
    expect(ids("codex")).toEqual(fam("openai"));
    expect(ids("gemini")).toEqual(fam("gemini"));
    expect(ids("gemini-cli")).toEqual(fam("gemini"));
    const doc = readFileSync(new URL("../../../docs/PROVIDERS.md", import.meta.url), "utf8");
    const section = doc.slice(doc.indexOf("### Built-in models"), doc.indexOf("## Approval levels"));
    for (const [f, list] of Object.entries(MODEL_FAMILIES)) {
      const row = section.split("\n").find((l) => l.startsWith(`| ${f} `)) ?? "";
      expect(
        [...row.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((x): x is string => !!x && !x.includes(" ")),
        f,
      ).toEqual(list.map((m) => m.id));
    }
  });

  it("built-in model lists are current (mac test 2026-11-04: claude-opus-4-1 / claude-sonnet-4-5 in the bot editor)", () => {
    const ids = (id: string) => PROVIDERS.find((p) => p.id === id)?.models.map((m) => m.id) ?? [];
    expect(ids("claude-code").slice(0, 3)).toEqual(["sonnet", "opus", "haiku"]);
    expect(ids("claude-code")).toContain("claude-sonnet-5-5");
    expect(ids("anthropic")).toContain("claude-opus-5-5");
    expect(ids("codex")).toContain("gpt-6.1-sol");
    expect(ids("gemini")).toContain("gemini-3.8-flash");
    const all = PROVIDERS.flatMap((p) => p.models.map((m) => m.id)).join(" ");
    expect(all).not.toMatch(/claude-(?:opus-4-1|sonnet-4-5)|gpt-5-codex|gemini-2\.5-(?:pro|flash)\b/);
    for (const p of PROVIDERS)
      if (p.defaultModel && p.models.length)
        expect(
          p.models.map((m) => m.id),
          p.id,
        ).toContain(p.defaultModel);
  });

  it("has the v7 list, six pinned in order, unique ids, ACP presets with commands", () => {
    expect(PINNED_IDS).toEqual(["claude-code", "codex", "gemini-cli", "opencode", "openai", "openrouter"]);
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const acp = PROVIDERS.filter((p) => p.kind === "acp").map((p) => p.id);
    expect(acp.sort()).toEqual(
      [
        "antigravity",
        "cursor-cli",
        "factory-droid",
        "gemini-cli",
        "grok-cli",
        "kimi-cli",
        "opencode",
        "qwen-code",
      ].sort(),
    );
    for (const p of PROVIDERS.filter((x) => x.kind === "acp")) {
      expect(p.binary).toBeTruthy();
      expect(p.acpArgs?.length).toBeGreaterThan(0);
      // never a mode that skips the host's permission prompts
      expect(JSON.stringify(p.modes)).not.toMatch(/yolo|bypass/i);
    }
    for (const p of PROVIDERS.filter((x) => x.kind === "api")) expect(p.baseUrl).toMatch(/^https?:\/\//);
  });

  it("adds the model flag to ACP commands that take one", () => {
    expect(acpCommand(def("gemini-cli"), undefined, "gemini-2.5-pro")).toEqual([
      "gemini",
      "--experimental-acp",
      "-m",
      "gemini-2.5-pro",
    ]);
    expect(acpCommand(def("opencode"), undefined, "x")).toEqual(["opencode", "acp"]);
    expect(acpCommand(def("gemini-cli"), ["/opt/gemini", "--acp"])).toEqual(["/opt/gemini", "--acp"]);
  });
});

describe("detection with fake binaries", () => {
  it("not installed → install hint; installed → version", async () => {
    const env = { PATH: fakeBin({ gemini: 'echo "0.9.1"' }), HOME: tmpdir() };
    const missing = await detectProvider(def("opencode"), { ...noKey, env });
    expect(missing.status).toBe("not_installed");
    expect(missing.hint).toContain("npm install -g opencode-ai");
    expect(findOnPath("gemini", env)).toBeTruthy();
    // gemini's files check is definitive: no creds, no key env → needs login
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const out = await detectProvider(def("gemini-cli"), { ...noKey, env: { ...env, HOME: home }, home });
    expect(out).toMatchObject({ status: "needs_login", version: "0.9.1" });
    mkdirSync(join(home, ".gemini"));
    writeFileSync(join(home, ".gemini", "oauth_creds.json"), "{}");
    const ok = await detectProvider(def("gemini-cli"), { ...noKey, env, home });
    expect(ok).toMatchObject({ status: "ready", login: "yes" });
    const viaEnv = await detectProvider(def("gemini-cli"), {
      ...noKey,
      env: { ...env, GEMINI_API_KEY: "x" },
      home: mkdtempSync(join(tmpdir(), "home-")),
    });
    expect(viaEnv.status).toBe("ready");
  });

  it("a command login check: codex login status exit 0 / 1", async () => {
    const yes = {
      PATH: fakeBin({
        codex:
          'case "$1" in --version) echo "codex-cli 0.50.0";; login) echo "Logged in using ChatGPT";; esac',
      }),
    };
    const no = {
      PATH: fakeBin({
        codex: 'case "$1" in --version) echo "codex-cli 0.50.0";; login) echo "Not logged in"; exit 1;; esac',
      }),
    };
    expect(await detectProvider(def("codex"), { ...noKey, env: yes })).toMatchObject({
      status: "ready",
      login: "yes",
      version: "codex-cli 0.50.0",
    });
    const out = await detectProvider(def("codex"), { ...noKey, env: no });
    expect(out).toMatchObject({ status: "needs_login", login: "no" });
    expect(out.hint).toContain("codex login");
  });

  it("claude: no definitive check → ready with a hint (credentials may be in the keychain)", async () => {
    const env = { PATH: fakeBin({ claude: 'echo "2.0.1 (Claude Code)"' }) };
    const out = await detectProvider(def("claude-code"), {
      ...noKey,
      env,
      home: mkdtempSync(join(tmpdir(), "h-")),
    });
    expect(out).toMatchObject({ status: "ready", login: "unknown" });
    expect(out.hint).toContain("若要求登入");
  });

  it("API: needs a key unless local; a saved key → ready", async () => {
    expect((await detectProvider(def("openai"), noKey)).status).toBe("needs_key");
    expect((await detectProvider(def("openai"), { hasKey: (id) => id === "openai" })).status).toBe("ready");
    expect((await detectProvider(def("ollama"), noKey)).status).toBe("ready");
  });
});

describe("model lists", () => {
  it("live /models (OpenAI shape) with context and per-million price; key in Bearer", async () => {
    mock = await startMockLlm(() => ({}), { key: "sk-test-models" });
    const out = await listModels(def("openrouter"), { baseUrl: mock.openaiBase, apiKey: "sk-test-models" });
    expect(out.source).toBe("api");
    expect(out.models.find((m) => m.id === "mock/fast")).toEqual({
      id: "mock/fast",
      label: "Mock Fast",
      contextTokens: 131072,
      inputPrice: 0.5,
      outputPrice: 1.5,
    });
    // built-in context fills what the vendor list leaves out
    expect(out.models.find((m) => m.id === "openai/gpt-6-luna")?.contextTokens).toBe(1_050_000);
  });

  it("Anthropic and Gemini shapes", async () => {
    mock = await startMockLlm(() => ({}), { key: "sk-test-k" });
    const a = await listModels(def("anthropic"), { baseUrl: mock.baseUrl, apiKey: "sk-test-k" });
    expect(a.models.map((m) => m.id)).toEqual(["claude-mock-1", "claude-sonnet-4-5"]);
    expect(mock.requests.at(-1)?.headers["x-api-key"]).toBe("sk-test-k");
    const g = await listModels(def("gemini"), { baseUrl: mock.geminiBase, apiKey: "sk-test-k" });
    expect(g.models).toEqual([{ id: "gemini-mock", label: "Gemini Mock", contextTokens: 32768 }]);
  });

  it("falls back to the built-in list with a note; no key → built-in without calling", async () => {
    mock = await startMockLlm(() => ({}), { modelsStatus: 500 });
    const out = await listModels(def("mistral"), { baseUrl: mock.openaiBase, apiKey: "sk-test-x" });
    expect(out.source).toBe("builtin");
    expect(out.note).toContain("HTTP 500");
    expect(out.models.length).toBeGreaterThan(0);
    const before = mock.requests.length;
    const nk = await listModels(def("mistral"), { baseUrl: mock.openaiBase });
    expect(nk.source).toBe("builtin");
    expect(mock.requests.length).toBe(before);
  });

  it("CLI listing (opencode models), and its failure", async () => {
    const env = {
      PATH: fakeBin({ opencode: 'echo "anthropic/claude-sonnet-4-5"; echo "openai/gpt-5"; echo ""' }),
    };
    const bin = findOnPath("opencode", env) as string;
    const out = await listModels(def("opencode"), { command: [bin] });
    expect(out).toEqual({
      source: "cli",
      models: [{ id: "anthropic/claude-sonnet-4-5" }, { id: "openai/gpt-5" }],
    });
    const bad = fakeBin({ opencode: "exit 3" });
    const f = await listModels(def("opencode"), { command: [join(bad, "opencode")] });
    expect(f.source).toBe("builtin");
    expect(f.note).toContain("3");
  });
});
