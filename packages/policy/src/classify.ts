import { isAlwaysConfirm } from "@alca/config";
import { devCommand } from "./dev-commands.ts";
import type { ActionClass } from "./rules.ts";
import { classifyShell } from "./shell.ts";
import { FULL_ACCESS_KNOWN, shellNeedsPerson } from "./shell-safe.ts";
import { isShellToolName, namedShellCommand } from "./shell-tools.ts";

/**
 * Best-effort classification of engine tool calls into action classes.
 *
 * This only ever ESCALATES: it is a floor that catches obvious sends,
 * publishes, payments and deletes inside shell commands, not a guarantee.
 * The authoritative gates (always-confirm classes, deny rules) do not depend
 * on these patterns being complete.
 */
const BASE: Readonly<Record<string, ActionClass>> = {
  Read: "read",
  Glob: "read",
  Grep: "read",
  LS: "read",
  NotebookRead: "read",
  TodoWrite: "read",
  // Claude Code ≥ 2.1 defers MCP tool schemas; ToolSearch only loads them (no side effects).
  ToolSearch: "read",
  Edit: "write",
  MultiEdit: "write",
  Write: "write",
  NotebookEdit: "write",
  Bash: "execute",
  BashOutput: "read",
  KillShell: "execute",
  WebFetch: "network",
  WebSearch: "network",
  Task: "execute",
  Agent: "execute",
};

const SHELL_PATTERNS: ReadonlyArray<[ActionClass, RegExp]> = [
  ["payment", /\bstripe\b.*\b(charges?|payments?|payouts?)\b/i],
  ["send", /\b(sendmail|mailx?|mutt|msmtp)\b/],
  ["send", /\bcurl\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s--data\b|\s-d\s|\s-F\s|--form\b)/i],
  ["send", /\bgh\s+(issue|pr)\s+comment\b/],
  ["publish", /\bgit\b(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-[a-zA-Z]))*\s+push\b/],
  ["publish", /\b(npm|pnpm|yarn)\s+publish\b/],
  ["publish", /\bgh\s+(release\s+create|pr\s+create|issue\s+create)\b/],
  ["publish", /\bdocker\s+push\b/],
  ["publish", /\b(wrangler\s+deploy|vercel\b.*--prod|firebase\s+deploy)\b/],
  ["delete", /(^|[\s;&|(])(?:\S*\/)?(rm|rmdir|shred|unlink)\s/],
  ["delete", /\bgit\s+(clean|reset\s+--hard|branch\s+-D)\b/],
  ["delete", /\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i],
  ["delete", /\bfind\b.*\s-delete\b/],
];

const NAME_PATTERNS: ReadonlyArray<[ActionClass, RegExp]> = [
  ["payment", /(pay|charge|checkout|purchase|order)/i],
  ["send", /(send|email|mail|message|reply|sms|dm)/i],
  ["publish", /(publish|post|tweet|deploy|release)/i],
  ["delete", /(delete|remove|trash|destroy|purge)/i],
];

/**
 * Third-party MCP tools (review 2026-11-04b H2): fail closed. A tool from a
 * server that is not Alca's own is `send` (always asks) unless its name
 * starts with a verb that only looks; an always-confirm verb anywhere in the
 * name gives that class. `mcp__github__push_files` is publish,
 * `mcp__stripe__create_refund` payment, `mcp__fs__write_file` send,
 * `mcp__github__get_file_contents` network.
 */
// biome-ignore format: a word list reads better packed
const READ_VERBS = new Set([
  "get", "list", "search", "read", "fetch", "query", "describe", "find", "lookup", "show", "view", "count",
  "check", "status", "info", "browse", "inspect", "preview", "download", "export", "resolve", "whoami",
]);
const VERB_CLASSES: ReadonlyArray<[ActionClass, RegExp, RegExp]> = [
  // [class, as the first word (verb or noun), elsewhere (verbs only)]
  [
    "payment",
    /^(pay|charge|checkout|purchase|order|buy|transfer|refund|payout|withdraw|subscribe|tip|donate)s?$/,
    /^(pay|charge|checkout|purchase|buy|transfer|refund|payout|withdraw|subscribe|refunds?|transfers?|payments?|charges?|payouts?|funds)$/,
  ],
  [
    "delete",
    /^(delete|remove|trash|destroy|purge|drop|erase|wipe|unlink|rm|archive|revoke|cancel|close|kick|ban)$/,
    /^(delete|remove|trash|destroy|purge|drop|erase|wipe|unlink)$/,
  ],
  [
    "publish",
    /^(publish|post|tweet|deploy|release|push|merge|create|upload|commit|submit|approve|fork|tag|pin|retweet|repost|make|new|add|insert|import|install)$/,
    /^(publish|deploy|push|merge|upload|commit|submit|approve|tweet|retweet|repost)$/,
  ],
  [
    "send",
    /^(send|email|mail|message|reply|sms|dm|comment|invite|share|notify|forward|mention|react|text|call|chat|respond|broadcast)$/,
    /^(send|reply|forward|invite|share|notify|broadcast|dm|sms|email)$/,
  ],
];

const STRICT_VERB =
  /^(send|reply|forward|delete|remove|purge|destroy|erase|pay|charge|transfer|refund|publish|deploy|push|merge|upload|commit|submit)$/;

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A third-party MCP tool by its name (without the server). */
export function classifyMcpTool(tool: string): ActionClass {
  const w = words(tool);
  const first = w[0] ?? "";
  if (READ_VERBS.has(first)) {
    // `list_payments` only looks; `fetch_and_delete` does not.
    const act = w.slice(1).find((x) => STRICT_VERB.test(x));
    return act ? classifyMcpTool(act) : "network";
  }
  for (const [cls, asFirst, elsewhere] of VERB_CLASSES)
    if (asFirst.test(first) || w.slice(1).some((x) => elsewhere.test(x))) return cls;
  return "send";
}

/** Alca's own MCP servers (the permission tool and the host tools bridge). */
const OWN_SERVERS = new Set(["alcatools", "alca"]);

const STRICT: readonly ActionClass[] = ["payment", "send", "publish", "delete"];

/** The parsed reading (shell.ts) and the whole-text patterns; the stricter one wins. */
function fromShell(command: string): ActionClass | undefined {
  const parsed = classifyShell(command);
  const pattern = SHELL_PATTERNS.find(([, re]) => re.test(command))?.[0];
  if (!parsed || !pattern) return parsed ?? pattern;
  return STRICT.indexOf(parsed) <= STRICT.indexOf(pattern) ? parsed : pattern;
}

/**
 * A shell command line: what the classifier finds wins when it is an
 * always-confirm class (publish, send, delete, payment); plan §4: ordinary
 * build / test / format work in the folder is `write`; anything else as found,
 * else `execute`.
 */
export function shellClass(command: string): ActionClass {
  const found = fromShell(command);
  if (found && STRICT.includes(found)) return found;
  if (devCommand(command)) return "write";
  return found ?? "execute";
}

/** Classify a tool call by name and input. Unknown tools are treated as `execute`. */
export function classifyToolCall(tool: string, input: Record<string, unknown> = {}): ActionClass {
  // Every tool that runs a shell command line (shell-tools.ts: Claude Code's
  // Bash, the coding harness's bash and bash_input, the hands daemon, Codex's
  // command requests, a host tool named shell): the command line decides.
  // Callers only ever take an always-confirm class from this (escalate).
  const named = namedShellCommand(tool, input);
  if (named !== undefined) return shellClass(named);
  // An ACP agent's native tool arrives as its free-text title plus its ACP
  // `kind`. Only escalations are taken from it: a delete is a delete, and a
  // shell tool's command (or its title, usually the command line) gets the
  // same shell floor as Bash. Every other kind stays `execute`, as before.
  if (!BASE[tool] && !tool.startsWith("mcp__")) {
    if (input.kind === "delete") return "delete";
    if (input.kind === "execute") {
      const cmd = typeof input.command === "string" ? input.command : tool;
      return shellClass(cmd);
    }
  }
  const base = BASE[tool];
  if (base) return base;
  if (tool.startsWith("mcp__")) {
    const [, server = "", ...rest] = tool.split("__");
    const verb = rest.join("__");
    if (!OWN_SERVERS.has(server)) return classifyMcpTool(verb);
    for (const [cls, re] of NAME_PATTERNS) if (re.test(verb)) return cls;
    return "network";
  }
  // Codex names another server's tool `mcp:<server>/<tool>` (codex/parse.ts).
  const codex = /^mcp:([^/]*)\/(.+)$/.exec(tool);
  if (codex) return OWN_SERVERS.has(codex[1] as string) ? "network" : classifyMcpTool(codex[2] as string);
  return "execute";
}

/** Keep the declared class unless classification finds an always-confirm class. */
export function escalate(
  declared: ActionClass,
  tool: string,
  input: Record<string, unknown> = {},
): ActionClass {
  if (isAlwaysConfirm(declared)) return declared;
  const found = classifyToolCall(tool, input);
  return isAlwaysConfirm(found) ? found : declared;
}

/** The command line of a shell tool call: a named shell tool (shell-tools.ts) or an ACP `execute` tool. */
export function shellCommandOf(tool: string, input: Record<string, unknown> = {}): string | undefined {
  // The named shell tools (shell-tools.ts), bash_input's stdin text included.
  if (isShellToolName(tool)) return namedShellCommand(tool, input);
  const cmd = typeof input.command === "string" ? input.command : undefined;
  if (!BASE[tool] && input.kind === "execute") return cmd ?? (tool.startsWith("mcp__") ? undefined : tool);
  return undefined;
}

/**
 * The shell floor (H1): why this call needs a person even where the level and
 * the rules would let it run; undefined for anything that is not a shell
 * command Alca cannot vouch for (shell-safe.ts).
 */
export function shellFloor(
  tool: string,
  input: Record<string, unknown> = {},
  fullAccess = false,
): string | undefined {
  const cmd = shellCommandOf(tool, input);
  if (cmd === undefined) return undefined;
  // Plan §4: recognizable build / test / format work in the folder is not "cannot read".
  if (devCommand(cmd)) return undefined;
  // Phase 5: at 完全授權 the file deleters are readable too (the rest of the floor stays).
  const why = shellNeedsPerson(cmd, 0, fullAccess ? FULL_ACCESS_KNOWN : undefined);
  return why ? `Alca 看不懂這個指令會做什麼，先問你（${why}）` : undefined;
}
