// Seeds the demo with connected apps and routines for the screenshots (desktop
// and phone), against the local Composio stand-in: the key set once, two Gmail
// accounts (工作 / 個人) and one Google 日曆, the 個人 inbox read-only for the
// router, a trigger on 工作, and three routines — one that found new mail and
// left a reply draft ahead, one quiet, one whose read failed (kept its cursor).
import type { DesktopApp } from "../src/start.ts";

interface Seed {
  api: (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;
  app: DesktopApp;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function seedConnectors({ api, app }: Seed): Promise<void> {
  const mock = app.composioMock;
  if (!mock) throw new Error("seedConnectors needs composioMock");
  await api("PUT", "/api/connectors/key", { key: mock.key });
  for (const [toolkit, label] of [
    ["gmail", "工作"],
    ["gmail", "個人"],
    ["googlecalendar", "我的行程"],
  ] as const) {
    const r = (await api("POST", "/api/connectors/accounts", { toolkit, label })) as { redirectUrl?: string };
    if (r.redirectUrl) await fetch(r.redirectUrl); // the person finishes the provider's page
  }
  type Status = {
    groups: Array<{
      toolkit: string;
      accounts: Array<{ id: string; label: string; status: string; bots: Array<{ botId: string }> }>;
    }>;
  };
  let st: Status | undefined;
  for (let i = 0; i < 200; i++) {
    st = (await api("POST", "/api/connectors/refresh")) as unknown as Status;
    if (st.groups.flatMap((g) => g.accounts).every((a) => a.status === "active")) break;
    await sleep(25);
  }
  const accounts = st?.groups.flatMap((g) => g.accounts) ?? [];
  const personal = accounts.find((a) => a.label === "個人");
  const bot = personal?.bots[0]?.botId;
  if (personal && bot)
    await api("PUT", `/api/connectors/accounts/${personal.id}/bots/${bot}`, { access: "read" });
  const work = accounts.find((a) => a.label === "工作");
  if (work)
    await api("POST", `/api/connectors/accounts/${work.id}/triggers`, { slug: "GMAIL_NEW_GMAIL_MESSAGE" });

  // A routine that found new mail: one AI run, a reply draft ahead.
  const mail = (await api("POST", "/api/routines", {
    name: "工作信箱",
    kind: "cron",
    cron: "0 9 * * 1-5",
    tz: "Asia/Taipei",
    check: { kind: "app", app: "gmail", account: "工作" },
    instructions: "有需要我回的信就告訴我",
    speculative: true,
  })) as { id: string };
  await api("POST", `/api/routines/${mail.id}/run`);
  for (let i = 0; i < 400; i++) {
    const list = (await api("GET", "/api/routines")) as { drafts: unknown[] };
    if (list.drafts.length) break;
    await sleep(25);
  }
  // A quiet one: nothing new, no AI run.
  const cal = (await api("POST", "/api/routines", {
    name: "明天的行程",
    kind: "interval",
    intervalSec: 3600,
    check: { kind: "app", app: "googlecalendar", account: "我的行程" },
    instructions: "有新的行程就提醒我",
  })) as { id: string };
  // First look: new → one AI run; once it is done, a second look is quiet.
  await api("POST", `/api/routines/${cal.id}/run`);
  for (let i = 0; i < 400; i++) {
    const l = (await api("GET", "/api/routines")) as {
      routines: Array<{ id: string; state: string; runs: Array<{ outcome: string }> }>;
    };
    const r = l.routines.find((x) => x.id === cal.id);
    if (r && r.state !== "working" && r.runs.some((x) => x.outcome === "ai_done")) break;
    await sleep(25);
  }
  await api("POST", `/api/routines/${cal.id}/run`);
  // One whose read failed: it keeps its cursor and backs off.
  const home = (await api("POST", "/api/routines", {
    name: "個人信箱",
    kind: "interval",
    intervalSec: 1800,
    check: { kind: "app", app: "gmail", account: "個人" },
    instructions: "帳單或包裹通知就告訴我",
  })) as { id: string };
  mock.failReads = "Gmail 暫時無法使用（503）";
  await api("POST", `/api/routines/${home.id}/run`);
  mock.failReads = null;
  await sleep(300);
}
