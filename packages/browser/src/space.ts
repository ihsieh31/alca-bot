import type { ActionClass } from "@alca/policy";
import type { ActorT, BrowserActionKindT, SpaceStateT } from "@alca/protocol";
import type { Cdp } from "./cdp/connection.ts";
import type { TabDriver } from "./page.ts";

/** Errors the host raises to agents; messages are written for the model to act on. */
export class SpaceOwnershipError extends Error {
  constructor(spaceId: string) {
    super(`Space ${spaceId} 不屬於這個 bot，不能操作。`);
    this.name = "SpaceOwnershipError";
  }
}
export class SpaceNotFoundError extends Error {
  constructor(id: string) {
    super(`找不到 Space ${id}`);
    this.name = "SpaceNotFoundError";
  }
}
export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}

/** A launched browser the host can drive (real Chromium or a test fake). */
export interface BrowserProcessLike {
  cdp: Cdp;
  close(): Promise<void>;
}

/** Where Space records are kept (the store's BotRepo satisfies this). */
export interface SpaceRecordStore {
  openSpace(
    s: {
      id: string;
      botId: string;
      threadId: string | null;
      workerId?: string | null;
      title: string;
      profile: "shared" | "isolated";
      persistent: boolean;
    },
    now?: Date,
  ): unknown;
  closeSpace(id: string, now?: Date): void;
}

export interface TabEntry {
  tabId: string;
  targetId: string;
  driver: TabDriver;
}

export interface LastAction {
  kind: BrowserActionKindT;
  label: string;
  ok: boolean;
  at: string;
}

/** Host-side state of one Space. Never handed to agents directly. */
export interface SpaceInternal {
  spaceId: string;
  botId: string;
  threadId?: string;
  workerId?: string;
  title: string;
  profile: "shared" | "isolated";
  persistent: boolean;
  controller: "agent" | "user";
  status: SpaceStateT["status"];
  handoffReason?: string;
  lastAction?: LastAction;
  /** The browser process that holds this Space's tabs (shared, or its own for persistent isolation). */
  proc: BrowserProcessLike;
  ownsProcess: boolean;
  browserContextId?: string;
  tabs: TabEntry[];
  activeTabId?: string;
  /** Agent commands wait here while a person drives the Space. */
  waiters: Array<() => void>;
  /** One agent command at a time per Space. */
  chain: Promise<unknown>;
  /** Agent steps that succeeded, as a replayable script. */
  recording: RecordedStep[];
  closed: boolean;
  /** Vault values filled into this Space: every output that leaves it is redacted with them. */
  secrets?: Set<string>;
}

/** A recorded step uses role + name locators, so it can be replayed on a fresh page. */
export type RecordedStep = Record<string, unknown> & { do: string };

export function publicState(s: SpaceInternal): SpaceStateT {
  return {
    spaceId: s.spaceId,
    botId: s.botId,
    title: s.title,
    ...(s.threadId ? { threadId: s.threadId } : {}),
    ...(s.workerId ? { workerId: s.workerId } : {}),
    profile: s.profile,
    persistent: s.persistent,
    controller: s.controller,
    status: s.status,
    tabs: s.tabs.map((t) => ({
      tabId: t.tabId,
      title: t.driver.title || t.driver.url || "新分頁",
      url: t.driver.url,
      loading: t.driver.isLoading,
    })),
    ...(s.activeTabId ? { activeTabId: s.activeTabId } : {}),
    ...(s.lastAction ? { lastAction: s.lastAction } : {}),
    ...(s.handoffReason ? { handoffReason: s.handoffReason } : {}),
  };
}

export interface ControlChange {
  space: SpaceStateT;
  controller: "agent" | "user";
  by: ActorT;
  reason: string;
}

export interface GateNote {
  actionClass: ActionClass;
  summary: string;
}
