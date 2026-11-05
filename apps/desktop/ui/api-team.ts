// The team (P7) over the loopback API: bots, the lead, team rules, model
// services and the bot-to-bot trail. A key for a model service goes in once
// and never comes back.
import type { Api } from "./api.ts";
import { t } from "./i18n/index.ts";

export type BotColor = "ink" | "vermilion" | "jade" | "indigo" | "ochre" | "plum";
export type Level = "autonomous" | "confirm_each_step" | "full_access";

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
  approvalLevel: Level | null;
  browserProfile: "shared" | "isolated" | "isolated_keep";
  memoryMode: "team" | "own" | "off";
  memoryExtract?: "rules" | "model";
  /** R9.6: the language of the router and worker rules. */
  language?: "auto" | "zh" | "en";
  /** P13: the bot's own folder setting, the folder it works in now, and why its setting is not used. */
  workDir?: string | null;
  workDirNow?: string;
  workDirProblem?: string;
  shellReview?: "off" | "on";
  shellReviewEngine?: string | null;
  shellReviewModel?: string | null;
  earlyWork?: "off" | "on";
  quietHours?: string | null;
  /** Plan §2.9 / Phase 6: the bot's harness settings as stored (JSON text); null = defaults. */
  harness?: string | null;
  /** Next-round §5.4: the OS sandbox setting as stored (JSON text); null = auto, network open. */
  sandbox?: string | null;
  /** This computer's sandbox, in words. */
  sandboxProbe?: { ok: boolean; kind: string; text: string };
  isLead: boolean;
  archivedAt: string | null;
  createdAt: string;
  activity: {
    workers: number;
    waiting: number;
    peersOpen: number;
    working: Array<{ kind: "worker" | "peer"; id: string; title: string; threadId: string; status: string }>;
  };
  threads: number;
}

export interface EngineChoice {
  id: string;
  label: string;
  kind: "default" | "openai" | "gemini";
  model: string | null;
  needsKey?: boolean;
}

export interface TeamRules {
  peerApproval: "auto" | "ask_delegate" | "ask_all";
  maxDepth: number;
  maxOpen: number;
}

export interface Team {
  bots: TeamBot[];
  archived: TeamBot[];
  rules: TeamRules;
  leadId: string | null;
  defaultBotId: string;
  engines: EngineChoice[];
  colors: BotColor[];
}

export type PeerStatus = "running" | "done" | "failed" | "denied" | "refused" | "stopped";

export interface PeerEvent {
  id: string;
  kind: string;
  botId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface Peer {
  id: string;
  kind: "ask" | "delegate";
  fromBotId: string;
  toBotId: string;
  fromName: string;
  toName: string;
  fromThreadId: string;
  rootThreadId: string;
  peerThreadId: string | null;
  parentId: string | null;
  depth: number;
  chain: string[];
  text: string;
  status: PeerStatus;
  reason: string | null;
  result: string | null;
  createdAt: string;
  finishedAt: string | null;
  events?: PeerEvent[];
  messages?: Array<{ id: string; role: string; content: string; botId: string | null; createdAt: string }>;
}

/** P14: one add-on as the server describes it for a bot. */
export interface AddonView {
  id: string;
  name: string;
  description: string;
  costClass: "none" | "on_use" | "proactive";
  enabled: boolean;
  settings: Record<string, unknown>;
  defaults: Record<string, unknown>;
  unmet: string[];
  usage: {
    day: string;
    runs: number;
    tokens: number;
    runCap: number | null;
    tokenCap: number | null;
    capped: boolean;
  } | null;
  notes: string[];
  /** 回覆檢查: the models it may run on (engine null = the bot's router model, the default). */
  modelChoices?: ModelChoice[];
}

export interface ModelChoice {
  engine: string | null;
  model: string | null;
  label: string;
}

export type BotInput = Partial<
  Pick<
    TeamBot,
    | "name"
    | "color"
    | "role"
    | "instructions"
    | "engineId"
    | "model"
    | "browserProfile"
    | "memoryMode"
    | "memoryExtract"
    | "language"
    | "workDir"
    | "shellReview"
    | "shellReviewEngine"
    | "shellReviewModel"
    | "earlyWork"
    | "quietHours"
  >
> & {
  avatar?: string | null;
  approvalLevel?: Level | "team" | null;
  /** Phase 6: default harness, reviewer switch and budget caps (the server merges and checks it). */
  harness?: Record<string, unknown> | null;
  /** Next-round §5.4: mode / network / extra writable folders (sent only when changed). */
  sandbox?: { mode: "auto" | "on" | "off"; network: "open" | "none"; extraWritable: string[] };
};

export function teamApi(api: Api) {
  return {
    team: () => api.call<Team>("GET", "/api/team"),
    create: (b: BotInput) => api.call<TeamBot>("POST", "/api/bots", b),
    update: (id: string, b: BotInput) => api.call<TeamBot>("PATCH", `/api/bots/${id}`, b),
    archive: (id: string) => api.call<{ ok: true }>("POST", `/api/bots/${id}/archive`, {}),
    restore: (id: string) => api.call<TeamBot>("POST", `/api/bots/${id}/restore`, {}),
    lead: (botId: string | null) => api.call<{ leadId: string | null }>("POST", "/api/team/lead", { botId }),
    rules: (r: Partial<TeamRules>) => api.call<TeamRules>("PATCH", "/api/team/rules", r),
    peers: (q: { thread?: string; bot?: string; limit?: number } = {}) => {
      const p = new URLSearchParams(
        Object.entries(q)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => [k, String(v)]),
      );
      const qs = p.toString();
      return api.call<Peer[]>("GET", `/api/peers${qs ? `?${qs}` : ""}`);
    },
    peer: (id: string) => api.call<Peer>("GET", `/api/peers/${id}`),
    stopPeer: (id: string) => api.call<{ stopped: boolean }>("POST", `/api/peers/${id}/stop`, {}),
    // P14: built-in add-ons per bot.
    addons: (botId: string) =>
      api.call<{ botId: string; addons: AddonView[] }>("GET", `/api/bots/${botId}/addons`),
    setAddon: (
      botId: string,
      addonId: string,
      patch: { enabled?: boolean; settings?: Record<string, unknown> },
    ) => api.call<AddonView>("PATCH", `/api/bots/${botId}/addons/${addonId}`, patch),
  };
}
export type TeamClient = ReturnType<typeof teamApi>;

export const PEER_WORD: Record<PeerStatus, string> = {
  running: t("common.inProgress"),
  done: t("common.done2"),
  failed: t("common.notFinished"),
  denied: t("common.youDeclined"),
  refused: t("common.notSent"),
  stopped: t("common.stopped2"),
};

export const REFUSE_WORD: Record<string, string> = {
  loop: t("common.wouldLoopBackToA"),
  depth: t("common.tooManyHandOffLevels"),
  too_many: t("common.tooManyRequestsAtOnce"),
  person_denied: t("common.youDeclined"),
};

export const LEVEL_WORD: Record<string, string> = {
  team: t("common.sameAsTheTeam"),
  confirm_each_step: t("common.askEveryStep"),
  autonomous: t("common.autonomous"),
  full_access: t("common.fullAccess"),
};
