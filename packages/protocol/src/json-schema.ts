import { z } from "zod";
import { AgentsEventSchema } from "./agents.ts";
import { BrowserEventSchema, SpaceFrame } from "./browser.ts";
import { AlcaEventSchema, PROTOCOL_VERSION } from "./events.ts";
import { LearningEventSchema } from "./learning.ts";

export const SCHEMA_ID = `https://alca.invalid/spec/alca-event-protocol.v${PROTOCOL_VERSION}.schema.json`;

/** JSON Schema (draft 2020-12) for the whole event union, for non-TS adapters. */
export function buildJsonSchema(): Record<string, unknown> {
  const body = z.toJSONSchema(AlcaEventSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
  const { $schema, ...rest } = body;
  return {
    $schema,
    $id: SCHEMA_ID,
    title: `Alca Event Protocol v${PROTOCOL_VERSION}`,
    description: "Generated from packages/protocol/src/events.ts. Do not edit by hand; run `pnpm spec:gen`.",
    ...rest,
  };
}

export function renderJsonSchema(): string {
  return `${JSON.stringify(buildJsonSchema(), null, 2)}\n`;
}

export const BROWSER_SCHEMA_ID = `https://alca.invalid/spec/alca-browser-channel.v${PROTOCOL_VERSION}.schema.json`;

/** JSON Schema for the host-scoped Alca Browser channel (events + screencast frame). */
export function buildBrowserJsonSchema(): Record<string, unknown> {
  const body = z.toJSONSchema(z.union([BrowserEventSchema, SpaceFrame]), {
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  const { $schema, ...rest } = body;
  return {
    $schema,
    $id: BROWSER_SCHEMA_ID,
    title: `Alca Browser channel v${PROTOCOL_VERSION}`,
    description: "Generated from packages/protocol/src/browser.ts. Do not edit by hand; run `pnpm spec:gen`.",
    ...rest,
  };
}

export function renderBrowserJsonSchema(): string {
  return `${JSON.stringify(buildBrowserJsonSchema(), null, 2)}\n`;
}

export const AGENTS_SCHEMA_ID = `https://alca.invalid/spec/alca-agents-channel.v${PROTOCOL_VERSION}.schema.json`;

/** JSON Schema for the host-scoped agents channel (workers, triggers, watchdog). */
export function buildAgentsJsonSchema(): Record<string, unknown> {
  const body = z.toJSONSchema(AgentsEventSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
  const { $schema, ...rest } = body;
  return {
    $schema,
    $id: AGENTS_SCHEMA_ID,
    title: `Alca agents channel v${PROTOCOL_VERSION}`,
    description: "Generated from packages/protocol/src/agents.ts. Do not edit by hand; run `pnpm spec:gen`.",
    ...rest,
  };
}

export function renderAgentsJsonSchema(): string {
  return `${JSON.stringify(buildAgentsJsonSchema(), null, 2)}\n`;
}

export const LEARNING_SCHEMA_ID = `https://alca.invalid/spec/alca-learning-channel.v${PROTOCOL_VERSION}.schema.json`;

/** JSON Schema for the host-scoped learning channel (memory changes, skill proposals). */
export function buildLearningJsonSchema(): Record<string, unknown> {
  const body = z.toJSONSchema(LearningEventSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
  const { $schema, ...rest } = body;
  return {
    $schema,
    $id: LEARNING_SCHEMA_ID,
    title: `Alca learning channel v${PROTOCOL_VERSION}`,
    description:
      "Generated from packages/protocol/src/learning.ts. Do not edit by hand; run `pnpm spec:gen`.",
    ...rest,
  };
}

export function renderLearningJsonSchema(): string {
  return `${JSON.stringify(buildLearningJsonSchema(), null, 2)}\n`;
}
