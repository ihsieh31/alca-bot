// Seeds the demo with harness workers for the Phase 6 screenshots (desktop and
// phone). Everything is fictional and written straight into the store, the
// same rows a real run leaves behind, so the panels read them exactly as they
// would after a restart:
//
// - 工程師 (a coding bot at 完全授權, harness settings filled in) works on
//   「修登入表單驗證」: two verification rounds (the second one red), its
//   budget, the calls that ran only at 完全授權, and three git snapshots;
// - Alca waits on 「寄報價單給客戶」 with two questions (one only the person
//   can answer);
// - 工程師 finished 「補上忘記密碼的測試」, and the reviewer named two gaps.
import type { DesktopApp } from "../src/start.ts";

interface Seed {
  api: (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;
  app: DesktopApp;
}

export interface HarnessSeed {
  /** The conversation that holds the three workers. */
  threadId: string;
  threadTitle: string;
  /** The coding bot at 完全授權. */
  engineer: string;
  /** The coding worker with checks, budget, the 完全授權 log and snapshots. */
  coding: string;
  codingTitle: string;
  /** The worker waiting on the person's answers. */
  asking: string;
  askingTitle: string;
}

const MIN = 60_000;

export async function seedHarness({ api, app }: Seed): Promise<HarnessSeed> {
  const store = app.core.store;
  const now = Date.now();
  const threadTitle = "登入頁改版";
  const engineer = String(
    (
      await api("POST", "/api/bots", {
        name: "工程師",
        avatar: "工",
        color: "jade",
        role: "改程式、跑測試",
        harness: {
          default: "coding",
          reviewer: true,
          coding: { maxSteps: 60, maxWallSec: 1800, maxTokens: 120_000 },
          general: { maxSteps: 30 },
        },
      })
    ).id,
  );
  // 完全授權 is turned on in the store: the seed stands in for the person's confirmed switch.
  store.bots.update(engineer, { approvalLevel: "full_access" });
  const threadId = String((await api("POST", "/api/threads", { title: threadTitle })).id);
  store.threads.addMessage({
    id: `msg_seed_h1_${now}`,
    threadId,
    runId: null,
    role: "user",
    content: "把登入頁的表單驗證修好，測試要全綠；順便把報價單寄給客戶。",
  });
  store.threads.addMessage({
    id: `msg_seed_h2_${now}`,
    threadId,
    runId: null,
    role: "assistant",
    content: "好，登入頁交給工程師，完成條件是測試和 lint 都過；報價單我來寄，寄之前有兩件事要先問你。",
  });

  let n = 0;
  const job = () => {
    const id = `job_seed_h${now}_${n++}`;
    store.db
      .prepare("INSERT INTO jobs (id, kind, created_at, updated_at) VALUES (?, 'subagent', ?, ?)")
      .run(id, new Date(now).toISOString(), new Date(now).toISOString());
    return id;
  };
  const worker = (o: {
    botId: string;
    kind: "coding" | "general";
    title: string;
    goal: string;
    doneWhen: string;
    checks?: string[];
    budget: { maxSteps: number; maxRunMs: number; maxTokens: number };
    level: string;
    startedMinAgo: number;
  }) => {
    const d = store.dispatches.open(
      { botId: o.botId, threadId, harness: o.kind, level: o.level },
      now - o.startedMinAgo * MIN,
    );
    const w = store.workers.create(
      {
        botId: o.botId,
        threadId,
        jobId: job(),
        title: o.title,
        goal: o.goal,
        initiator: { kind: "user", id: "me" },
        budget: o.budget,
        grants: {
          harness: o.kind,
          dispatchId: d.id,
          doneWhen: o.doneWhen,
          ...(o.checks ? { checks: o.checks } : {}),
        },
      },
      new Date(now - o.startedMinAgo * MIN),
    );
    const token = `${w.id}:a1`;
    store.dispatches.begin(d.id, w.id, token, now - o.startedMinAgo * MIN);
    return { d, w, token };
  };
  const verify = (
    dispatchId: string,
    token: string,
    round: number,
    at: number,
    ok: boolean,
    checks: Array<{ command: string; exitCode: number | null; summary: string }>,
  ) => {
    store.dispatches.event(dispatchId, "verify.started", at, { runId: token, detail: { round } });
    store.dispatches.event(dispatchId, "verify.result", at + 40_000, {
      runId: token,
      detail: { round, ok, checks },
    });
  };

  // 1. The coding worker: running, its second verification round red.
  const codingTitle = "修登入表單驗證";
  const a = worker({
    botId: engineer,
    kind: "coding",
    title: codingTitle,
    goal: "登入表單：空白帳號、格式錯誤的信箱、太短的密碼都要擋下並顯示提示。",
    doneWhen: "pnpm test 全綠、pnpm lint 沒有錯誤",
    checks: ["pnpm lint", "pnpm test"],
    budget: { maxSteps: 60, maxRunMs: 30 * MIN, maxTokens: 120_000 },
    level: "full_access",
    startedMinAgo: 12,
  });
  store.workers.setStatus(a.w.id, "running");
  store.workers.activity(a.w.id, new Date(now - 20_000), { steps: 23, tokens: 41_200 });
  verify(a.d.id, a.token, 1, now - 8 * MIN, false, [
    { command: "pnpm lint", exitCode: 1, summary: "src/login/form.ts:42:7 未使用的變數 `raw`\n1 error" },
    { command: "pnpm test", exitCode: 1, summary: "login form › 拒絕空白帳號 ✗\n2 failed, 14 passed" },
  ]);
  verify(a.d.id, a.token, 2, now - 3 * MIN, false, [
    { command: "pnpm lint", exitCode: 0, summary: "Checked 38 files. No errors." },
    {
      command: "pnpm test",
      exitCode: 1,
      summary:
        "login form › 信箱格式錯誤時顯示提示 ✗\n  expected 「請輸入正確的信箱」 got undefined\n1 failed, 15 passed",
    },
  ]);
  // The calls that ran only at 完全授權 are tied to the worker's own run.
  const runId = `run_seed_h${now}`;
  store.db
    .prepare(
      "INSERT INTO runs (id, thread_id, initiator_kind, initiator_id, started_at, worker_id) VALUES (?, ?, 'user', 'me', ?, ?)",
    )
    .run(runId, threadId, new Date(now - 12 * MIN).toISOString(), a.w.id);
  for (const [min, tool, summary] of [
    [11, "bash", "git switch -c fix/login-validation"],
    [9, "bash", "pnpm add -D zod"],
    [4, "bash", "rm -rf .cache/vitest"],
  ] as const)
    store.dispatches.event(a.d.id, "auto_allowed", now - min * MIN, {
      detail: { reason: "full_access", tool, runId, summary },
    });
  const repo = "/Users/demo/code/login-page";
  for (const [seq, min, sha] of [
    [1, 11, "4f1c2a9d7e3b"],
    [2, 8, "9a0b7c3e5d21"],
    [3, 3, "c7d2e8f1a046"],
  ] as const)
    store.gitSnapshots.add({
      ref: `refs/alca/snapshots/${a.d.id}/${seq}`,
      repo,
      dispatchId: a.d.id,
      seq,
      commit: `${sha}${"0".repeat(28)}`,
      createdAt: now - min * MIN,
    });

  // 2. The asking worker: two questions, one only the person can answer.
  const askingTitle = "寄報價單給客戶";
  const b = worker({
    botId: app.core.defaultBotId,
    kind: "general",
    title: askingTitle,
    goal: "把本月報價單寄給客戶的採購窗口。",
    doneWhen: "報價單寄出，收件人和附件都對",
    budget: { maxSteps: 30, maxRunMs: 15 * MIN, maxTokens: 60_000 },
    level: "autonomous",
    startedMinAgo: 6,
  });
  store.workers.activity(b.w.id, new Date(now - 4 * MIN), { steps: 7, tokens: 9_800 });
  store.dispatches.askInput(
    b.d.id,
    b.token,
    {
      workerId: b.w.id,
      report: { status: "needs_input", summary: "寄出前要先確定兩件事", changes: [], claims: [] },
    },
    {
      workerId: b.w.id,
      questions: [
        { question: "用公司信箱還是個人信箱寄出？", options: ["公司信箱", "個人信箱"] },
        { question: "報價單上要填客戶的統一編號，是多少？", personOnly: true },
      ],
      expiresAt: null,
    },
    now - 4 * MIN,
  );
  store.workers.finish(b.w.id, "succeeded", new Date(now - 4 * MIN));

  // 3. A finished coding worker: checks green, the reviewer named two gaps.
  const c = worker({
    botId: engineer,
    kind: "coding",
    title: "補上忘記密碼的測試",
    goal: "忘記密碼流程補齊單元測試。",
    doneWhen: "忘記密碼的每個畫面都有測試",
    checks: ["pnpm test"],
    budget: { maxSteps: 60, maxRunMs: 30 * MIN, maxTokens: 120_000 },
    level: "full_access",
    startedMinAgo: 40,
  });
  store.workers.activity(c.w.id, new Date(now - 26 * MIN), { steps: 31, tokens: 52_000 });
  verify(c.d.id, c.token, 1, now - 28 * MIN, true, [
    { command: "pnpm test", exitCode: 0, summary: "18 passed" },
  ]);
  store.dispatches.settle(
    c.d.id,
    c.token,
    "partial",
    {
      workerId: c.w.id,
      report: { status: "partial", summary: "補了 4 個測試，全部通過", changes: [], claims: [] },
      actions: {
        filesChanged: ["test/forgot-password.test.ts"],
        commands: ["pnpm test"],
        pages: [],
        connector: [],
        testsRun: ["pnpm test"],
        toolCalls: 31,
        okToolCalls: 30,
        errors: [],
        outward: [],
      },
      verified: true,
      review: { met: false, gaps: ["沒有測信箱格式錯誤的情況", "重設連結過期後的畫面沒有測試"] },
    },
    now - 26 * MIN,
  );
  store.workers.finish(c.w.id, "succeeded", new Date(now - 26 * MIN));

  return { threadId, threadTitle, engineer, coding: a.w.id, codingTitle, asking: b.w.id, askingTitle };
}
