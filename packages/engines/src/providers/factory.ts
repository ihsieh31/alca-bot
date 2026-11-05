import { AcpEngine } from "../acp/engine.ts";
import type { SessionMemory } from "../claude/engine.ts";
import { HARNESS_MATRIX } from "../harness-matrix.ts";
import { AnthropicEngine } from "../http/anthropic.ts";
import type { HistoryStore, KeyLookup } from "../http/common.ts";
import { GeminiEngine } from "../http/gemini.ts";
import { OpenAICompatEngine } from "../http/openai.ts";
import { OpenAIResponsesEngine } from "../http/responses.ts";
import type { Engine } from "../types.ts";
import type { ApiFamily, ProviderDef } from "./catalog.ts";

/**
 * Build the engine for a provider (P11) from its catalog entry and the
 * person's overrides. API providers reuse the OpenAI-compatible engine where
 * the vendor speaks that format; OpenAI itself defaults to Responses (Chat
 * when `family` says so), Anthropic and Gemini have their own engines. ACP
 * agents get the generic ACP engine with the preset's command and modes.
 */

export interface ApiEngineInput {
  /** Engine id (the provider id, or a custom provider's id). */
  id: string;
  model: string;
  baseUrl?: string;
  family?: ApiFamily;
  apiKey?: KeyLookup;
  history?: HistoryStore;
  reasoningEffort?: string;
  fetch?: typeof fetch;
}

export function createApiEngine(def: ProviderDef, i: ApiEngineInput): Engine {
  const baseUrl = i.baseUrl ?? def.baseUrl ?? "";
  const common = {
    id: i.id,
    model: i.model,
    ...(i.apiKey ? { apiKey: i.apiKey } : {}),
    ...(i.history ? { history: i.history } : {}),
    ...(i.fetch ? { fetch: i.fetch } : {}),
    ...(i.reasoningEffort && def.caps.reasoning ? { reasoningEffort: i.reasoningEffort } : {}),
  };
  const family = i.family ?? def.family ?? "openai-chat";
  if (family === "anthropic") return new AnthropicEngine({ ...common, baseUrl });
  if (family === "gemini") {
    const { reasoningEffort: _r, ...g } = common;
    return new GeminiEngine({ ...g, baseUrl });
  }
  if (family === "openai-responses")
    return new OpenAIResponsesEngine({
      ...common,
      baseUrl,
      ...(def.headers ? { headers: { ...def.headers } } : {}),
    });
  return new OpenAICompatEngine({
    ...common,
    baseUrl,
    ...(def.headers ? { headers: { ...def.headers } } : {}),
  });
}

export interface AcpEngineInput {
  id: string;
  /** Binary + args (the preset's, or the person's own). */
  command?: readonly string[];
  model?: string;
  cwd: string;
  sessions: SessionMemory;
  /** Approval level of the bot (confirm_each_step | default | autonomous). */
  approvalMode: string;
  /** The vault key, given to the agent as this env var. */
  keyEnv?: string;
  apiKey?: KeyLookup;
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * The worker harness this instance serves (plan §3.4): `general` refuses the
   * native edit / execute kinds and makes the mode switch strict; `coding`
   * always runs in the asking mode (never auto-edit) and stops on a native
   * call that ran unasked. Unset: the bot's level decides the mode.
   */
  harness?: "coding" | "general";
}

/** P15 E: ACP tool kinds a general worker never runs natively. */
export const GENERAL_DENIED_ACP_KINDS: readonly string[] = Object.freeze([
  "execute",
  "edit",
  "delete",
  "move",
]);

/** The command an ACP preset starts with, the model flag added when the agent takes one. */
export function acpCommand(
  def: ProviderDef,
  command: readonly string[] | undefined,
  model?: string,
): string[] {
  const base = command?.length ? [...command] : [def.binary ?? "", ...(def.acpArgs ?? [])];
  if (model && def.modelArg && !base.includes(def.modelArg)) base.push(def.modelArg, model);
  return base;
}

export function createAcpEngine(def: ProviderDef, i: AcpEngineInput): AcpEngine {
  const keyEnv = i.keyEnv;
  const apiKey = i.apiKey;
  return new AcpEngine({
    id: i.id,
    label: def.label,
    command: acpCommand(def, i.command, i.model),
    launch: () => ({
      engineId: i.id,
      cwd: i.cwd,
      stablePrompt: "",
      env: {},
      approvalMode: i.approvalMode,
      ...(i.model ? { model: i.model } : {}),
    }),
    sessions: i.sessions,
    ...(def.modes ? { modes: def.modes } : {}),
    ...(def.loginHint ? { loginHint: def.loginHint } : {}),
    ...(def.stateDirs ? { stateDirs: def.stateDirs } : {}),
    ...(i.harness === "general"
      ? { denyKinds: GENERAL_DENIED_ACP_KINDS, strictMode: true, harness: HARNESS_MATRIX.acpGeneral }
      : i.harness === "coding"
        ? { askingMode: true, harness: HARNESS_MATRIX.acpCoding }
        : { harness: HARNESS_MATRIX.acpAtLevel }),
    ...(def.modelArg ? { setModel: false } : {}),
    ...(i.baseEnv ? { baseEnv: i.baseEnv } : {}),
    ...(keyEnv ? { envAllow: [keyEnv] } : {}),
    ...(keyEnv && apiKey
      ? {
          secretEnv: async (): Promise<Record<string, string>> => {
            const k = await apiKey();
            return k ? { [keyEnv]: k } : {};
          },
        }
      : {}),
  });
}
