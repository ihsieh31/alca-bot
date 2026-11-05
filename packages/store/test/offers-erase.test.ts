import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BatchSizer,
  backupNow,
  listBackups,
  maintain,
  OFFERS_KEEP_DAYS,
  openStore,
  pruneDecidedOffers,
  pruneRetention,
  type Store,
  scrubBackupFile,
} from "../src/index.ts";
import { botOf } from "./seed-conversation.ts";

// Review 2026-11-05 #1: offer cards follow a deleted conversation, and decided
// cards do not pile up forever. Fake data only.

const dirs: string[] = [];
const tmpDb = () => {
  const d = mkdtempSync(join(tmpdir(), "alca-offers-erase-"));
  dirs.push(d);
  return join(d, "state.sqlite");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const M = "OKAPI-OFFERDEL-7731";
const DAY = 86_400_000;

function card(s: Store, threadId: string | null, tag: string, at = new Date()) {
  return s.offers.add(
    {
      botId: botOf(s),
      threadId,
      source: "addon:proactive",
      category: "errand",
      topic: `${M}-${tag}-topic`,
      text: `${M}-${tag}-text`,
      action: `${M}-${tag}-action`,
      evidence: ["gmail:msg_1"],
    },
    at,
  );
}

const logRow = (s: Store, offerId: string) =>
  s.proactiveLog.add({
    botId: botOf(s),
    scanId: "scan_1",
    via: "scan",
    category: "errand",
    sources: ["mail"],
    evidenceN: 1,
    timeliness: 0.5,
    relevance: 0.5,
    doable: 1,
    acceptance: 0.5,
    total: 0.6,
    outcome: "offered",
    offerId,
  });

describe("deleting a conversation deletes its offer cards", () => {
  it("removes the thread's offers (pending and decided), unlinks their log rows, keeps other threads'", () => {
    const path = tmpDb();
    const s = openStore(path);
    s.threads.create("t_del", "gone");
    s.threads.create("t_keep", "kept");
    const a = card(s, "t_del", "a");
    const b = card(s, "t_del", "b");
    s.offers.decide(b.id, "declined");
    const k = card(s, "t_keep", "keep");
    const logA = logRow(s, a.id);
    const logK = logRow(s, k.id);

    expect(s.threads.erase("t_del")).toBe(true);
    expect(s.offers.get(a.id)).toBeUndefined();
    expect(s.offers.get(b.id)).toBeUndefined();
    expect(s.offers.list({ status: ["pending"] }).map((o) => o.id)).toEqual([k.id]);
    expect(s.proactiveLog.get(logA)?.offerId).toBeNull();
    expect(s.proactiveLog.get(logK)?.offerId).toBe(k.id);
    maintain(s.db, new Date());
    const bytes = readFileSync(path).toString("latin1");
    expect(bytes).not.toContain(`${M}-a-`);
    expect(bytes).not.toContain(`${M}-b-`);
    expect(bytes).toContain(`${M}-keep-text`);
    s.close();
  });

  it("a backup taken before the delete loses the cards too", () => {
    const path = tmpDb();
    const s = openStore(path);
    s.threads.create("t_del", "gone");
    card(s, "t_del", "bk");
    backupNow(s.db, path, new Date());
    s.threads.erase("t_del");
    s.close();
    const [file] = listBackups(path);
    expect(file).toBeDefined();
    expect(readFileSync(file?.file as string).toString("latin1")).toContain(`${M}-bk-text`);
    const r = scrubBackupFile(file?.file as string, ["t_del"], new Date());
    expect(r.ok).toBe(true);
    expect(readFileSync(file?.file as string).toString("latin1")).not.toContain(`${M}-bk-`);
  });
});

describe("decided offers are pruned after OFFERS_KEEP_DAYS", () => {
  it("deletes old decided cards, keeps pending and recent ones, unlinks the log", () => {
    const s = openStore(":memory:");
    const old = new Date(Date.now() - (OFFERS_KEEP_DAYS + 5) * DAY);
    const oldDecided = card(s, null, "od", old);
    s.offers.decide(oldDecided.id, "ignored", old);
    const oldPending = card(s, null, "op", old);
    const recent = card(s, null, "rd");
    s.offers.decide(recent.id, "accepted");
    const log = logRow(s, oldDecided.id);

    const out = pruneRetention(s.db, new Date());
    expect(out.offers).toBe(1);
    expect(s.offers.get(oldDecided.id)).toBeUndefined();
    expect(s.offers.get(oldPending.id)?.status).toBe("pending");
    expect(s.offers.get(recent.id)?.status).toBe("accepted");
    expect(s.proactiveLog.get(log)?.offerId).toBeNull();
    expect(pruneRetention(s.db, new Date()).offers).toBeUndefined();
    s.close();
  });

  it("works in small batches", () => {
    const s = openStore(":memory:");
    const old = new Date(Date.now() - (OFFERS_KEEP_DAYS + 1) * DAY);
    for (let i = 0; i < 7; i++) s.offers.decide(card(s, null, `x${i}`, old).id, "expired", old);
    expect(pruneDecidedOffers(s.db, new Date(Date.now() - OFFERS_KEEP_DAYS * DAY), BatchSizer.fixed(3))).toBe(
      7,
    );
    expect(s.offers.list({}).length).toBe(0);
    s.close();
  });
});
