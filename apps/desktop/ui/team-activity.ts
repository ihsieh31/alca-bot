// 團隊 → 協作紀錄: the bot-to-bot trail and one request's detail; split out of team.ts (P13).

import { PEER_WORD, type Peer, REFUSE_WORD, type Team } from "./api-team.ts";
import { plainSummary } from "./approval-card.ts";
import { h, relativeTime } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { icon } from "./icons.ts";
import { EVENT_WORD, systemLine, type TeamView } from "./team.ts";

export function activity(view: TeamView, t: Team): HTMLElement {
  if (!view.peers.length)
    return h(
      "div",
      {},
      h("h2", { class: "lb-page-title" }, tx("common.collaborationLog")),
      h("p", { class: "lb-intro" }, tx("desktop.teamActivity.whenBotsAskEachOther")),
      h(
        "div",
        { class: "lb-empty" },
        t.bots.length > 1
          ? tx("desktop.teamActivity.noCollaborationRecordsYetTry")
          : tx("desktop.teamActivity.addATeammateUnderMembers"),
      ),
    );
  return h(
    "div",
    {},
    h("h2", { class: "lb-page-title" }, tx("common.collaborationLog")),
    h("p", { class: "lb-intro" }, tx("desktop.teamActivity.eachEntryIsSomethingOne")),
    h("ul", { class: "tm-peers" }, ...view.peers.map((p) => peerRow(view, p))),
  );
}

/** 「Alca 交給 研究員」 + the request's first line; state and time trailing (§4.2). */
export function peerRow(view: TeamView, p: Peer): HTMLElement {
  const open = view.selected === p.id;
  const title =
    p.kind === "ask"
      ? tx("desktop.team.peerAsk", { from: p.fromName, to: p.toName })
      : tx("desktop.team.peerTitle", { from: p.fromName, to: p.toName });
  const status =
    p.reason && p.status !== "done"
      ? `${PEER_WORD[p.status]}${tx("common.joinComma")}${REFUSE_WORD[p.reason] ?? p.reason}`
      : PEER_WORD[p.status];
  const row = h(
    "button",
    {
      class: "tm-peer-row",
      type: "button",
      "aria-expanded": open ? "true" : "false",
      title: p.depth > 1 ? tx("common.level", { depth: p.depth }) : undefined,
      onclick: () => {
        view.selected = open ? undefined : p.id;
        view.detail = undefined;
        if (view.selected)
          void view.client.peer(p.id).then((d) => {
            view.detail = d;
            view.render();
          });
        view.render();
      },
    },
    h(
      "span",
      { class: "lb-main" },
      h("span", { class: "tm-row-name" }, title),
      h("span", { class: "lb-meta" }, p.text.split("\n")[0]?.slice(0, 120) ?? ""),
    ),
    h("span", { class: "tm-status", "data-status": p.status }, status),
    h("span", { class: "tm-time" }, relativeTime(p.createdAt)),
    icon("chevron", "tm-chev"),
  );
  return h(
    "li",
    { class: "tm-peer", "data-open": open ? "true" : "false" },
    row,
    open ? peerDetail(view, p) : null,
  );
}

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString(document.documentElement.lang || undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

/** One hand-off's detail: what happened (activity rows, §3.4), then the teammate's last words. */
export function peerDetail(view: TeamView, p: Peer): HTMLElement {
  const d = view.detail?.id === p.id ? view.detail : undefined;
  const glyph = (kind: string) =>
    kind === "approved" || kind === "answered"
      ? "check"
      : kind === "failed" || kind === "refused" || kind === "denied"
        ? "alert"
        : kind === "approval" || kind === "card"
          ? "hand"
          : kind === "stopped"
            ? "stop"
            : "send";
  const steps = (d?.events ?? []).map((e) =>
    h(
      "li",
      { class: "act-row tm-step", "data-kind": e.kind },
      h("span", { class: "act-icon" }, icon(glyph(e.kind))),
      h(
        "span",
        { class: "act-text" },
        EVENT_WORD[e.kind] ?? e.kind,
        e.kind === "card" && plainSummary(String(e.detail.summary ?? ""))
          ? `${tx("common.joinColon")}${plainSummary(String(e.detail.summary ?? ""))}`
          : "",
        e.kind === "refused" ? `${tx("common.joinColon")}${REFUSE_WORD[String(e.detail.reason)] ?? ""}` : "",
      ),
      h("span", { class: "act-trail" }, hhmm(e.createdAt)),
    ),
  );
  const convo = (d?.messages ?? [])
    .filter((m) => m.role === "assistant" || m.role === "system")
    .map((m) => {
      const who = m.botId ? view.bot(m.botId) : undefined;
      if (m.role === "assistant")
        return m.content.trim()
          ? h(
              "div",
              { class: "tm-msg", "data-role": "assistant" },
              h("b", { class: "tm-msg-label" }, who?.name ?? p.toName),
              h("p", {}, m.content.slice(0, 400)),
            )
          : null;
      const sys = systemLine(m.content);
      return sys
        ? h(
            "div",
            { class: "tm-msg", "data-role": "system" },
            h("b", { class: "tm-msg-label" }, sys.label),
            h("p", {}, sys.text.slice(0, 300)),
          )
        : null;
    })
    .filter((el) => el !== null)
    .slice(-6);
  return h(
    "div",
    { class: "tm-detail" },
    h("ol", { class: "tm-steps" }, ...steps),
    convo.length
      ? h(
          "div",
          { class: "tm-convo" },
          h("p", { class: "lb-h2 tm-convo-head" }, tx("common.sConversation", { toName: p.toName })),
          ...convo,
        )
      : null,
    h(
      "div",
      { class: "tm-detail-actions" },
      h(
        "button",
        { class: "btn-link", type: "button", onclick: () => view.hooks.openThread(p.rootThreadId) },
        tx("common.openTheOriginalChat"),
      ),
      p.status === "running"
        ? h(
            "button",
            {
              class: "btn-link",
              "data-tone": "danger",
              type: "button",
              onclick: () => view.act(view.client.stopPeer(p.id)),
            },
            tx("common.stopThisOne"),
          )
        : null,
    ),
  );
}
