export * from "./acp/engine.ts";
export * from "./acp/rpc.ts";
export * from "./acp/updates.ts";
export * from "./claude/args.ts";
export * from "./claude/bridge.ts";
export * from "./claude/engine.ts";
export * from "./claude/parse.ts";
export * from "./claude/process.ts";
export * from "./codex/app-server/engine.ts";
export * from "./codex/app-server/map.ts";
export * from "./codex/app-server/rpc.ts";
export * from "./codex/args.ts";
export * from "./codex/engine.ts";
export * from "./codex/home.ts";
export * from "./codex/parse.ts";
export * from "./env.ts";
export * from "./harness-matrix.ts";
export * from "./http/anthropic.ts";
export * from "./http/base.ts";
export * from "./http/common.ts";
export * from "./http/compact.ts";
export * from "./http/gemini.ts";
export * from "./http/openai.ts";
export * from "./http/responses.ts";
export * from "./idle.ts";
export * from "./providers/index.ts";
export * from "./scripted.ts";
export * from "./types.ts";

import { fileURLToPath } from "node:url";

/** Absolute path of the fake `claude` CLI used by tests and the offline demo. */
export const FAKE_CLAUDE_SCRIPT = fileURLToPath(new URL("../testing/fake-claude.ts", import.meta.url));

/** Absolute path of the fake `codex` CLI used by tests. */
export const FAKE_CODEX_SCRIPT = fileURLToPath(new URL("../testing/fake-codex.ts", import.meta.url));

/** Absolute path of the fake `codex app-server` used by tests (plan §3.3). */
export const FAKE_CODEX_APP_SERVER_SCRIPT = fileURLToPath(
  new URL("../testing/fake-codex-app-server.ts", import.meta.url),
);

/** Absolute path of the fake ACP agent used by tests. */
export const FAKE_ACP_SCRIPT = fileURLToPath(new URL("../testing/fake-acp.ts", import.meta.url));
