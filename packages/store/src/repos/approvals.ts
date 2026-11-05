import type { DatabaseSync } from "node:sqlite";
import { openValue, sealValue } from "../seal.ts";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRecord {
  id: string;
  runId: string | null;
  callId: string | null;
  actionClass: string;
  summary: string;
  detail: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt: string | null;
  resolvedAt: string | null;
  resolvedBy: { kind: string; id: string } | null;
  /** Bot whose action this card is about. */
  botId: string | null;
  /** Worker session whose tool call this is (P3). */
  workerId: string | null;
}

interface ApprovalRow {
  id: string;
  run_id: string | null;
  call_id: string | null;
  action_class: string;
  summary: string;
  detail: string;
  status: ApprovalStatus;
  requested_at: string;
  expires_at: string | null;
  resolved_at: string | null;
  resolved_by_kind: string | null;
  resolved_by_id: string | null;
  bot_id?: string | null;
  worker_id?: string | null;
}

const approval = (db: DatabaseSync, r: ApprovalRow): ApprovalRecord => ({
  id: r.id,
  runId: r.run_id,
  callId: r.call_id,
  actionClass: r.action_class,
  summary: openValue(db, "approvals", "summary", r.id, r.summary),
  detail: JSON.parse(r.detail) as Record<string, unknown>,
  status: r.status,
  requestedAt: r.requested_at,
  expiresAt: r.expires_at,
  resolvedAt: r.resolved_at,
  resolvedBy:
    r.resolved_by_kind && r.resolved_by_id ? { kind: r.resolved_by_kind, id: r.resolved_by_id } : null,
  botId: r.bot_id ?? null,
  workerId: r.worker_id ?? null,
});

export type QuestionStatus = "pending" | "answered" | "expired";

export interface QuestionRecord {
  id: string;
  runId: string | null;
  prompt: string;
  choices: string[] | null;
  status: QuestionStatus;
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
}

interface QuestionRow {
  id: string;
  run_id: string | null;
  prompt: string;
  choices: string | null;
  status: QuestionStatus;
  answer: string | null;
  asked_at: string;
  answered_at: string | null;
}

const question = (r: QuestionRow): QuestionRecord => ({
  id: r.id,
  runId: r.run_id,
  prompt: r.prompt,
  choices: r.choices ? (JSON.parse(r.choices) as string[]) : null,
  status: r.status,
  answer: r.answer,
  askedAt: r.asked_at,
  answeredAt: r.answered_at,
});

/**
 * Approval and question cards. Both are resolved at most once: the update
 * only touches a pending row, and a trigger refuses any change afterwards.
 */
export class HumanInputRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  requestApproval(
    a: Pick<ApprovalRecord, "id" | "runId" | "callId" | "actionClass" | "summary"> & {
      detail?: Record<string, unknown>;
      expiresAt?: string;
      botId?: string;
      workerId?: string;
    },
    now = new Date(),
  ): ApprovalRecord {
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, call_id, action_class, summary, detail, requested_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.runId,
        a.callId,
        a.actionClass,
        sealValue(this.db, "approvals", "summary", a.id, a.summary),
        JSON.stringify(a.detail ?? {}),
        now.toISOString(),
        a.expiresAt ?? null,
      );
    if (a.botId) this.db.prepare("UPDATE approvals SET bot_id = ? WHERE id = ?").run(a.botId, a.id);
    if (a.workerId) this.db.prepare("UPDATE approvals SET worker_id = ? WHERE id = ?").run(a.workerId, a.id);
    return this.approval(a.id) as ApprovalRecord;
  }

  approval(id: string): ApprovalRecord | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    return r ? approval(this.db, r) : undefined;
  }

  pendingApprovals(runId?: string): ApprovalRecord[] {
    const rows = (runId
      ? this.db
          .prepare("SELECT * FROM approvals WHERE status = 'pending' AND run_id = ? ORDER BY requested_at")
          .all(runId)
      : this.db
          .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at")
          .all()) as unknown as ApprovalRow[];
    return rows.map((r) => approval(this.db, r));
  }

  /** Returns false when the approval was already resolved (or does not exist). */
  resolveApproval(
    id: string,
    status: Exclude<ApprovalStatus, "pending">,
    by: { kind: string; id: string },
    now = new Date(),
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE approvals SET status = ?, resolved_at = ?, resolved_by_kind = ?, resolved_by_id = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, now.toISOString(), by.kind, by.id, id);
    return Number(r.changes) === 1;
  }

  askQuestion(
    q: Pick<QuestionRecord, "id" | "runId" | "prompt"> & { choices?: string[] },
    now = new Date(),
  ): QuestionRecord {
    this.db
      .prepare("INSERT INTO questions (id, run_id, prompt, choices, asked_at) VALUES (?, ?, ?, ?, ?)")
      .run(q.id, q.runId, q.prompt, q.choices ? JSON.stringify(q.choices) : null, now.toISOString());
    return this.question(q.id) as QuestionRecord;
  }

  question(id: string): QuestionRecord | undefined {
    const r = this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as QuestionRow | undefined;
    return r ? question(r) : undefined;
  }

  pendingQuestions(runId?: string): QuestionRecord[] {
    const rows = (runId
      ? this.db
          .prepare("SELECT * FROM questions WHERE status = 'pending' AND run_id = ? ORDER BY asked_at")
          .all(runId)
      : this.db
          .prepare("SELECT * FROM questions WHERE status = 'pending' ORDER BY asked_at")
          .all()) as unknown as QuestionRow[];
    return rows.map(question);
  }

  /** Returns false when the question was already answered or expired. */
  answerQuestion(id: string, answer: string, now = new Date()): boolean {
    const r = this.db
      .prepare(
        "UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(answer, now.toISOString(), id);
    return Number(r.changes) === 1;
  }

  expireQuestion(id: string, now = new Date()): boolean {
    const r = this.db
      .prepare("UPDATE questions SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'pending'")
      .run(now.toISOString(), id);
    return Number(r.changes) === 1;
  }
}
