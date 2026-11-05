// Evals harness: a scenario is a scripted story run against fake engines,
// with named checks instead of test assertions, so one run gives a full
// scorecard (every check, pass or fail) rather than stopping at the first
// failure. Scenarios never call a real model or the network.

export const CATEGORIES = [
  "router",
  "approvals",
  "memory",
  "routines",
  "team",
  "injection",
  "conversation",
  "proactive",
  "addons",
  "coding",
  "general",
  "restart",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_TITLES: Record<Category, string> = {
  router: "Router dispatch (總機 → 工人)",
  approvals: "Approval gates (payment / send / delete / publish always confirmed)",
  memory: "Memory (記住 / 忘記)",
  routines: "Routines (checks before the model)",
  team: "Team delegation (only narrows)",
  injection: "Prompt injection (tool results, web pages, app data)",
  conversation: "Conversation (clarify, converge, end-of-reply offers, must-follow)",
  proactive: "主動留意 (signals only, deadlines, quiet hours, suppress, accept rates)",
  addons: "Add-ons (off means off, daily caps)",
  coding: "Worker harness: coding (edit rules, host verification, ownsPaths, compaction, review)",
  general: "Worker harness: general (web_fetch, catalog, waits, vault, NEEDS_INPUT, outward floor)",
  restart: "Worker harness: restart and races (ledger, writer fence, waits, snapshots)",
};

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface EvalContext {
  /** Record one named check. Never throws; the scenario keeps going. */
  check(name: string, ok: boolean, detail?: unknown): boolean;
  /** Free-form note kept in the report (what was observed). */
  note(text: string): void;
}

export interface Scenario {
  id: string;
  category: Category;
  title: string;
  /** Default 15 s. */
  timeoutMs?: number;
  run(ctx: EvalContext): Promise<void>;
}

export type Status = "pass" | "fail" | "error";

export interface ScenarioResult {
  id: string;
  category: Category;
  title: string;
  status: Status;
  durationMs: number;
  checks: Check[];
  notes: string[];
  error?: string;
}

export interface Report {
  schema: "alca-evals/v1";
  startedAt: string;
  durationMs: number;
  commit?: string;
  totals: {
    scenarios: number;
    pass: number;
    fail: number;
    error: number;
    checks: number;
    failedChecks: number;
  };
  categories: Array<{ category: Category; title: string; scenarios: number; pass: number }>;
  scenarios: ScenarioResult[];
}

const show = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
};

export async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const checks: Check[] = [];
  const notes: string[] = [];
  const ctx: EvalContext = {
    check(name, ok, detail) {
      const d = ok ? undefined : show(detail);
      checks.push({ name, ok, ...(d !== undefined ? { detail: d } : {}) });
      return ok;
    },
    note: (t) => void notes.push(t),
  };
  const start = performance.now();
  let error: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      s.run(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${s.timeoutMs ?? 15_000} ms`)),
          s.timeoutMs ?? 15_000,
        );
      }),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  const status: Status = error ? "error" : checks.length === 0 || checks.some((c) => !c.ok) ? "fail" : "pass";
  if (!error && checks.length === 0) notes.push("no checks recorded");
  return {
    id: s.id,
    category: s.category,
    title: s.title,
    status,
    durationMs: Math.round(performance.now() - start),
    checks,
    notes,
    ...(error ? { error } : {}),
  };
}

export async function runAll(
  scenarios: readonly Scenario[],
  o: { filter?: string; commit?: string; onResult?: (r: ScenarioResult) => void } = {},
): Promise<Report> {
  const ids = new Set<string>();
  for (const s of scenarios) {
    if (ids.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
    ids.add(s.id);
  }
  const picked = o.filter
    ? scenarios.filter((s) =>
        (o.filter as string).split(",").some((f) => s.id.includes(f) || s.category === f),
      )
    : scenarios;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const results: ScenarioResult[] = [];
  // One at a time: scenarios share nothing, but serial runs keep timings and logs readable.
  for (const s of picked) {
    const r = await runScenario(s);
    results.push(r);
    o.onResult?.(r);
  }
  const count = (st: Status) => results.filter((r) => r.status === st).length;
  return {
    schema: "alca-evals/v1",
    startedAt,
    durationMs: Math.round(performance.now() - start),
    ...(o.commit ? { commit: o.commit } : {}),
    totals: {
      scenarios: results.length,
      pass: count("pass"),
      fail: count("fail"),
      error: count("error"),
      checks: results.reduce((n, r) => n + r.checks.length, 0),
      failedChecks: results.reduce((n, r) => n + r.checks.filter((c) => !c.ok).length, 0),
    },
    categories: CATEGORIES.map((category) => {
      const rs = results.filter((r) => r.category === category);
      return {
        category,
        title: CATEGORY_TITLES[category],
        scenarios: rs.length,
        pass: rs.filter((r) => r.status === "pass").length,
      };
    }).filter((c) => c.scenarios > 0),
    scenarios: results,
  };
}

const mdCell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
const ICON: Record<Status, string> = { pass: "✅", fail: "❌", error: "💥" };

export function toMarkdown(r: Report): string {
  const t = r.totals;
  const out = [
    "# Alca evals",
    "",
    `${t.pass}/${t.scenarios} scenarios pass · ${t.checks - t.failedChecks}/${t.checks} checks · ${(r.durationMs / 1000).toFixed(1)} s · ${r.startedAt}${r.commit ? ` · \`${r.commit.slice(0, 12)}\`` : ""}`,
    "",
    "| Category | Pass |",
    "| --- | --- |",
    ...r.categories.map((c) => `| ${mdCell(c.title)} | ${c.pass}/${c.scenarios} |`),
    "",
  ];
  for (const c of r.categories) {
    out.push(`## ${c.title}`, "");
    for (const s of r.scenarios.filter((x) => x.category === c.category)) {
      out.push(`### ${ICON[s.status]} ${s.title}`, "", `\`${s.id}\` · ${s.durationMs} ms`, "");
      if (s.error) out.push(`**Error:** ${s.error}`, "");
      for (const k of s.checks)
        out.push(`- ${k.ok ? "✓" : "✗"} ${k.name}${k.detail ? ` — got \`${mdCell(k.detail)}\`` : ""}`);
      for (const n of s.notes) out.push(`- _${n}_`);
      out.push("");
    }
  }
  return out.join("\n");
}
