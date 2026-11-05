import type { ToolActionClass } from "./index.ts";
import type { ToolInspection } from "./registry.ts";

/**
 * Host contracts (P13): what a package that plugs tools or event sources into
 * the core implements. They live here, below the core, so such packages
 * (connected apps, browser, hands) never depend on `@alca/core`; the core
 * re-exports them.
 */

/** A tool's name, description and JSON Schema, as an engine sees it. */
export interface HostToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool the host runs itself, always behind the policy gateway. */
export interface HostTool {
  spec: HostToolSpec;
  actionClass: ToolActionClass;
  /**
   * Next round R1: built by the host itself (not brought in by a connector or
   * an MCP server). A name the general harness reserves (`web_search`) is
   * offered only from a host-owned tool, so an outside tool cannot pose as it.
   */
  hostOwned?: boolean;
  /**
   * Optional pre-flight look at live state before the gateway decides (e.g.
   * the browser button a click would press). It can only escalate the class.
   */
  inspect?(
    args: Record<string, unknown>,
    ctx: { signal: AbortSignal; threadId: string; botId: string; workerId?: string },
  ): Promise<ToolInspection>;
  run(
    args: Record<string, unknown>,
    signal: AbortSignal,
    ctx?: { actionClass: ToolActionClass; threadId: string; runId: string; botId: string; workerId?: string },
  ): Promise<string>;
}

/** Stage-1 rule of a trigger: plain code, no model. */
export interface TriggerRule {
  mode?: "explicit" | "candidate" | "ignore";
  allow?: string[];
  block?: string[];
  keywords?: string[];
  /** Text that marks an explicit request; default ["@alca", "/alca"]. */
  explicitMarkers?: string[];
}

/** One environment event a source hands the trigger hub. */
export interface TriggerEventInput {
  text: string;
  from?: string;
  /** Same mail thread / PR / chat topic = same stream key. */
  streamKey?: string;
  streamTitle?: string;
  /** The source already knows this is addressed to the bot (a DM, a mention). */
  explicit?: boolean;
}

/** The trigger row a source is told about (the store's `TriggerRecord` has these and more). */
export interface TriggerRef {
  id: string;
  source: string;
  config: Record<string, unknown>;
}

/** A pluggable event source. */
export interface TriggerSourceDriver {
  readonly kind: "timer" | "manual" | "im" | "email" | "github" | "webhook";
  /** Called when a trigger of this kind is created (e.g. a timer registers its schedule). */
  register?(t: TriggerRef): void;
  /** Called by the hub's clock; fire due events through `fire`. */
  tick?(now: Date, fire: (triggerId: string, ev: TriggerEventInput) => Promise<unknown>): Promise<void>;
}
