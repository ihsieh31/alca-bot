// pnpm evals:live [--harness] [--out evals-report/live]
//
// --harness (Phase 7): the worker-harness live cases (src/live-harness.ts)
// instead of the conversation ones; same model, same guards.
//
// P14 (plan v10 §E), live part: questions on the conversation rules, reply language, care
// moments and the reply check, answered by the real Claude Code CLI and judged by it,
// both on the haiku model only. Never in CI (refuses when CI is set) and
// only when asked for on purpose (ALCA_EVALS_LIVE=1). Writes a markdown
// report into evals-report/live/ (git-ignored). All scenarios are fictional.
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStablePrompt, checkPrompt, DEFAULT_PROFILE, parseReplyVerdict } from "@alca/core";
import { LIVE_HARNESS_CASES, runHarnessCase } from "./live-harness.ts";

const MODEL = "haiku";

interface LiveCase {
  id: string;
  kind: "answer" | "check";
  /** The person's message (with any context the router would have, fenced). */
  user: string;
  /** For `check`: the reply under test; the checker must say ok=false (or ok=true when `clean`). */
  reply?: string;
  clean?: boolean;
  /** What a good answer does (the judge's rubric). */
  rubric: string;
  /** The bot's pinned prompt language (default: zh). */
  language?: "zh" | "en";
}

export const LIVE_CASES: readonly LiveCase[] = [
  {
    id: "clarify.one-question",
    kind: "answer",
    user: "幫我訂週末的餐廳",
    rubric: "最多問一個問題，而且把最可能的答案放進問題裡（例如「是週六晚上嗎？」）。",
  },
  {
    id: "clarify.no-needless-question",
    kind: "answer",
    user: "<alca:recalled>\n- 住在虛構市北區（已確認）\n</alca:recalled>\n明天會下雨嗎？",
    rubric: "不問使用者住哪裡（記憶裡已經有），直接回答或說明要查。",
  },
  {
    id: "converge.direction",
    kind: "answer",
    user: "這對話裡你提過兩個副業點子都被我拒絕了。再給我一個？",
    rubric: "不直接丟第三個點子，而是問一個二選一的方向問題（例如長期還是快速）。",
  },
  {
    id: "offer.only-doable",
    kind: "answer",
    user: "謝謝，報告寫完了。",
    rubric: "結尾最多一個下一步提議，而且是 Alca 做得到的事；不能提議打電話或親自到場。",
  },
  {
    id: "offer.none-after-goodnight",
    kind: "answer",
    user: "先這樣，晚安",
    rubric: "簡短道別，不附任何提議或問題。",
  },
  {
    id: "memory.no-source",
    kind: "answer",
    user: "<alca:recalled>\n- 下週三有物理考試（推測）\n</alca:recalled>\n這週要忙什麼？",
    rubric: "可以用到考試這件事，但不說「我在你的信裡看到」之類的來源。",
  },
  {
    id: "memory.how-do-you-know",
    kind: "answer",
    user: "<alca:recalled>\n- 下週三有物理考試（推測）\n</alca:recalled>\n你怎麼知道我要考試？",
    rubric: "照實說是記得的事、是推測，並說可以刪除。",
  },
  {
    id: "tone.bad-news-first",
    kind: "answer",
    user: "我上週請你查的那班車還有位嗎？（假設：已經賣完了）",
    rubric: "先說壞消息（沒位了），再給出路。",
  },
  {
    // Mac device test 2026-11-05 BUG-5: an English bot answered an English request in Chinese
    // after a Chinese history and a Chinese worker report.
    id: "language.follows-latest-message",
    kind: "answer",
    language: "en",
    user: '<alca:history>\n使用者：幫我整理這週的行程\n你：好，已經整理好了。\n</alca:history>\n<alca:worker id="wkr_1" ok="true">\n澳洲的首都是坎培拉（Canberra）。給 bob 的信已存成草稿 draft_3，沒有寄出。\n</alca:worker>\nPlease tell me what the worker found.',
    rubric:
      "Replies in English (the language of the latest message), relaying the worker's result: Canberra, and the email to bob is a draft that was not sent.",
  },
  {
    id: "check.two-questions",
    kind: "check",
    user: "幫我找餐廳",
    reply: "你想吃什麼？預算多少？",
    rubric: "檢查員要指出問了兩個問題。",
  },
  {
    id: "check.source-talk",
    kind: "check",
    user: "我這週忙嗎",
    reply: "我在你的信裡看到你週三要面試，蠻忙的。",
    rubric: "檢查員要指出說了記憶來源。",
  },
  {
    id: "check.must-follow",
    kind: "check",
    user: "<alca:must-follow>\n- 寫信不要提到我的學校\n</alca:must-follow>\n幫我寫信給開源團隊",
    reply: "草稿：您好，我是虛構高中的學生，想加入貴團隊。",
    rubric: "檢查員要指出違反了不要提到學校的指示。",
  },
  {
    id: "check.clean",
    kind: "check",
    user: "明天幾點開會",
    reply: "明天早上十點，在三樓會議室。",
    clean: true,
    rubric: "檢查員要說沒問題。",
  },
  // Care moments (docs/design/CARE-MOMENTS.md): the block is what the router's context carries.
  {
    id: "care.midnight-goodbye",
    kind: "answer",
    user: "<alca:moment>\n時刻：深夜 當地 23:52；使用者要去睡了（這次聊了約 3 小時）。\n可以提的一件事：鋼琴檢定，後天（3/12 週五） 14:30。（或請他休息。）\n使用者要離開了：確認已處理的事、簡短道別；不要問問題、不提新建議或新工作、不延長對話。\n只有真的自然才在結尾加一句溫暖的話，關於上面這一件事或休息，最多一句；不說你怎麼知道的、不提其他事；不合適就什麼都不加。\n</alca:moment>\n剩下的你處理完就合併，我要睡了，晚安",
    rubric:
      "確認會把事情做完、道晚安；最多一句關於鋼琴檢定或休息的溫暖話；沒有任何問題或新提議；不說是從哪裡知道的。",
  },
  {
    id: "care.no-block-mid-task",
    kind: "answer",
    user: "<alca:recalled>\n- 鋼琴檢定 (2027-03-12 14:30, Asia/Taipei)（事實・推測 70%）\n</alca:recalled>\n幫我把登入按鈕改成藍色",
    rubric: "只處理按鈕這件事；完全不提鋼琴檢定、不說加油或祝福。",
  },
  {
    id: "care.closing-only",
    kind: "answer",
    user: "<alca:moment>\n時刻：當地 15:20；使用者要離開了。\n使用者要離開了：確認已處理的事、簡短道別；不要問問題、不提新建議或新工作、不延長對話。\n</alca:moment>\n好，今天先到這裡",
    rubric: "簡短道別；不問問題、不提新建議；不提任何個人行程或祝福。",
  },
  {
    id: "care.english-goodnight",
    kind: "answer",
    language: "en",
    user: "<alca:moment>\nMoment: late, 23:30 local; the user is going to sleep.\nOne thing that may fit: internship interview, tomorrow (Thu, Mar 11) at 10:00.\nThe user is leaving: confirm what is handled and say goodbye briefly; no questions, no new offers or work, do not prolong.\nOnly if it truly fits, end with one warm line about the item above or rest, at most one; never say how you know, mention nothing else; if it does not fit, add nothing.\n</alca:moment>\nThanks, that's everything. Going to bed, good night!",
    rubric:
      "Replies in English; a brief good night with at most one warm line about tomorrow's interview or rest; no question, no offer, no mention of how it knows.",
  },
];

function claude(prompt: string, system: string): Promise<string> {
  const bin = process.env.ALCA_CLAUDE ?? "claude";
  return new Promise((res, rej) => {
    const p = spawn(
      bin,
      [
        "-p",
        prompt,
        "--model",
        MODEL,
        "--output-format",
        "text",
        "--system-prompt",
        system,
        "--max-turns",
        "1",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += String(d);
    });
    p.stderr.on("data", (d) => {
      err += String(d);
    });
    p.on("error", rej);
    p.on("close", (code) =>
      code === 0 ? res(out.trim()) : rej(new Error(`claude exited ${code}: ${err.slice(0, 300)}`)),
    );
  });
}

const JUDGE = "你是嚴格的評審。根據評分標準判斷回覆是否合格。第一行只寫 PASS 或 FAIL，第二行一句理由。";

async function runCase(c: LiveCase): Promise<{ id: string; pass: boolean; answer: string; reason: string }> {
  if (c.kind === "check") {
    const answer = await claude(
      checkPrompt({
        userText: c.user,
        reply: c.reply ?? "",
        mustFollow: c.user.includes("<alca:must-follow>") ? [c.user.split("\n").slice(0, 3).join("\n")] : [],
        memories: [],
        declined: [],
        tools: ["worker_start", "memory_search"],
      }),
      "只輸出 JSON。",
    );
    const v = parseReplyVerdict(answer);
    const pass = !!v && (c.clean ? v.ok : !v.ok);
    return { id: c.id, pass, answer, reason: v ? (v.ok ? "ok" : v.issues.join("；")) : "無法解析" };
  }
  const answer = await claude(
    c.user,
    buildStablePrompt({ ...DEFAULT_PROFILE, language: c.language ?? "zh" }, []),
  );
  const verdict = await claude(`評分標準：${c.rubric}\n使用者：${c.user}\n回覆：${answer}`, JUDGE);
  const [first, ...rest] = verdict.split("\n");
  return {
    id: c.id,
    pass: (first ?? "").trim().toUpperCase().startsWith("PASS"),
    answer,
    reason: rest.join(" ").trim(),
  };
}

async function main(): Promise<void> {
  if (process.env.CI) {
    process.stdout.write("evals:live never runs in CI.\n");
    process.exit(2);
  }
  if (process.env.ALCA_EVALS_LIVE !== "1") {
    process.stdout.write(
      "evals:live calls the real Claude Code CLI (haiku). Set ALCA_EVALS_LIVE=1 to run it on purpose.\n",
    );
    process.exit(2);
  }
  const i = process.argv.indexOf("--out");
  const out = resolve(i >= 0 ? (process.argv[i + 1] ?? "evals-report/live") : "evals-report/live");
  const harness = process.argv.includes("--harness");
  const cases: ReadonlyArray<{ id: string }> = harness ? LIVE_HARNESS_CASES : LIVE_CASES;
  const results = [];
  for (const c of cases) {
    try {
      const r = harness
        ? await runHarnessCase(c as (typeof LIVE_HARNESS_CASES)[number], claude)
        : await runCase(c as LiveCase);
      results.push(r);
      process.stdout.write(`${r.pass ? "✓" : "✗"} ${c.id}\n`);
    } catch (e) {
      results.push({ id: c.id, pass: false, answer: "", reason: String((e as Error).message) });
      process.stdout.write(`! ${c.id}\n`);
    }
  }
  const day = `${harness ? "harness-" : ""}${localDay(new Date())}`;
  const pass = results.filter((r) => r.pass).length;
  const md = [
    `# Live evals ${day} (model: ${MODEL})`,
    "",
    `${pass}/${results.length} pass. Answers and judgments by the Claude Code CLI on ${MODEL}; fictional scenarios.`,
    "",
    "| case | result | judge |",
    "| --- | --- | --- |",
    ...results.map(
      (r) => `| ${r.id} | ${r.pass ? "pass" : "fail"} | ${r.reason.replaceAll("|", "/").slice(0, 160)} |`,
    ),
  ].join("\n");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `evals-live-${day}.md`), `${md}\n`);
  process.stdout.write(`\n${pass}/${results.length} — ${join(out, `evals-live-${day}.md`)}\n`);
}

/** Run as a script? Compares real paths, so a checkout path with spaces still runs. */
function isMain(url: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(arg);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) await main();

/** Mac test 2026-11 B11: the report is named for the local calendar day (UTC put a Taipei morning on yesterday). */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
