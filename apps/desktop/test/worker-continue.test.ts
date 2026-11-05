import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capView as phoneCap } from "../../phone-pwa/app/worker-view.ts";
import { type DesktopApp, startDesktop } from "../src/index.ts";
import { needsApproveKey } from "../src/ui-session.ts";
import { capView, harnessSections } from "../ui/worker-view.ts";

/**
 * Design §0.2.5 (S10): the person's 續做 — the loopback route needs the
 * approve key and answers the core's refusal as 409; the panels show the
 * button only while the task waits. Fictional data only.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(): Promise<DesktopApp> {
  const dir = mkdtempSync(join(tmpdir(), "alca-continue-"));
  const app = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    agents: "router",
    browser: "off",
    openUrl: () => true,
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => app.close(),
  );
  return app;
}

describe("POST /api/workers/:id/continue (design §0.2.5)", () => {
  it("needs the approve key; a worker with nothing to continue is 409 with the reason", async () => {
    expect(needsApproveKey("POST", "/api/workers/wkr_1/continue")).toBe(true);
    const app = await boot();
    const s = app.core.store;
    const t = app.core.createThread();
    const w = app.agents?.workers.start({
      botId: app.core.defaultBotId,
      threadId: t.id,
      title: "x",
      goal: "x",
      initiator: { kind: "user", id: "u" },
      grants: { harness: "general" },
    });
    const id = w?.id as string;
    const post = (headers: Record<string, string>) =>
      fetch(`${app.server.url}/api/workers/${id}/continue`, {
        method: "POST",
        headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json", ...headers },
        body: "{}",
      });
    expect((await post({ origin: app.server.url })).status).toBe(403);
    const r = await post(app.uiHeaders);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/沒有因為步數預算用完而停下/);
    // Nothing was started by the refused press.
    expect(s.workers.byThread(t.id).filter((x) => x.id !== id)).toHaveLength(0);
  });
});

describe("the 續做 block on the panels (design §0.2.5)", () => {
  const now = Date.parse("2026-11-05T10:00:00Z");
  const waiting = {
    state: "waiting" as const,
    n: 2,
    continues: 1,
    max: 6,
    expiresAt: "2026-11-08T10:00:00Z",
  };
  it("a button only while it waits; the same words on desktop and phone", () => {
    for (const view of [capView, phoneCap]) {
      expect(view(waiting, now)).toEqual({
        title: "步數預算用完了",
        detail: "可以按「續做」讓新的任務照交接接著做（已續做 1／6 次，72 小時內）；不會自動續做。",
        canContinue: true,
      });
      expect(view({ ...waiting, state: "refused", refusal: "已經續做 6 次了，不能再續做" }, now)).toEqual({
        title: "不能再續做",
        detail: "已經續做 6 次了，不能再續做",
        canContinue: false,
      });
      expect(view({ ...waiting, state: "continued" }, now)?.canContinue).toBe(false);
      expect(view({ ...waiting, state: "expired" }, now)?.title).toBe("沒有續做，已結束");
      expect(view(undefined, now)).toBeUndefined();
    }
  });

  it("the block comes first in the panel", () => {
    const hs = { kind: "general" as const, phase: "needs_review" as const, cap: waiting };
    expect(harnessSections(hs, false)).toEqual(["cap", "budget", "review"]);
  });
});
