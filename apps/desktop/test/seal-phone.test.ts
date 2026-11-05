import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedEngine, streamText } from "@alca/engines";
import { generateIdentity, LinkClient, pairDevice } from "@alca/link";
import type { AlcaEvent } from "@alca/protocol";
import { startRendezvous } from "@alca/rendezvous";
import { isSealedText, sealStatus } from "@alca/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DesktopApp, startDesktop } from "../src/index.ts";

/**
 * Next round R7.9 integration (Phase F2): a paired phone reads the same
 * conversation before and after the background seal pass — a conversation
 * written before the data key existed (plaintext rows) and one written
 * through the phone after it (sealed as written). The rows on disk change;
 * what the phone gets does not.
 */

vi.setConfig({ testTimeout: 40_000 });

const MARK = "OKAPI-F2-PHONE-5521";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const until = async (f: () => boolean, ms = 8000, what = "condition") => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

async function boot() {
  const relay = await startRendezvous({ port: 0 });
  const dir = mkdtempSync(join(tmpdir(), "alca-seal-phone-"));
  const app: DesktopApp = await startDesktop({
    engine: "demo",
    dataDir: dir,
    port: 0,
    agents: "direct",
    browser: "off",
    engineOverride: new ScriptedEngine(() => streamText(`${MARK} 回覆：今天晴天，記得帶水。`, 4)),
    rendezvous: relay.url,
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => relay.close(),
    () => app.close(),
  );
  const pair = await fetch(`${app.server.url}/api/link/pairings`, {
    method: "POST",
    headers: { authorization: `Bearer ${app.token}`, ...app.uiHeaders, "content-type": "application/json" },
    body: "{}",
  });
  const p = (await pair.json()) as Record<string, string>;
  const identity = await generateIdentity();
  const creds = await pairDevice({
    relayUrl: relay.url,
    code: String(p.display),
    identity,
    device: { name: "測試 iPhone", kind: "phone", platform: "headless" },
    expectFingerprint: String(p.coreFingerprint),
  });
  const client = new LinkClient({
    credentials: creds,
    identity,
    pingSec: 0,
    backoff: { first: 50, max: 300 },
  });
  const events: AlcaEvent[] = [];
  client.onEvent((ch, e) => {
    if (ch === "alca") events.push(e as AlcaEvent);
  });
  client.start();
  cleanups.push(() => client.stop());
  await until(() => client.status === "online", 8000, "phone online");
  return { app, client, events };
}

/** What the phone shows of a thread: its messages and every stored event of its runs. */
async function read(b: Awaited<ReturnType<typeof boot>>, threadId: string) {
  const got = await b.client.request<{ messages: Array<Record<string, unknown>> }>("threads.get", {
    threadId,
  });
  const runs = [
    ...new Set(got.messages.map((m) => m.runId).filter((r): r is string => typeof r === "string")),
  ];
  return {
    messages: got.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, runId: m.runId })),
    events: runs.map((r) => b.app.core.runEvents(r)),
  };
}

describe("a paired phone across the seal pass (R7.9)", () => {
  it("reads the same conversation before and after the pass", async () => {
    const b = await boot();
    const s = b.app.core.store;
    expect(s.sealer).toBeDefined();

    // A conversation from before the data key: plaintext rows, a run with a streamed reply.
    const at = new Date(Date.now() - 3_600_000).toISOString();
    const ins = (sql: string, ...a: Array<string | number>) => s.db.prepare(sql).run(...a);
    ins("INSERT INTO threads (id, title, created_at, updated_at) VALUES ('thr_old', '舊對話', ?, ?)", at, at);
    ins(
      `INSERT INTO runs (id, thread_id, initiator_kind, initiator_id, started_at, status, finish_reason, finished_at)
       VALUES ('run_old', 'thr_old', 'user', 'local', ?, 'finished', 'completed', ?)`,
      at,
      at,
    );
    ins(
      "INSERT INTO messages (id, thread_id, run_id, role, content, created_at) VALUES ('msg_q', 'thr_old', 'run_old', 'user', ?, ?)",
      `${MARK} 舊的問題`,
      at,
    );
    ins(
      "INSERT INTO messages (id, thread_id, run_id, role, content, created_at) VALUES ('msg_a', 'thr_old', 'run_old', 'assistant', ?, ?)",
      `${MARK} 舊的回答`,
      at,
    );
    const evs = ["run.started", "message.delta", "message.delta", "message.completed", "run.finished"];
    evs.forEach((type, seq) => {
      const data = type === "message.delta" ? { delta: `${MARK}-${seq}` } : { n: seq };
      const payload = JSON.stringify({
        v: 1,
        type,
        seq,
        runId: "run_old",
        threadId: "thr_old",
        ts: at,
        data,
      });
      ins(
        "INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES ('run_old', ?, ?, ?, ?)",
        seq,
        type,
        payload,
        at,
      );
    });

    // A conversation through the phone after the key: sealed as it is written.
    const t = await b.client.request<{ id: string }>("threads.create", { title: "新對話" });
    await b.client.request("watch.thread", { threadId: t.id });
    const r = await b.client.request<{ runId: string }>("threads.send", {
      threadId: t.id,
      text: `${MARK} 天氣？`,
    });
    await until(() => b.events.some((e) => e.runId === r.runId && e.type === "run.finished"), 8000, "reply");

    const before = { old: await read(b, "thr_old"), fresh: await read(b, t.id) };
    expect(before.old.messages.map((m) => m.content)).toEqual([`${MARK} 舊的問題`, `${MARK} 舊的回答`]);
    expect(before.old.events[0]).toHaveLength(5);
    expect(before.fresh.messages.at(-1)?.content).toBe(`${MARK} 回覆：今天晴天，記得帶水。`);
    expect(sealStatus(s.db).remaining).toBeGreaterThan(0);

    await s.jobs.run("sealPass", null);
    expect(sealStatus(s.db).remaining).toBe(0);
    const raw = s.db
      .prepare(
        "SELECT content AS v FROM messages UNION ALL SELECT payload FROM run_events WHERE run_id IN ('run_old', ?)",
      )
      .all(r.runId) as Array<{ v: string }>;
    expect(raw.length).toBeGreaterThan(6);
    for (const x of raw) {
      expect(isSealedText(x.v)).toBe(true);
      expect(x.v).not.toContain(MARK);
    }

    const after = { old: await read(b, "thr_old"), fresh: await read(b, t.id) };
    expect(after).toEqual(before);
  });
});
