// Seeds the demo with memory and skills for the screenshots (desktop and phone):
// things said in chat (some confirmed with 記住, some inferred), one item the
// person edited (two versions), one added by hand, a saved skill that was
// reused once, and — when the demo shop is available — a fresh proposal from a
// paid checkout (its payment step is always confirmed).
import type { DesktopApp } from "../src/start.ts";

interface Seed {
  api: (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;
  thread: () => Promise<string>;
  idle: (threadId: string) => Promise<void>;
  pending: (kind: "approvals" | "questions") => Promise<string>;
  app: DesktopApp;
  shop: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function seedMemory(o: Seed): Promise<void> {
  const { api, app } = o;
  const say = async (t: string, text: string) => {
    await api("POST", `/api/threads/${t}/messages`, { text });
    await o.idle(t);
    await app.learning.settle();
  };
  const about = await o.thread();
  for (const text of [
    "記住我喜歡喝燕麥奶拿鐵，少冰",
    "我住在高雄",
    "我對花生過敏",
    "我的媽媽是護理師",
    "記住我週末不開會",
    "我最近在開發一個記帳 App",
  ])
    await say(about, text);
  await api("POST", "/api/memory", { body: "每月 5 號繳房租", kind: "fact" });
  const items = (await api("GET", "/api/memory")).items as Array<{ id: string; body: string }>;
  const home = items.find((i) => i.body === "住在高雄");
  if (home) await api("PATCH", `/api/memory/${home.id}`, { body: "住在高雄市鼓山區" });

  // A two-step task → proposal → approved → reused once.
  const approveAll = async (until: () => boolean, threadId: string) => {
    for (let i = 0; i < 600 && !until(); i++) {
      const p = app.core.store.human
        .pendingApprovals()
        .find((a) => a.runId && app.core.store.runs.get(a.runId)?.threadId === threadId);
      if (p) await api("POST", `/api/approvals/${p.id}`, { decision: "approved" });
      await sleep(25);
    }
  };
  const weekly = await o.thread();
  await api("POST", `/api/threads/${weekly}/messages`, { text: "幫我整理這週的週報" });
  await approveAll(
    () => app.core.store.workers.byThread(weekly).some((w) => w.status === "succeeded"),
    weekly,
  );
  await app.learning.settle();
  const proposal = app.core.store.skills.list().find((s) => s.pending?.name === "整理週報");
  if (proposal)
    await api("POST", `/api/skills/${proposal.id}/approve`, { edit: { triggers: ["整理週報", "週報"] } });
  const again = await o.thread();
  await api("POST", `/api/threads/${again}/messages`, { text: "再幫我整理一次週報" });
  await approveAll(() => app.core.store.workers.byThread(again).some((w) => w.status === "succeeded"), again);
  await o.idle(again);

  // A paid checkout in the demo shop → a proposal waiting, with the payment step marked.
  if (o.shop) {
    const shop = await o.thread();
    await api("POST", `/api/threads/${shop}/messages`, { text: "幫我在示範商店結帳" });
    await approveAll(() => app.core.store.workers.byThread(shop).some((w) => w.status === "succeeded"), shop);
    await o.idle(shop);
    await app.learning.settle();
  }
  // Let the router's replies land.
  await sleep(400);
}
