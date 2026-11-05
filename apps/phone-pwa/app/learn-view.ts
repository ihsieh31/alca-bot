// The 記憶與技能 view types and pure helpers (no DOM, so they are unit-tested in Node).
import { t } from "./i18n/index.ts";

export interface MemoryItem {
  id: string;
  botId: string;
  scope: "shared" | "bot";
  kind: "fact" | "preference" | "person" | "project";
  body: string;
  quote: string | null;
  origin: "user" | "inferred";
  confidence: number;
  source: { kind: string; threadId: string | null; threadTitle: string | null; workerTitle: string | null };
  edited: boolean;
  versions: number;
  uses: number;
  lastUsedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryList {
  botId: string;
  items: MemoryItem[];
  counts: Record<string, number>;
  forgotten: number;
}

export interface SkillVersionView {
  version: number;
  name: string;
  description: string;
  triggers: string[];
  steps: Array<{ text: string; tool?: string; actionClass?: string }>;
  actionClasses: string[];
  alwaysConfirm: string[];
  note: string | null;
}

export interface SkillView {
  id: string;
  botId: string;
  botName: string;
  status: "proposed" | "active" | "disabled" | "rejected";
  version: number;
  current: SkillVersionView | null;
  pending: SkillVersionView | null;
  uses: number;
  lastUsedAt: string | null;
  source: { threadId: string | null; threadTitle: string | null };
  updatedAt: string;
}

/** The five action classes Alca always confirms, whatever the trust level or a saved skill says. */
export const ALWAYS = new Set(["payment", "send", "delete", "publish"]);

/** A filter chip + the search box → the `memory.list` arguments. */
export function memoryQuery(filter: string, query: string): { q?: string; kind?: string; origin?: string } {
  const q: { q?: string; kind?: string; origin?: string } = {};
  const text = query.trim();
  if (text) q.q = text.slice(0, 200);
  if (filter === "user" || filter === "inferred") q.origin = filter;
  else if (filter) q.kind = filter;
  return q;
}

/** Who said it: 「你說的」 / 「推測，尚未確認」 (the percentage lives in 技術細節), and 已編輯. */
export function memoryWho(m: MemoryItem): string {
  const who = m.origin === "user" ? t("common.youSaid") : t("phone.learnView.unconfirmed");
  return m.edited ? t("phone.learnView.whoEdited", { who }) : who;
}

/** Where it was learned: 從「對話」 / 你手動加的 / 任務「…」 (or nothing). */
export function memorySource(m: MemoryItem): string {
  if (m.source.threadTitle) return t("phone.learnView.from", { threadTitle: m.source.threadTitle });
  if (m.source.kind === "ui") return t("phone.learnView.addedByYou");
  if (m.source.workerTitle) return t("phone.learnView.worker", { workerTitle: m.source.workerTitle });
  return "";
}

/** The source as a value (the conversation's or task's own name). */
export function memorySourceName(m: MemoryItem): string {
  if (m.source.threadTitle) return m.source.threadTitle;
  if (m.source.kind === "ui") return t("phone.learnView.addedByYou");
  return m.source.workerTitle ?? "";
}

/** A memory row's one secondary line (§4.1): unconfirmed first, else where it came from. */
export function memorySubtitle(m: MemoryItem): string {
  if (m.origin === "inferred") return t("phone.learnView.unconfirmed");
  return memorySource(m) || t("common.youSaid");
}

/** Both on one line (export, accessibility label). */
export function memoryMeta(m: MemoryItem): string {
  const from = memorySource(m);
  return from ? t("phone.learnView.meta", { who: memoryWho(m), from }) : memoryWho(m);
}

/**
 * Which steps carry the red 一律確認 marker: a step whose action class is in
 * the version's always-confirm list (falling back to the fixed set, so a
 * payment step is marked even if a stale server left the list empty).
 */
export function markedSteps(v: SkillVersionView): number[] {
  const always = new Set(
    v.alwaysConfirm.length ? v.alwaysConfirm : v.actionClasses.filter((c) => ALWAYS.has(c)),
  );
  const out: number[] = [];
  v.steps.forEach((s, i) => {
    if (s.actionClass && (always.has(s.actionClass) || ALWAYS.has(s.actionClass))) out.push(i);
  });
  return out;
}

/** The always-confirm classes a version touches (badges on the sheet and the rows). */
export function confirmClasses(v: SkillVersionView): string[] {
  const set = new Set([
    ...v.alwaysConfirm,
    ...v.steps.map((s) => s.actionClass ?? "").filter((c) => ALWAYS.has(c)),
  ]);
  return [...set];
}

/** The second line of a skill row. */
export function skillMeta(sk: SkillView, agoText: string): string {
  const v = sk.pending && sk.version === 0 ? sk.pending : (sk.current ?? sk.pending);
  if (!v) return "";
  if (sk.pending)
    return sk.version > 0
      ? t("phone.learnView.updateWaitingForYouV", { version: sk.version, version2: sk.pending.version })
      : t("phone.learnView.stepsWaitingOnYou", { stepsCount: v.steps.length });
  return t("phone.learnView.steps", {
    stepsCount: v.steps.length,
    p1: sk.uses ? t("phone.learnView.usedTimes", { uses: sk.uses, agoText }) : t("common.notUsedYet"),
    p2: sk.status === "disabled" ? t("phone.learnView.disabled") : "",
  });
}

/**
 * Review 2026-11-04b L7: editing or forgetting a memory needs the device's
 * `approve` scope. Without it the computer refuses with `forbidden`; say why
 * and where to change it instead of a bare error.
 */
export const NO_APPROVE_MEMORY = t("phone.learnView.thisPhoneDoesntHaveApproval");

export function memoryChangeError(e: unknown, fallback: string): string {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  if (code === "forbidden") return NO_APPROVE_MEMORY;
  return e instanceof Error && e.message ? e.message : fallback;
}
