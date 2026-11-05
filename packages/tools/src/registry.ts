import type { ToolActionClass, ToolDefinition } from "./index.ts";

/** What the host knows when it runs a call that the gateway already cleared. */
export interface ToolCallContext {
  signal: AbortSignal;
  /** The class the gateway authorized (after any escalation). Tools re-check against it. */
  actionClass: ToolActionClass;
  threadId?: string;
  runId?: string;
  /** The bot making the call. Browser tools only touch Spaces this bot owns. */
  botId?: string;
  /** Reserved (plan v4): the bot's worker session; recorded on Spaces it opens. */
  workerId?: string;
}

/**
 * A pre-flight look at a call, made before the gateway decides. Tools whose
 * risk depends on live state (a browser button labelled 「確認付款」) report it
 * here. It may only escalate the declared class; the gateway never lowers it.
 */
export interface ToolInspection {
  actionClass?: ToolActionClass;
  /** One line for the approval card, in the user's language. */
  summary?: string;
  /** Path or URL the call touches (rule targets, audit). */
  target?: string;
}

export interface RegisteredTool extends ToolDefinition {
  inspect?(
    args: Record<string, unknown>,
    ctx: { signal: AbortSignal; threadId?: string; botId?: string; workerId?: string },
  ): Promise<ToolInspection>;
  run(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string>;
}

export class DuplicateToolError extends Error {
  constructor(name: string) {
    super(`tool ${name} is already registered`);
    this.name = "DuplicateToolError";
  }
}

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

function terms(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // CJK has no spaces: also index every bigram of Han runs.
  const han = lower.match(/\p{Script=Han}+/gu) ?? [];
  const grams = han.flatMap((run) =>
    run.length < 2 ? [run] : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)),
  );
  return [...words, ...lower.split("_"), ...grams].filter(Boolean);
}

/**
 * In-process tool registry with progressive disclosure: `search` returns one
 * line per tool, `describe` returns the full schema, `get` hands the host the
 * runnable tool. Calls are never run from here directly: the core runs them
 * through the action gateway.
 */
export class ToolRegistryImpl {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): this {
    if (!NAME_RE.test(tool.name)) throw new Error(`invalid tool name ${tool.name}`);
    if (this.tools.has(tool.name)) throw new DuplicateToolError(tool.name);
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: readonly RegisteredTool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Rank tools by how many query terms hit their name or summary. Empty query lists all. */
  async search(query: string, limit = 8): Promise<Pick<ToolDefinition, "name" | "summary">[]> {
    const q = terms(query);
    const scored = this.list().map((t) => {
      const hay = new Set(terms(`${t.name} ${t.summary}`));
      const name = t.name.toLowerCase();
      let score = 0;
      for (const w of q) {
        if (hay.has(w)) score += 2;
        else if (w.length > 1 && (name.includes(w) || t.summary.toLowerCase().includes(w))) score += 1;
      }
      return { t, score };
    });
    return scored
      .filter((s) => q.length === 0 || s.score > 0)
      .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
      .slice(0, limit)
      .map(({ t }) => ({ name: t.name, summary: t.summary }));
  }

  async describe(name: string): Promise<ToolDefinition | undefined> {
    const t = this.tools.get(name);
    if (!t) return undefined;
    return {
      name: t.name,
      summary: t.summary,
      inputSchema: t.inputSchema,
      actionClass: t.actionClass,
      source: t.source,
    };
  }
}
