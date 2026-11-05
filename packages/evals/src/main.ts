// pnpm evals [--filter <id-part|category>[,…]] [--out <dir>] [--json]
// Runs every scripted scenario against fake engines, writes report.json and
// report.md to the output directory (default evals-report/), prints a
// summary, and exits 1 when any scenario fails.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EVAL_LANG, EVAL_SEALED, englishTurnCount, sealedStoreCount } from "./fixtures.ts";
import { runAll, toMarkdown } from "./harness.ts";
import { SCENARIOS } from "./scenarios.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const out = resolve(arg("--out") ?? "evals-report");
const filter = arg("--filter");
const commit = process.env.GITHUB_SHA;
const report = await runAll(SCENARIOS, {
  ...(filter ? { filter } : {}),
  ...(commit ? { commit } : {}),
  onResult: (r) => {
    const mark = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "!";
    process.stdout.write(`${mark} ${r.id} (${r.durationMs} ms)\n`);
    for (const c of r.checks.filter((x) => !x.ok))
      process.stdout.write(`    ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}\n`);
    if (r.error) process.stdout.write(`    ! ${r.error}\n`);
  },
});
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(out, "report.md"), `${toMarkdown(report)}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${toMarkdown(report)}\n`, { flag: "a" });
const t = report.totals;
process.stdout.write(
  `\n${t.pass}/${t.scenarios} scenarios pass, ${t.checks - t.failedChecks}/${t.checks} checks — ${join(out, "report.md")}\n`,
);
if (EVAL_SEALED) {
  // R7.9: the sealed run must really have run sealed.
  process.stdout.write(
    `sealed mode (ALCA_EVAL_SEALED=1): ${sealedStoreCount()} stores opened with a data key\n`,
  );
  if (sealedStoreCount() === 0) process.exit(1);
}
if (EVAL_LANG === "en") {
  // R9.6: the English run must really have used the English rules.
  process.stdout.write(
    `English bots (ALCA_EVAL_LANG=en): ${englishTurnCount()} engine turns saw the English rules\n`,
  );
  if (englishTurnCount() === 0) process.exit(1);
}
if (report.scenarios.length === 0) {
  process.stdout.write("no scenario matched\n");
  process.exit(1);
}
// Leftover timers from closed fixtures must not keep a failing run alive, nor a passing one.
process.exit(t.fail + t.error > 0 ? 1 : 0);
