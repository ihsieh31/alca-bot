import type { DatabaseSync } from "node:sqlite";
import { atomic } from "../db.ts";
import { newStoreId } from "../ids.ts";

export type SkillStatus = "proposed" | "active" | "disabled" | "rejected";

/** One step of a playbook: what to do in words, and the host tool it used when it was learned. */
export interface SkillStep {
  text: string;
  tool?: string;
  /** Arguments as learned (secrets already redacted; page refs dropped). */
  args?: Record<string, unknown>;
  actionClass?: string;
}

export interface SkillContent {
  name: string;
  description: string;
  triggers: string[];
  steps: SkillStep[];
  actionClasses: string[];
}

export interface SkillVersion extends SkillContent {
  skillId: string;
  version: number;
  state: "proposed" | "approved" | "rejected";
  author: "agent" | "user";
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface SkillRecord {
  id: string;
  botId: string;
  status: SkillStatus;
  /** Approved version in use; 0 = never approved. */
  version: number;
  sourceThreadId: string | null;
  sourceWorkerId: string | null;
  sourceRunId: string | null;
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The approved version in use. */
  current: SkillVersion | undefined;
  /** The newest version waiting for the person. */
  pending: SkillVersion | undefined;
}

interface SkillRow {
  id: string;
  bot_id: string;
  status: SkillStatus;
  version: number;
  source_thread_id: string | null;
  source_worker_id: string | null;
  source_run_id: string | null;
  uses: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  skill_id: string;
  version: number;
  name: string;
  description: string;
  triggers: string;
  steps: string;
  action_classes: string;
  state: SkillVersion["state"];
  author: SkillVersion["author"];
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

const version = (r: VersionRow): SkillVersion => ({
  skillId: r.skill_id,
  version: r.version,
  name: r.name,
  description: r.description,
  triggers: JSON.parse(r.triggers) as string[],
  steps: JSON.parse(r.steps) as SkillStep[],
  actionClasses: JSON.parse(r.action_classes) as string[],
  state: r.state,
  author: r.author,
  note: r.note,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export interface SkillProposal extends SkillContent {
  botId: string;
  sourceThreadId?: string | null;
  sourceWorkerId?: string | null;
  sourceRunId?: string | null;
  author?: "agent" | "user";
  note?: string | null;
}

/**
 * Skills (migration 6): a playbook is saved only after the person approves
 * it. Every change is a new version (append-only); an edit by the person is
 * approved by being made. Statuses: proposed (never approved), active,
 * disabled, rejected.
 */
export class SkillRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private row(id: string): SkillRow | undefined {
    return this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
  }

  private build(r: SkillRow): SkillRecord {
    const vs = this.versions(r.id);
    const pending = [...vs].reverse().find((v) => v.state === "proposed");
    return {
      id: r.id,
      botId: r.bot_id,
      status: r.status,
      version: r.version,
      sourceThreadId: r.source_thread_id,
      sourceWorkerId: r.source_worker_id,
      sourceRunId: r.source_run_id,
      uses: r.uses,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      current: vs.find((v) => v.version === r.version && v.state === "approved"),
      pending,
    };
  }

  get(id: string): SkillRecord | undefined {
    const r = this.row(id);
    return r ? this.build(r) : undefined;
  }

  list(q: { botId?: string; status?: readonly SkillStatus[] } = {}): SkillRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    if (q.botId) {
      where.push("bot_id = ?");
      params.push(q.botId);
    }
    if (q.status?.length) {
      where.push(`status IN (${q.status.map(() => "?").join(",")})`);
      params.push(...q.status);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM skills ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, n DESC`,
      )
      .all(...params) as unknown as SkillRow[];
    return rows.map((r) => this.build(r));
  }

  versions(skillId: string): SkillVersion[] {
    const rows = this.db
      .prepare("SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version")
      .all(skillId) as unknown as VersionRow[];
    return rows.map(version);
  }

  private insertVersion(
    skillId: string,
    v: number,
    c: SkillContent,
    state: SkillVersion["state"],
    author: SkillVersion["author"],
    note: string | null,
    ts: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO skill_versions (skill_id, version, name, description, triggers, steps, action_classes,
           state, author, note, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        skillId,
        v,
        c.name.slice(0, 80),
        c.description,
        JSON.stringify(c.triggers),
        JSON.stringify(c.steps),
        JSON.stringify([...new Set(c.actionClasses)].sort()),
        state,
        author,
        note,
        ts,
        state === "proposed" ? null : ts,
      );
  }

  /** A new skill, waiting for the person (status proposed, version 1 proposed). */
  propose(p: SkillProposal, now = new Date()): SkillRecord {
    const id = newStoreId("skl", now.getTime());
    const ts = now.toISOString();
    atomic(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO skills (id, bot_id, status, version, source_thread_id, source_worker_id, source_run_id,
             created_at, updated_at) VALUES (?, ?, 'proposed', 0, ?, ?, ?, ?, ?)`,
        )
        .run(id, p.botId, p.sourceThreadId ?? null, p.sourceWorkerId ?? null, p.sourceRunId ?? null, ts, ts);
      this.insertVersion(id, 1, p, "proposed", p.author ?? "agent", p.note ?? null, ts);
    });
    return this.get(id) as SkillRecord;
  }

  private nextVersion(skillId: string): number {
    const r = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM skill_versions WHERE skill_id = ?")
      .get(skillId) as { v: number };
    return r.v + 1;
  }

  /** A revision proposed by Alca (e.g. after the person corrected how it was done). */
  proposeRevision(
    skillId: string,
    c: SkillContent,
    note: string | null,
    now = new Date(),
  ): SkillVersion | undefined {
    if (!this.row(skillId)) return undefined;
    const ts = now.toISOString();
    const v = this.nextVersion(skillId);
    atomic(this.db, () => {
      this.insertVersion(skillId, v, c, "proposed", "agent", note, ts);
      this.db.prepare("UPDATE skills SET updated_at = ? WHERE id = ?").run(ts, skillId);
    });
    return this.versions(skillId).find((x) => x.version === v);
  }

  /** The person approves a proposed version (default: the newest one). */
  approve(skillId: string, v?: number, now = new Date()): SkillRecord | undefined {
    const s = this.get(skillId);
    if (!s) return undefined;
    const target = v ?? s.pending?.version;
    if (!target) return s;
    const ts = now.toISOString();
    atomic(this.db, () => {
      const r = this.db
        .prepare(
          "UPDATE skill_versions SET state = 'approved', decided_at = ? WHERE skill_id = ? AND version = ? AND state = 'proposed'",
        )
        .run(ts, skillId, target);
      if (Number(r.changes) === 0) return;
      // Older proposals are settled by the newer approval.
      this.db
        .prepare(
          "UPDATE skill_versions SET state = 'rejected', decided_at = ? WHERE skill_id = ? AND version < ? AND state = 'proposed'",
        )
        .run(ts, skillId, target);
      const status = s.status === "disabled" ? "disabled" : "active";
      this.db
        .prepare("UPDATE skills SET status = ?, version = ?, updated_at = ? WHERE id = ?")
        .run(status, target, ts, skillId);
    });
    return this.get(skillId);
  }

  /** The person turns a proposal down. A never-approved skill becomes `rejected`. */
  reject(skillId: string, v?: number, now = new Date()): SkillRecord | undefined {
    const s = this.get(skillId);
    if (!s) return undefined;
    const target = v ?? s.pending?.version;
    const ts = now.toISOString();
    atomic(this.db, () => {
      if (target)
        this.db
          .prepare(
            "UPDATE skill_versions SET state = 'rejected', decided_at = ? WHERE skill_id = ? AND version = ? AND state = 'proposed'",
          )
          .run(ts, skillId, target);
      if (s.version === 0)
        this.db
          .prepare("UPDATE skills SET status = 'rejected', updated_at = ? WHERE id = ?")
          .run(ts, skillId);
      else this.db.prepare("UPDATE skills SET updated_at = ? WHERE id = ?").run(ts, skillId);
    });
    return this.get(skillId);
  }

  /** An edit by the person: a new version, approved by being made. Pending proposals are settled. */
  edit(skillId: string, c: SkillContent, now = new Date()): SkillRecord | undefined {
    const s = this.get(skillId);
    if (!s) return undefined;
    const ts = now.toISOString();
    const v = this.nextVersion(skillId);
    atomic(this.db, () => {
      this.db
        .prepare(
          "UPDATE skill_versions SET state = 'rejected', decided_at = ? WHERE skill_id = ? AND state = 'proposed'",
        )
        .run(ts, skillId);
      this.insertVersion(skillId, v, c, "approved", "user", null, ts);
      const status = s.status === "disabled" ? "disabled" : "active";
      this.db
        .prepare("UPDATE skills SET status = ?, version = ?, updated_at = ? WHERE id = ?")
        .run(status, v, ts, skillId);
    });
    return this.get(skillId);
  }

  setEnabled(skillId: string, enabled: boolean, now = new Date()): SkillRecord | undefined {
    const s = this.get(skillId);
    if (!s || s.version === 0) return s;
    this.db
      .prepare("UPDATE skills SET status = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? "active" : "disabled", now.toISOString(), skillId);
    return this.get(skillId);
  }

  used(skillId: string, now = new Date()): void {
    this.db
      .prepare("UPDATE skills SET uses = uses + 1, last_used_at = ? WHERE id = ?")
      .run(now.toISOString(), skillId);
  }

  /** The person deletes a skill: every version goes. */
  delete(skillId: string): boolean {
    return atomic(this.db, () => {
      this.db.prepare("DELETE FROM skill_versions WHERE skill_id = ?").run(skillId);
      return Number(this.db.prepare("DELETE FROM skills WHERE id = ?").run(skillId).changes) > 0;
    });
  }
}
