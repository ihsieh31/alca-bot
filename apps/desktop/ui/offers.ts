import type { AgentsEvent, Api } from "./api.ts";
import { h } from "./dom.ts";
import { t } from "./i18n/index.ts";

// P14 C: the 主動留意 cards waiting for an answer, above the conversation:
// the proposal in one sentence and 好 / 先不用 / 別再提這類. 好 starts an
// ordinary worker (sends, payments, deletes and posts still ask).

interface OfferView {
  id: string;
  botId: string;
  threadId: string | null;
  category: string;
  text: string;
  status: string;
  dueAt: string | null;
}

export class OfferStrip {
  private readonly root: HTMLElement;
  private readonly api: Api;
  private readonly onOpen: (threadId: string) => void;
  private readonly onError: (e: unknown) => void;
  private soon: ReturnType<typeof setTimeout> | undefined;

  constructor(root: HTMLElement, api: Api, o: { open(threadId: string): void; error(e: unknown): void }) {
    this.root = root;
    this.api = api;
    this.onOpen = o.open;
    this.onError = o.error;
  }

  async refresh(): Promise<void> {
    try {
      const r = await this.api.call<{ offers: OfferView[] }>("GET", "/api/offers");
      this.paint(r.offers);
    } catch {
      this.paint([]);
    }
  }

  onAgentsEvent(e: AgentsEvent): void {
    if (e.type !== "offer.created" && e.type !== "offer.updated") return;
    clearTimeout(this.soon);
    this.soon = setTimeout(() => void this.refresh(), 80);
  }

  private answer(o: OfferView, choice: "yes" | "later" | "never"): void {
    void this.api
      .call<OfferView>("POST", `/api/offers/${o.id}/answer`, { choice })
      .then((r) => {
        void this.refresh();
        if (choice === "yes" && r.threadId) this.onOpen(r.threadId);
      })
      .catch(this.onError);
  }

  private paint(offers: OfferView[]): void {
    this.root.hidden = offers.length === 0;
    this.root.replaceChildren(
      ...offers.map((o) =>
        h(
          "article",
          { class: "offer-card", "data-offer": o.id },
          h("span", { class: "offer-src" }, t("common.proactiveSuggestions")),
          h("p", { class: "offer-text" }, o.text),
          h(
            "div",
            { class: "offer-acts" },
            h(
              "button",
              { class: "btn btn-primary", type: "button", onclick: () => this.answer(o, "yes") },
              t("common.ok"),
            ),
            h(
              "button",
              { class: "btn btn-quiet", type: "button", onclick: () => this.answer(o, "later") },
              t("common.notNow"),
            ),
            h(
              "button",
              { class: "btn btn-quiet", type: "button", onclick: () => this.answer(o, "never") },
              t("common.dontSuggestThisKindAgain"),
            ),
          ),
        ),
      ),
    );
  }
}
