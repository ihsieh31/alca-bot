// The connection banner (§3.11): one row under the nav bar while the phone is
// not connected — 「電腦離線，訊息會在連上後送出」 and 〔重試〕. No attempt counts
// and no addresses here (those live in 設定 › 進階 › 診斷). When the
// connection comes back it says 「已重新連線」 for 1.5 s, then folds away. The
// phone still remembers every relay it was told about, so a restarted
// computer or relay is found again without a new pairing code.
import { h, icon } from "./dom.ts";
import { t } from "./i18n/index.ts";
import type { Session } from "./session.ts";

const TEXT: Record<string, string> = {
  connecting: t("phone.reconnect.connecting"),
  offline: t("phone.reconnect.offline"),
  revoked: t("common.thisPhoneHasBeenRevoked"),
  idle: t("common.notConnectedYet"),
};

export class ReconnectBanner {
  readonly el: HTMLElement;
  private readonly text = h("span", { class: "rc-text" });
  private readonly lead = h("span", { class: "rc-icon", "aria-hidden": "true" });
  private readonly retry: HTMLButtonElement;
  private readonly s: Session;
  private wasDown = false;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(s: Session) {
    this.s = s;
    this.retry = h(
      "button",
      { class: "rc-retry text-btn", type: "button", onclick: () => void this.s.client.resume() },
      t("common.retry"),
    ) as HTMLButtonElement;
    this.el = h(
      "div",
      { class: "conn-banner rc", role: "status", hidden: true },
      this.lead,
      this.text,
      this.retry,
    );
  }

  /** A short message instead of the state (a send failed); the state comes back after 3 s. */
  flash(msg: string): void {
    clearTimeout(this.hideTimer);
    this.el.hidden = false;
    this.el.dataset.tone = "error";
    this.el.dataset.state = "flash";
    this.lead.replaceChildren(icon("alert", 18));
    this.text.textContent = msg;
    this.retry.hidden = true;
    this.hideTimer = setTimeout(() => this.update(), 3000);
  }

  update(): void {
    const s = this.s;
    clearTimeout(this.hideTimer);
    delete this.el.dataset.tone;
    if (s.conn === "online") {
      if (!this.wasDown || this.el.hidden) {
        this.el.hidden = true;
        return;
      }
      // Back: say so briefly, then fold away.
      this.wasDown = false;
      this.el.dataset.state = "back";
      this.lead.replaceChildren(icon("check", 18));
      this.text.textContent = t("phone.reconnect.back");
      this.retry.hidden = true;
      this.hideTimer = setTimeout(() => (this.el.hidden = true), 1500);
      return;
    }
    if (s.conn !== "connecting") this.wasDown = true;
    // The first connection after launch is not news; a reconnect is.
    this.el.hidden = s.conn === "connecting" && !this.wasDown;
    this.el.dataset.state = s.conn;
    this.lead.replaceChildren(s.conn === "connecting" ? h("i", { class: "spin" }) : icon("wifiOff", 18));
    this.text.textContent =
      s.offline.stale && s.conn === "offline" ? t("phone.reconnect.offlineSaved") : (TEXT[s.conn] ?? "");
    this.retry.hidden = s.conn === "revoked" || s.conn === "connecting";
  }
}
