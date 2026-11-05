// Memory + learning (P5): the write path (commands, rule extraction, secret
// filter, tombstones), the read path (budgeted recall, hybrid search) and
// skills (drafted after a task, saved only when the person approves).

export * from "./applies.ts";
export * from "./embedding.ts";
export * from "./extract.ts";
export * from "./life.ts";
export * from "./model-extract.ts";
export * from "./redact.ts";
export * from "./service.ts";
export * from "./skills.ts";
export * from "./tombstone.ts";

/** A reply may bring up at most `max` past items unprompted; the rest stay silent. */
export function limitMentions<T>(ranked: readonly T[], max = 1): T[] {
  return ranked.slice(0, Math.max(0, max));
}

export interface NeverLearnRule {
  pattern: string;
  addedAt: string;
  reason: string;
}

/** True when a candidate note matches any never-learn rule (case-insensitive substring). */
export function isBlockedByNeverLearn(body: string, rules: readonly NeverLearnRule[]): boolean {
  const b = body.toLowerCase();
  return rules.some((r) => r.pattern.trim() !== "" && b.includes(r.pattern.toLowerCase()));
}
