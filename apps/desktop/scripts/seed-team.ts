// Seeds the demo with a team for the screenshots (desktop and phone): three
// teammates besides Alca, a delegation the person approved that came back
// with an answer, an @mention reply, and a teammate whose worker waits for the
// person on a delete (the card shows in the person's own conversation).
import type { ApprovalRecord } from "@alca/store";
import type { DesktopApp } from "../src/start.ts";

interface Seed {
  api: (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;
  app: DesktopApp;
  thread: (botId?: string) => Promise<string>;
  idle: (threadId: string) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TeamSeed {
  research: string;
  writer: string;
  planner: string;
  /** The conversation with an approved delegation, answered. */
  delegated: string;
  /** The conversation where a teammate's delete waits for the person. */
  waiting: string;
}

export async function seedTeam({ api, app, thread, idle }: Seed): Promise<TeamSeed> {
  const store = app.core.store;
  // Alca leads: its role says so, the way a person would write it.
  await api("PATCH", `/api/bots/${app.core.defaultBotId}`, { role: "總管：接需求、分給適合的隊友" });
  const research = String(
    (
      await api("POST", "/api/bots", {
        name: "研究員",
        avatar: "研",
        color: "jade",
        role: "查資料、比價、整理報告",
      })
    ).id,
  );
  const writer = String(
    (
      await api("POST", "/api/bots", {
        name: "寫手",
        avatar: "寫",
        color: "plum",
        role: "寫稿、整理文件",
        instructions: "一律用繁體中文，先給結論再給細節。",
      })
    ).id,
  );
  const planner = String(
    (
      await api("POST", "/api/bots", {
        name: "行程",
        avatar: "行",
        color: "indigo",
        role: "排行程、管行事曆、清單",
        approvalLevel: "confirm_each_step",
        browserProfile: "isolated",
      })
    ).id,
  );
  await api("POST", "/api/team/lead", { botId: app.core.defaultBotId });

  const cardIn = async (pred: (a: ApprovalRecord) => boolean) => {
    for (let i = 0; i < 600; i++) {
      const hit = store.human.pendingApprovals().find(pred);
      if (hit) return hit.id;
      await sleep(25);
    }
    throw new Error("no card");
  };
  const peerDone = async (root: string) => {
    for (let i = 0; i < 800; i++) {
      const rs = store.team.byRoot(root);
      if (rs.length && rs.every((r) => r.status !== "running")) return;
      await sleep(25);
    }
    throw new Error("peer never finished");
  };

  // 1. A delegation the person approves; the teammate's worker answers; Alca reports.
  const delegated = await thread();
  await api("POST", `/api/threads/${delegated}/messages`, {
    text: "請研究員比較三家店的藍牙耳機，整理成報告",
  });
  await api("POST", `/api/approvals/${await cardIn((a) => a.summary.includes("研究員"))}`, {
    decision: "approved",
  });
  await peerDone(delegated);
  for (let i = 0; i < 400 && !store.workers.pendingInbox().every((x) => x.threadId !== delegated); i++)
    await sleep(25);
  await idle(delegated);
  await sleep(300);
  await idle(delegated);
  // 2. An @mention in the same conversation: the writer answers here, with its own byline.
  await api("POST", `/api/threads/${delegated}/messages`, { text: "@寫手 把報告的結論寫成一段給主管的訊息" });
  await sleep(200);
  for (let i = 0; i < 400; i++) {
    const p = store.human.pendingApprovals().find((a) => a.botId === writer);
    if (p) {
      await api("POST", `/api/approvals/${p.id}`, { decision: "approved" });
      break;
    }
    if (!app.core.isBusy(delegated) && store.workers.active(writer).length === 0) break;
    await sleep(25);
  }
  for (let i = 0; i < 400 && store.workers.active(writer).length; i++) await sleep(25);
  await idle(delegated);
  await sleep(400);
  await idle(delegated);

  // 3. A delegation under the auto rule whose teammate needs a yes for a delete: it waits here.
  await api("PATCH", "/api/team/rules", { peerApproval: "auto" });
  const waiting = await thread();
  await api("POST", `/api/threads/${waiting}/messages`, { text: "請行程刪除購物清單，週末的採買改到週日" });
  await cardIn((a) => a.actionClass === "delete" && a.botId === planner);
  await idle(waiting);
  await api("PATCH", "/api/team/rules", { peerApproval: "ask_delegate" });
  await sleep(400);
  return { research, writer, planner, delegated, waiting };
}
