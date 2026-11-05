// Prompt budget ratchet (next-round design §0.2.6): the size in UTF-8 bytes of
// every fixed prompt piece and visible tool spec, against the numbers in
// scripts/prompt-budget.json. It only ratchets down:
//
//   - a piece larger than its number fails (a prompt only grows by editing the
//     JSON by hand, where a reviewer sees it);
//   - a piece more than 5% smaller fails too, asking for `--update`, so the
//     saving is locked in;
//   - `--update` lowers numbers to the current sizes and never raises one.
//
// Usage: node scripts/check-prompt-budget.ts [--update] [--json]
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERAL_DIRECT, lazyTools } from "../packages/core/src/harness/general/lazy.ts";
import {
  buildStablePrompt,
  CARE_RULES,
  CODING_RULES,
  CONTRACT_RULES,
  CONVERSATION_RULES,
  CodingTools,
  contractTools,
  GENERAL_RULES,
  HARNESS_CHOICE_RULES,
  type HostTool,
  harnessProfile,
  harnessToolNames,
  PEER_TOOL_NAMES,
  type PromptLanguage,
  ROUTER_RULES,
  ROUTER_RULES_EN,
  ROUTER_TOOL_NAMES,
  RouterDesk,
  routerProfile,
  WORKER_RULES,
  WORKER_RULES_EN,
  workerProfile,
} from "../packages/core/src/index.ts";

export const BUDGET_FILE = join(dirname(fileURLToPath(import.meta.url)), "prompt-budget.json");
/** How much smaller than its number a piece may get before the number must come down. */
export const SLACK = 0.05;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const lines = (l: readonly string[]) => bytes(l.join("\n"));
const specs = (tools: readonly HostTool[]) => bytes(JSON.stringify(tools.map((t) => t.spec)));
const LANGS: readonly PromptLanguage[] = ["zh", "en"];

/** Every measured piece, by a stable name. */
export function measure(): Record<string, number> {
  const out: Record<string, number> = {};
  const routerTools = [...ROUTER_TOOL_NAMES, ...PEER_TOOL_NAMES];
  for (const lang of LANGS) {
    out[`stable.router.${lang}`] = bytes(
      buildStablePrompt({ ...routerProfile(), language: lang }, routerTools),
    );
    out[`stable.worker.${lang}`] = bytes(buildStablePrompt({ ...workerProfile(), language: lang }, []));
    for (const kind of ["coding", "general"] as const)
      out[`stable.${kind}.${lang}`] = bytes(
        buildStablePrompt(
          harnessProfile({ ...workerProfile(), language: lang }, kind, lang),
          harnessToolNames(kind, []),
        ),
      );
    out[`rules.contract.${lang}`] = lines(CONTRACT_RULES[lang]);
    out[`rules.coding.${lang}`] = lines(CODING_RULES[lang]);
    out[`rules.general.${lang}`] = lines(GENERAL_RULES[lang]);
    out[`rules.harness-choice.${lang}`] = lines(HARNESS_CHOICE_RULES[lang]);
    out[`rules.conversation.${lang}`] = bytes(CONVERSATION_RULES[lang]);
    // Care moments: the rules of an <alca:moment> block (per turn, only at a moment).
    out[`rules.care.${lang}`] = lines([CARE_RULES[lang].closing, CARE_RULES[lang].care]);
  }
  out["rules.router"] = lines(ROUTER_RULES);
  out["rules.router.en"] = lines(ROUTER_RULES_EN);
  out["rules.worker"] = lines(WORKER_RULES);
  out["rules.worker.en"] = lines(WORKER_RULES_EN);
  // Tool specs as the engine sees them. Building them touches no state, so stubs do.
  const stub = { store: {} } as unknown as ConstructorParameters<typeof RouterDesk>[0]["core"];
  out["tools.router"] = specs(new RouterDesk({ core: stub, workers: () => ({}) as never }).tools());
  out["tools.coding"] = specs(new CodingTools({ dirFor: () => undefined, rg: false }).tools());
  const contract = contractTools({
    report: () => undefined,
    handoff: () => undefined,
    harnessOf: () => undefined,
  });
  out["tools.contract"] = specs(contract);
  out["tools.report_result"] = specs(contract.filter((t) => t.spec.name === "report_result"));
  out["tools.general-lazy"] = specs(lazyTools([]));
  out["tools.general-direct-names"] = bytes(JSON.stringify(GENERAL_DIRECT));
  return out;
}

export interface BudgetProblem {
  name: string;
  now?: number;
  budget?: number;
  why: "over" | "under" | "unknown" | "gone";
}

/** Compare sizes with the budget; empty = within it. */
export function compareBudget(
  now: Readonly<Record<string, number>>,
  budget: Readonly<Record<string, number>>,
  slack = SLACK,
): BudgetProblem[] {
  const out: BudgetProblem[] = [];
  for (const [name, n] of Object.entries(now)) {
    const b = budget[name];
    if (b === undefined) out.push({ name, now: n, why: "unknown" });
    else if (n > b) out.push({ name, now: n, budget: b, why: "over" });
    else if (n < b * (1 - slack)) out.push({ name, now: n, budget: b, why: "under" });
  }
  for (const name of Object.keys(budget))
    if (!(name in now)) out.push({ name, budget: budget[name] as number, why: "gone" });
  return out;
}

/**
 * `--update`: every number comes down to its current size; a piece over its
 * number keeps the old number (and still fails); a new piece is added, and a
 * piece that no longer exists is dropped.
 */
export function lowered(
  now: Readonly<Record<string, number>>,
  budget: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(now).sort()) {
    const n = now[name] as number;
    const b = budget[name];
    out[name] = b === undefined ? n : Math.min(n, b);
  }
  return out;
}

function say(p: BudgetProblem): string {
  if (p.why === "over")
    return `✗ ${p.name}: ${p.now} bytes, budget ${p.budget} (+${(p.now ?? 0) - (p.budget ?? 0)})`;
  if (p.why === "under")
    return `✗ ${p.name}: ${p.now} bytes, more than ${SLACK * 100}% under ${p.budget}: run with --update to lock it in`;
  if (p.why === "unknown") return `✗ ${p.name}: ${p.now} bytes, not in the budget: run with --update`;
  return `✗ ${p.name}: in the budget but no longer measured: run with --update`;
}

function main(): void {
  const args = process.argv.slice(2);
  const now = measure();
  const budget = JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as Record<string, number>;
  if (args.includes("--update")) {
    const next = lowered(now, budget);
    writeFileSync(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`);
    const over = compareBudget(now, next).filter((p) => p.why === "over");
    for (const p of over) console.error(say(p));
    if (over.length) {
      console.error("--update never raises a number; shrink the prompt or edit the budget by hand.");
      process.exit(1);
    }
    console.log(`prompt budget: updated (${Object.keys(next).length} pieces)`);
    return;
  }
  if (args.includes("--json")) console.log(JSON.stringify(now, null, 2));
  const problems = compareBudget(now, budget);
  for (const p of problems) console.error(say(p));
  if (problems.length) process.exit(1);
  console.log(`prompt budget: within budget (${Object.keys(now).length} pieces)`);
}

/**
 * Run as a script (not imported)? Compares real paths, so a checkout whose path
 * has spaces (`import.meta.url` encodes them as %20) or symlinks still runs.
 */
function isMain(url: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(arg);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) main();
