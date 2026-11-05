// 資料庫 › 團隊 (§4.1 phone-team / -team-bot / -team-trail): a pushed page
// with the members (avatar glyph, name, role; 領頭 and what each is doing in
// the second line), the collaboration rules as value rows, and 交辦紀錄 as its
// own page. A member opens its page (grouped facts, add-ons, recent
// hand-offs, 〔對話〕); a hand-off opens with plain activity rows — no dots,
// no arrows. P13: with `approve` a bot can be added and edited (bot-form.ts).
import { addonList } from "./addons.ts";
import { showBotForm } from "./bot-form.ts";
import { ago, h, haptic, icon, prose } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import type { Session } from "./session.ts";
import { actionSheet, closeAll, Sheet } from "./sheet.ts";
import {
  BROWSER_WORD,
  EVENT_WORD,
  LEVEL_WORD,
  MEMORY_WORD,
  nowLine,
  PEER_WORD,
  type PeerView,
  REFUSE_WORD,
  RULE_WORD,
  systemLine,
  type TeamBot,
} from "./team-view.ts";
import { avatar } from "./threads-view.ts";
import { emptyState, group, row, statusIcon, techDetails } from "./ui.ts";

export interface TeamActions {
  /** Start a new conversation addressed to this bot. */
  talkTo(botId: string): void;
  openThread(threadId: string): void;
}

const PEER_KIND: Record<string, "running" | "done" | "failed" | "stopped"> = {
  running: "running",
  done: "done",
  failed: "failed",
  denied: "stopped",
  refused: "stopped",
  stopped: "stopped",
};

const peerTitle = (p: PeerView) =>
  p.kind === "ask"
    ? tx("phone.team.asked", { from: p.fromName, to: p.toName })
    : tx("phone.team.handedTo", { from: p.fromName, to: p.toName });

function peerRow(p: PeerView, onOpen: () => void): HTMLElement {
  return row({
    lead: statusIcon(PEER_KIND[p.status] ?? "stopped"),
    title: peerTitle(p),
    sub: p.text.split("\n")[0] ?? "",
    value: p.status === "running" ? PEER_WORD[p.status] : ago(p.createdAt),
    chevron: true,
    onclick: onOpen,
    attrs: { "data-peer": p.id },
  });
}

/** One hand-off: what was asked, its steps as activity rows, the teammate's words. */
export function openPeer(s: Session, requestId: string, act: TeamActions): Sheet {
  const body = h("div", { class: "peer-page" }, emptyState(tx("common.loading2")));
  const paint = (p: PeerView) => {
    const steps = (p.events ?? []).map((e) =>
      row({
        lead: statusIcon(
          e.kind === "refused" || e.kind === "failed" ? "failed" : e.kind === "card" ? "waiting" : "done",
        ),
        title: `${EVENT_WORD[e.kind] ?? e.kind}${e.kind === "refused" ? tx("phone.team.because", { why: REFUSE_WORD[String(e.detail.reason)] ?? "" }) : ""}`,
        sub: e.kind === "card" && e.detail.summary ? String(e.detail.summary) : null,
        value: new Date(e.createdAt).toLocaleTimeString(document.documentElement.lang || undefined, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        }),
      }),
    );
    const said = (p.messages ?? [])
      .map((m): HTMLElement | null => {
        if (m.role === "assistant" && m.content.trim())
          return h(
            "div",
            { class: "peer-msg" },
            h("p", { class: "peer-who" }, s.botOf(m.botId)?.name ?? p.toName),
            prose(m.content.slice(0, 800)),
          );
        const sys = m.role === "system" ? systemLine(m.content) : null;
        return sys
          ? h(
              "div",
              { class: "peer-msg", "data-role": "system" },
              h("p", { class: "peer-who" }, sys.label),
              h("p", {}, sys.text.slice(0, 300)),
            )
          : null;
      })
      .filter((n): n is HTMLElement => n !== null)
      .slice(-6);
    body.replaceChildren(
      h(
        "header",
        { class: "task-head" },
        h("p", { class: "ap-eyebrow" }, p.kind === "ask" ? tx("common.question2") : tx("common.handOff")),
        h("h1", { class: "task-title" }, peerTitle(p)),
        h(
          "p",
          { class: "task-status" },
          statusIcon(PEER_KIND[p.status] ?? "stopped"),
          h(
            "span",
            {},
            `${PEER_WORD[p.status]}${p.reason && p.status !== "done" ? tx("phone.team.because", { why: REFUSE_WORD[p.reason] ?? p.reason }) : ""}`,
          ),
        ),
      ),
      h("div", { class: "task-result-text peer-ask" }, p.text),
      steps.length ? group({ header: tx("phone.task.progress"), rows: steps }) : "",
      said.length
        ? h(
            "div",
            { class: "peer-said" },
            h("h3", { class: "group-h" }, tx("common.sConversation", { toName: p.toName })),
            ...said,
          )
        : "",
      group({
        rows: [
          row({
            title: tx("common.openTheOriginalChat"),
            tone: "accent",
            onclick: () => {
              closeAll();
              act.openThread(p.rootThreadId);
            },
          }),
          p.status === "running" && s.can("approve")
            ? row({
                title: tx("common.stopThisOne"),
                tone: "danger",
                onclick: () =>
                  actionSheet({
                    label: tx("common.stopThisOne"),
                    actions: [
                      {
                        label: tx("common.stopThisOne"),
                        tone: "danger",
                        run: async () => {
                          haptic("warn");
                          await s.stopPeer(p.id);
                          paint(await s.peer(p.id));
                        },
                      },
                    ],
                  }),
              })
            : null,
        ],
      }),
      techDetails([
        [tx("phone.team.techRequest"), p.id],
        [tx("phone.team.techDepth"), String(p.depth)],
        [tx("phone.team.techFrom"), p.fromBotId],
        [tx("phone.team.techTo"), p.toBotId],
        [tx("phone.team.techThread"), p.rootThreadId],
      ]),
    );
  };
  const sheet = new Sheet(body, { label: tx("common.collaborationLog"), size: "page", nav: { title: "" } });
  void s.peer(requestId).then(paint, (e) => {
    body.replaceChildren(emptyState(e instanceof Error ? e.message : tx("phone.team.cantReadThisRecord")));
  });
  return sheet;
}

const KIND_WORD: Record<string, string> = {
  cli: "CLI",
  acp: "ACP",
  api: "API",
  openai: "API",
  gemini: "API",
  anthropic: "API",
};

/** One bot: who it is, what it is doing, how it is set up; talk to it. */
export function showBot(s: Session, bot: TeamBot, act: TeamActions): Sheet {
  const now = nowLine(bot);
  const choice = s.team?.engines.find((e) => e.id === (bot.engineId ?? "default"));
  const recent = h("div", { class: "bot-recent" });
  let sheet!: Sheet;
  const can = s.can("approve");
  const edit = can
    ? h(
        "button",
        {
          class: "text-btn",
          type: "button",
          onclick: () => {
            haptic("tap");
            showBotForm(s, bot, (b) => {
              sheet.close();
              showBot(s, { ...bot, ...b }, act);
            });
          },
        },
        tx("common.edit2"),
      )
    : null;
  const body = h(
    "div",
    { class: "bot-page" },
    h(
      "header",
      { class: "bot-hero" },
      avatar(bot.avatar || bot.name, 64),
      h("h1", { class: "task-title" }, bot.name),
      h("p", { class: "task-status" }, bot.role ?? tx("common.noRoleWrittenYet")),
      h(
        "button",
        {
          class: "btn big primary bot-talk",
          type: "button",
          onclick: () => {
            haptic("tap");
            act.talkTo(bot.id);
          },
        },
        tx("phone.team.chatWith", { name: bot.name }),
      ),
    ),
    group({
      rows: [
        row({
          lead: statusIcon(now.state === "waiting" ? "waiting" : now.state === "busy" ? "running" : "done"),
          title: now.text,
          subTone: now.state === "waiting" ? "waiting" : undefined,
        }),
        bot.isLead ? row({ title: tx("common.lead"), value: tx("phone.team.leadValue") }) : null,
      ],
    }),
    group({
      header: tx("phone.team.setup"),
      rows: [
        row({ title: tx("common.permissions"), value: LEVEL_WORD[bot.approvalLevel ?? "team"] ?? "" }),
        row({ title: tx("common.browser"), value: BROWSER_WORD[bot.browserProfile] ?? "" }),
        row({ title: tx("common.memory"), value: MEMORY_WORD[bot.memoryMode] ?? "" }),
        row({
          title: tx("common.model"),
          value:
            bot.model ??
            (choice?.model ? tx("phone.team.default", { model: choice.model }) : tx("common.default")),
        }),
      ],
      footer: tx("phone.team.changeProvidersAndModelsUnder"),
    }),
    bot.instructions
      ? group({
          header: tx("common.instructions"),
          rows: [row({ title: h("span", { class: "bot-instr" }, bot.instructions) })],
        })
      : "",
    addonList(s, bot.id),
    recent,
    can ? "" : h("p", { class: "fine" }, tx("phone.team.thisPhoneDoesntHaveThe")),
    techDetails([
      [tx("phone.team.techBot"), bot.id],
      [
        tx("common.provider"),
        choice
          ? `${choice.label}${KIND_WORD[choice.kind] ? ` (${KIND_WORD[choice.kind]})` : ""}`
          : tx("common.defaultEngine"),
      ],
      [tx("phone.team.techEngine"), bot.engineId],
    ]),
  );
  sheet = new Sheet(body, {
    label: bot.name,
    size: "page",
    nav: { title: "", back: tx("common.team"), trailing: edit },
  });
  void s.peers({ botId: bot.id, limit: 3 }).then(
    (ps) =>
      recent.replaceChildren(
        group({
          header: tx("phone.team.recentCollaboration"),
          rows: ps.length
            ? ps.map((p) => peerRow(p, () => openPeer(s, p.id, act)))
            : [
                row({
                  title: tx("phone.team.noCollaborationWithTeammatesYet"),
                  attrs: { "data-muted": "true" },
                }),
              ],
        }),
      ),
    () => recent.replaceChildren(),
  );
  return sheet;
}

/** 交辦紀錄: every hand-off between bots, newest first. */
function openTrail(s: Session, act: TeamActions): Sheet {
  const body = h("div", { class: "trail-page" }, emptyState(tx("common.loading2")));
  const load = async () => {
    const peers = await s.peers({ limit: 40 }).catch(() => [] as PeerView[]);
    body.replaceChildren(
      peers.length
        ? group({ rows: peers.map((p) => peerRow(p, () => openPeer(s, p.id, act))) })
        : emptyState(tx("phone.team.noTrailTitle"), tx("phone.team.noCollaborationBetweenBotsYet")),
    );
  };
  const off = s.subscribe((w) => w === "peers" && void load());
  void load();
  return new Sheet(body, {
    label: tx("common.collaborationLog"),
    size: "page",
    nav: { back: tx("common.team") },
    onClose: off,
  });
}

export function openTeam(s: Session, act: TeamActions, first: "members" | "activity" = "members"): Sheet {
  const body = h("div", { class: "team-page" });
  const add = h(
    "button",
    {
      class: "icon-btn",
      type: "button",
      "aria-label": tx("common.newBot"),
      hidden: !s.can("approve"),
      onclick: () => {
        haptic("tap");
        showBotForm(s, undefined);
      },
    },
    icon("plus", 24),
  );
  const paint = () => {
    add.hidden = !s.can("approve");
    const t = s.team;
    if (!t) {
      body.replaceChildren(emptyState(tx("common.loading2")));
      return;
    }
    const lead = t.bots.find((b) => b.id === t.leadId);
    body.replaceChildren(
      group({
        header: tx("phone.team.members"),
        rows: t.bots.map((b) => {
          const now = nowLine(b);
          return row({
            lead: avatar(b.avatar || b.name),
            title: b.name,
            sub: b.isLead
              ? tx("phone.team.leadSub", { role: b.role ?? tx("common.lead") })
              : (b.role ?? tx("common.noRoleWrittenYet")),
            value:
              now.state === "idle"
                ? null
                : now.state === "waiting"
                  ? tx("phone.ui.waitingShort")
                  : tx("phone.ui.working"),
            valueTone: now.state === "waiting" ? "waiting" : undefined,
            chevron: true,
            onclick: () => showBot(s, b, act),
            attrs: { "data-bot": b.id },
          });
        }),
      }),
      group({
        rows: [
          row({
            icon: "activity",
            title: tx("common.collaborationLog"),
            chevron: true,
            onclick: () => openTrail(s, act),
          }),
        ],
      }),
      group({
        header: tx("common.collaborationRules"),
        rows: [
          row({ title: tx("common.whenTeammatesHandOffWork"), value: RULE_WORD[t.rules.peerApproval] ?? "" }),
          row({
            title: tx("phone.team.maxHandOffs"),
            value: tx("phone.team.levels", { maxDepth: t.rules.maxDepth }),
          }),
          row({ title: tx("common.lead"), value: lead?.name ?? tx("common.no") }),
        ],
        footer: s.can("approve")
          ? tx("phone.team.paymentsSendingDeletingAndPublishing")
          : tx("phone.team.paymentsSendingDeletingAndPublishing2"),
      }),
    );
  };
  const off = s.subscribe((w) => (w === "team" || w === "scopes") && paint());
  paint();
  void s.loadTeam().catch(() => undefined);
  const sheet = new Sheet(body, {
    label: tx("common.team"),
    size: "page",
    nav: { back: tx("phone.ui.tabLibrary"), trailing: add },
    onClose: off,
  });
  if (first === "activity") openTrail(s, act);
  return sheet;
}
