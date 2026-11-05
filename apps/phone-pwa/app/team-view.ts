// The team (P7) as the phone sees it over Link: shapes, words, and the small
// pure helpers the team screens and the chat share. Bots are created and
// edited on the computer; the phone reads the roster and the trail. Pure (no DOM).
import { t as tx } from "./i18n/index.ts";

export type BotColor = "ink" | "vermilion" | "jade" | "indigo" | "ochre" | "plum";

export interface TeamBot {
  id: string;
  name: string;
  isDefault: boolean;
  avatar: string;
  color: BotColor | null;
  role: string | null;
  instructions: string | null;
  engineId: string | null;
  model: string | null;
  approvalLevel: "autonomous" | "confirm_each_step" | "full_access" | null;
  browserProfile: "shared" | "isolated" | "isolated_keep";
  memoryMode: "team" | "own" | "off";
  isLead: boolean;
  activity: {
    workers: number;
    waiting: number;
    peersOpen: number;
    working: Array<{ kind: "worker" | "peer"; id: string; title: string; threadId: string; status: string }>;
  };
  threads: number;
}

export interface TeamView {
  bots: TeamBot[];
  rules: { peerApproval: "auto" | "ask_delegate" | "ask_all"; maxDepth: number; maxOpen: number };
  leadId: string | null;
  defaultBotId: string;
  engines: Array<{ id: string; label: string; kind: string; model?: string | null }>;
}

export type PeerStatus = "running" | "done" | "failed" | "denied" | "refused" | "stopped";

export interface PeerView {
  id: string;
  kind: "ask" | "delegate";
  fromBotId: string;
  toBotId: string;
  fromName: string;
  toName: string;
  rootThreadId: string;
  depth: number;
  text: string;
  status: PeerStatus;
  reason: string | null;
  result: string | null;
  createdAt: string;
  finishedAt: string | null;
  events?: Array<{ id: string; kind: string; detail: Record<string, unknown>; createdAt: string }>;
  messages?: Array<{ id: string; role: string; content: string; botId: string | null }>;
}

export const PEER_WORD: Record<PeerStatus, string> = {
  running: tx("common.inProgress"),
  done: tx("common.done2"),
  failed: tx("common.notFinished"),
  denied: tx("common.youDeclined"),
  refused: tx("common.notSent"),
  stopped: tx("common.stopped2"),
};

export const REFUSE_WORD: Record<string, string> = {
  loop: tx("common.wouldLoopBackToA"),
  depth: tx("common.tooManyHandOffLevels"),
  too_many: tx("common.tooManyRequestsAtOnce"),
  person_denied: tx("common.youDeclined"),
};

export const EVENT_WORD: Record<string, string> = {
  requested: tx("common.requestSent"),
  approval: tx("common.waitingForYourOk"),
  approved: tx("common.youAgreed"),
  denied: tx("common.youDeclined"),
  refused: tx("common.notSent"),
  started: tx("common.teammateStarted"),
  card: tx("common.needsYourConfirmation"),
  answered: tx("common.teammateReplied"),
  failed: tx("common.notFinished"),
  stopped: tx("common.stopped4"),
};

export const LEVEL_WORD: Record<string, string> = {
  team: tx("common.sameAsTheTeam"),
  confirm_each_step: tx("common.askEveryStep"),
  autonomous: tx("common.autonomous"),
  full_access: tx("common.fullAccess"),
};
export const BROWSER_WORD: Record<string, string> = {
  shared: tx("common.signInWithYourBrowser"),
  isolated: tx("common.separateBrowser"),
  isolated_keep: tx("phone.teamView.separateBrowserKeepSignIns"),
};
export const MEMORY_WORD: Record<string, string> = {
  team: tx("phone.teamView.sharedTeamMemory"),
  own: tx("common.ownMemoryOnly"),
  off: tx("common.noMemory"),
};
export const RULE_WORD: Record<string, string> = {
  auto: tx("phone.teamView.teammatesHandOffAutomatically"),
  ask_delegate: tx("phone.teamView.askYouBeforeHandOffs"),
  ask_all: tx("phone.teamView.askYouBeforeQuestionsAnd"),
};

/** What a bot is doing, in one line, and whether it waits for the person. */
export function nowLine(b: TeamBot): { text: string; state: "idle" | "busy" | "waiting" } {
  const a = b.activity;
  const now = a.working[0];
  if (!now && !a.waiting) return { text: tx("common.idleReadyForNewWork"), state: "idle" };
  const what = now
    ? tx("common.text6", {
        p0: now.kind === "peer" ? tx("common.teammateHandOff") : tx("common.worker2"),
        title: now.title,
      })
    : tx("common.working");
  return a.waiting
    ? { text: tx("phone.teamView.waitingOnYou", { what }), state: "waiting" }
    : { text: what, state: "busy" };
}

/** `@name …` at the start of a message (longest name wins), as the core reads it. */
export function mentionOf(text: string, bots: readonly TeamBot[]): TeamBot | undefined {
  const t = text.trimStart();
  if (!t.startsWith("@") && !t.startsWith("＠")) return undefined;
  const rest = t.slice(1).toLowerCase();
  return bots
    .filter((b) => {
      const n = b.name.toLowerCase();
      if (!rest.startsWith(n)) return false;
      const next = rest.charAt(n.length);
      return next === "" || /[\s,，:：、!！?？。.]/.test(next);
    })
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/** The @ being typed at the start of the composer (caret at its end), or undefined. */
export function mentionQuery(value: string, caret: number): string | undefined {
  const m = /^\s*[@＠]([^\s@＠]*)$/.exec(value.slice(0, caret));
  return m ? (m[1] ?? "") : undefined;
}

/** A system message in a teammate's conversation, as a person reads it. */
export function systemLine(content: string): { label: string; text: string } | null {
  const head = content.split("\n")[0] ?? "";
  const inner = (tag: string) => {
    const m = content.match(new RegExp(`<alca:${tag}[^>]*>\\n?([\\s\\S]*?)\\n?</alca:${tag}>`));
    return (m?.[1] ?? "").split("\n").filter((l) => l.trim());
  };
  if (head.startsWith("<alca:peer ")) {
    const kind = /kind="([^"]*)"/.exec(head)?.[1];
    return {
      label: kind === "ask" ? tx("phone.teamView.asked") : tx("phone.teamView.handedOff"),
      text: inner("peer").join(" "),
    };
  }
  if (head.startsWith("<alca:worker")) {
    const body = inner("worker")
      .filter((l) => !l.startsWith("相鄰：") && !l.startsWith("全文："))
      .map((l) =>
        l
          .replace(/^結果摘要（全文 \d+ 字(，未放進這裡)?）：/, "")
          .replace(/^停止原因：(.*)$/, (_m, why: string) => tx("phone.teamView.stoppedBecause", { why })),
      )
      .join(" ");
    return { label: tx("phone.teamView.workerReport"), text: body };
  }
  if (head.startsWith("<alca:peer-report")) {
    const bot = /bot="([^"]*)"/.exec(head)?.[1] ?? tx("common.teammate");
    return { label: tx("phone.teamView.replied", { bot }), text: inner("peer-report").join(" ") };
  }
  return null;
}
