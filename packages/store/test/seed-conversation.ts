import type { Store } from "../src/index.ts";

/**
 * Test helper (Phase F1): one conversation whose words sit in every place a
 * delete has to reach. Each copy of `marker` carries a suffix naming where it
 * is, so a failing byte search says what was left. Fake data only.
 */
export const DAY = 86_400_000;
export const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

export function botOf(s: Store): string {
  return (s.db.prepare("SELECT id FROM bots LIMIT 1").get() as { id: string }).id;
}

export function seedConversation(s: Store, t: string, marker: string, at = ago(3)): void {
  const db = s.db;
  const bot = botOf(s);
  const ins = (sql: string, ...a: Array<string | number | null>) => db.prepare(sql).run(...a);
  ins(
    "INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    t,
    `${marker}-title`,
    at,
    at,
  );
  ins(
    `INSERT INTO runs (id, thread_id, initiator_kind, initiator_id, started_at, status, finish_reason, finished_at)
     VALUES (?, ?, 'user', 'u', ?, 'finished', 'completed', ?)`,
    `${t}_r`,
    t,
    at,
    at,
  );
  ins(
    "INSERT INTO messages (id, thread_id, run_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)",
    `${t}_m1`,
    t,
    `${t}_r`,
    `${marker}-message`,
    at,
  );
  ins(
    "INSERT INTO messages (id, thread_id, run_id, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)",
    `${t}_m2`,
    t,
    `${t}_r`,
    `${marker}-reply`,
    at,
  );
  for (let i = 0; i < 5; i++)
    ins(
      "INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, 'text', ?, ?)",
      `${t}_r`,
      i,
      JSON.stringify({ text: `${marker}-event-${i}` }),
      at,
    );
  ins(
    `INSERT INTO jobs (id, kind, thread_id, status, title, input, result, created_at, updated_at)
     VALUES (?, 'turn', ?, 'succeeded', ?, ?, ?, ?, ?)`,
    `${t}_j`,
    t,
    `${marker}-jobtitle`,
    JSON.stringify({ q: `${marker}-jobinput` }),
    JSON.stringify({ a: `${marker}-jobresult` }),
    at,
    at,
  );
  ins(
    "INSERT INTO job_events (job_id, seq, type, payload, created_at) VALUES (?, 0, 'tool', ?, ?)",
    `${t}_j`,
    JSON.stringify({ out: `${marker}-jobevent` }),
    at,
  );
  ins(
    `INSERT INTO workers (id, bot_id, thread_id, job_id, title, goal, initiator_kind, initiator_id, status,
       result_mode, result_summary, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, 'user', 'u', 'succeeded', 'inline', ?, ?, ?)`,
    `${t}_w`,
    bot,
    t,
    `${t}_j`,
    `${marker}-wtitle`.slice(0, 80),
    `${marker}-goal`,
    `${marker}-wresult`,
    at,
    at,
  );
  ins(
    "INSERT INTO spills (id, bot_id, owner_kind, owner_id, title, body, chars, created_at) VALUES (?, ?, 'worker', ?, 't', ?, 9, ?)",
    `${t}_s`,
    bot,
    `${t}_w`,
    `${marker}-spill`,
    at,
  );
  ins(
    `INSERT INTO approvals (id, run_id, action_class, summary, status, requested_at, resolved_at, worker_id)
     VALUES (?, ?, 'send', ?, 'approved', ?, ?, ?)`,
    `${t}_a`,
    `${t}_r`,
    `${marker}-approval`,
    at,
    at,
    `${t}_w`,
  );
  ins(
    "INSERT INTO questions (id, run_id, prompt, status, answer, asked_at, answered_at) VALUES (?, ?, ?, 'answered', ?, ?, ?)",
    `${t}_q`,
    `${t}_r`,
    `${marker}-question`,
    `${marker}-answer`,
    at,
    at,
  );
  const ms = Date.parse(at);
  ins(
    `INSERT INTO dispatches (id, bot_id, thread_id, harness, level, status, outcome, report, created_at, updated_at, finished_at)
     VALUES (?, ?, ?, 'general', 'standard', 'settled', 'done', ?, ?, ?, ?)`,
    `${t}_d`,
    bot,
    t,
    JSON.stringify({ summary: `${marker}-report` }),
    ms,
    ms,
    ms,
  );
  ins(
    "INSERT INTO dispatch_events (dispatch_id, kind, detail, at) VALUES (?, 'note', ?, ?)",
    `${t}_d`,
    JSON.stringify({ text: `${marker}-devent` }),
    ms,
  );
  ins(
    `INSERT INTO early_work (id, bot_id, thread_id, source, title, goal, created_at, updated_at)
     VALUES (?, ?, ?, 'request', 'e', ?, ?, ?)`,
    `${t}_e`,
    bot,
    t,
    `${marker}-early`,
    at,
    at,
  );
  ins(
    `INSERT INTO drafts (id, bot_id, thread_id, kind, title, body, created_at, updated_at)
     VALUES (?, ?, ?, 'note', 'd', ?, ?, ?)`,
    `${t}_dr`,
    bot,
    t,
    `${marker}-draft`,
    at,
    at,
  );
  s.memory.add({
    botId: bot,
    scope: "bot",
    kind: "fact",
    body: `${marker}-memory`,
    origin: "inferred",
    confidence: 0.6,
    source: { kind: "chat", threadId: t, runId: `${t}_r`, messageId: `${t}_m1` },
  });
}
