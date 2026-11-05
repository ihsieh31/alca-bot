import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionLevelT } from "@alca/config";
import { FileKeySource, Vault } from "@alca/connectors";
import { checkHarnessFit, type Engine, HARNESS_MATRIX, ScriptedEngine } from "@alca/engines";
import { openStore } from "@alca/store";
import { afterAll, describe, expect, it } from "vitest";
import { type EnginePair, EngineSet } from "../src/engines.ts";
import { ProviderService } from "../src/providers.ts";

const dir = mkdtempSync(join(tmpdir(), "alca-engineset-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const modeOf = (e: unknown): string =>
  (e as { o: { launch: () => { approvalMode: string } } }).o.launch().approvalMode;

/** P13: an ACP / API bot's router is its own instance; an ACP router always asks; levels resolve through the team. */
describe("EngineSet × ACP / API bots", () => {
  const store = openStore(":memory:");
  const vault = new Vault(join(dir, "vault.json"), new FileKeySource(join(dir, "vault.key")));
  const providers = new ProviderService({ store, vault });
  let team: PermissionLevelT = "autonomous";
  const set = new EngineSet({ store, providers, defaultLabel: "x", teamLevel: () => team, cwd: dir });

  it("router ≠ worker; the ACP router runs in the asking mode whatever the bot's level", () => {
    const bot = store.bots.create("gem", { engineId: "gemini-cli" });
    const e = set.forBot(bot.id);
    expect(e).toBeDefined();
    expect(e?.router).not.toBe(e?.worker);
    expect(modeOf(e?.router)).toBe("confirm_each_step");
    // follows the team (autonomous)
    expect(modeOf(e?.worker)).toBe("autonomous");
    team = "confirm_each_step";
    const again = set.forBot(bot.id);
    expect(modeOf(again?.worker)).toBe("confirm_each_step");
    store.bots.update(bot.id, { approvalLevel: "autonomous" });
    expect(modeOf(set.forBot(bot.id)?.worker)).toBe("autonomous");
    expect(modeOf(set.forBot(bot.id)?.router)).toBe("confirm_each_step");
  });

  it("an API bot also gets two instances (separate conversations, no shared native tools)", () => {
    const bot = store.bots.create("or", { engineId: "openrouter", model: "openai/gpt-4o-mini" });
    const e = set.forBot(bot.id);
    expect(e?.router).not.toBe(e?.worker);
    expect(e?.router.capabilities.ownsToolLoop).toBe(false);
  });
});

/** Plan §3.2 (P15 A4): the worker engine for one harness. */
describe("EngineSet.forHarness", () => {
  const store = openStore(":memory:");
  const vault = new Vault(join(dir, "vault-h.json"), new FileKeySource(join(dir, "vault-h.key")));
  const providers = new ProviderService({ store, vault });
  const pair = (tag: string): EnginePair => ({
    router: new ScriptedEngine([], { id: `${tag}-router` }),
    worker: new ScriptedEngine([], { id: `${tag}-worker` }),
    coding: new ScriptedEngine([], { id: `${tag}-coding` }),
    general: new ScriptedEngine([], { id: `${tag}-general` }),
  });
  const codexMade: Array<string | undefined> = [];
  const set = new EngineSet({
    store,
    providers,
    defaultLabel: "x",
    teamLevel: () => "autonomous",
    cwd: dir,
    withModel: (m) => pair(`default:${m}`),
    codex: (m) => {
      codexMade.push(m);
      return pair(`codex:${m ?? ""}`);
    },
  });

  it("an ACP bot: a coding instance in the asking mode and a general one that refuses native writes", () => {
    const bot = store.bots.create("gem-h", { engineId: "gemini-cli" });
    const coding = set.forHarness(bot.id, "coding");
    const general = set.forHarness(bot.id, "general");
    const worker = set.forBot(bot.id)?.worker;
    expect(coding).toBeDefined();
    expect(new Set([coding, general, worker]).size).toBe(3);
    expect(coding?.capabilities.harness).toBe(HARNESS_MATRIX.acpCoding);
    expect(general?.capabilities.harness).toBe(HARNESS_MATRIX.acpGeneral);
    expect(checkHarnessFit(coding as Engine, "coding")).toEqual({ ok: true });
    expect(checkHarnessFit(general as Engine, "general")).toEqual({ ok: true });
    // The plain worker at the bot's level may auto-edit: it could not take coding work.
    expect(checkHarnessFit(worker as Engine, "coding")).toMatchObject({ ok: false });
    // One instance per harness (a stable launch): asked again, the same one.
    expect(set.forHarness(bot.id, "coding")).toBe(coding);
  });

  it("a bot's own engine for one harness wins; the other harness keeps the bot's engine", () => {
    const bot = store.bots.create("mix", {
      engineId: "gemini-cli",
      harness: JSON.stringify({ coding: { engineId: "openrouter", model: "openai/gpt-4o-mini" } }),
    });
    const coding = set.forHarness(bot.id, "coding");
    expect(coding?.capabilities.ownsToolLoop).toBe(false); // the API engine: Alca's own loop
    expect(checkHarnessFit(coding as Engine, "coding")).toEqual({ ok: true });
    expect(set.forHarness(bot.id, "general")?.capabilities.harness).toBe(HARNESS_MATRIX.acpGeneral);
  });

  it("an API bot without per-harness instances: its worker", () => {
    const bot = store.bots.create("api-h", { engineId: "openrouter", model: "openai/gpt-4o-mini" });
    expect(set.forHarness(bot.id, "coding")).toBe(set.forBot(bot.id)?.worker);
  });

  it("Codex and the default engine with a model: that pair's harness instance", () => {
    const cx = store.bots.create("cx-h", { engineId: "codex", model: "gpt-5" });
    expect(set.forHarness(cx.id, "coding")?.id).toBe("codex:gpt-5-coding");
    expect(set.forHarness(cx.id, "general")?.id).toBe("codex:gpt-5-general");
    expect(codexMade).toContain("gpt-5");
    const dm = store.bots.create("dm-h", { engineId: null, model: "haiku" });
    expect(set.forHarness(dm.id, "coding")?.id).toBe("default:haiku-coding");
    // A model only for coding on the default engine: the general one stays the team default.
    const only = store.bots.create("only-h", {
      engineId: null,
      harness: JSON.stringify({ coding: { model: "haiku" } }),
    });
    expect(set.forHarness(only.id, "coding")?.id).toBe("default:haiku-coding");
    expect(set.forHarness(only.id, "general")).toBeUndefined();
  });

  it("no such bot, or a bot on the team default: undefined (the supervisor's default per harness)", () => {
    expect(set.forHarness("bot_missing", "coding")).toBeUndefined();
    const plain = store.bots.create("plain-h", { engineId: null });
    expect(set.forHarness(plain.id, "coding")).toBeUndefined();
  });
});
