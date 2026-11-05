// P13: a message typed while the computer was out of reach, shown in the
// conversation until it is sent — 等待傳送 / 送出中 / 沒送出 (tap for 重試 /
// 刪除). It is replaced by the computer's own copy once sent.
import { ago, h, icon } from "./dom.ts";
import { t } from "./i18n/index.ts";
import type { OutboxItem } from "./offline.ts";
import { actionSheet } from "./sheet.ts";

export const QUEUED_WORD: Record<OutboxItem["state"], string> = {
  queued: t("phone.outboxView.queuedSendsOnceConnectedTo"),
  sending: t("phone.outboxView.sending"),
  waiting: t("phone.outboxView.willSendAfterThisChat"),
  failed: t("phone.outboxView.notSent"),
};

export function queuedSig(i: OutboxItem): string {
  return `${i.state}:${i.error ?? ""}`;
}

/**
 * §3.3: the bubble at 60% opacity and one caption under it (「等待傳送」, or a
 * red 「沒送出」). Tapping it offers 重試 / 刪除 in an action sheet; no dashed
 * borders, no inline buttons.
 */
export function fillQueued(
  el: HTMLElement,
  i: OutboxItem,
  act: {
    retry(key: string): void;
    remove(key: string): void;
    /** The item as it is now (it may have started sending while the sheet was open). */
    current?(key: string): OutboxItem | undefined;
  },
): void {
  el.dataset.state = i.state;
  // Re-read at the tap: never delete a message mid-send (it is delivered anyway) or queue it
  // twice; the sheet just closes and the bubble already says 送出中.
  const idle = (): boolean => {
    const now = act.current ? act.current(i.key) : i;
    return !!now && now.state !== "sending";
  };
  const open = () => {
    if (i.state === "sending") return;
    actionSheet({
      label: QUEUED_WORD[i.state],
      ...(i.state === "failed" && i.error ? { message: i.error } : {}),
      actions: [
        { label: t("common.retry"), run: () => idle() && act.retry(i.key) },
        { label: t("common.delete"), tone: "danger", run: () => idle() && act.remove(i.key) },
      ],
    });
  };
  const bubble = h(
    "button",
    { class: "bubble q-bubble", type: "button", disabled: i.state === "sending", onclick: open },
    i.state === "failed" ? h("span", { class: "q-alert", "aria-hidden": "true" }, icon("alert", 18)) : null,
    i.text,
  );
  // One live region per bubble, kept across repaints: a status node made anew on every paint is
  // usually not announced; changing the text of a standing one is.
  const meta =
    el.querySelector<HTMLElement>(":scope > .q-meta") ?? h("p", { class: "q-meta", role: "status" });
  if (meta.textContent !== QUEUED_WORD[i.state]) meta.textContent = QUEUED_WORD[i.state];
  el.replaceChildren(bubble, meta);
}

/** The line above a conversation read from the phone's saved copy. */
export function staleLine(savedAt: number): string {
  return savedAt
    ? t("phone.outboxView.offlineShowingContentSyncedStored", { p0: ago(new Date(savedAt).toISOString()) })
    : t("phone.outboxView.offlineShowingTheLastSynced");
}
