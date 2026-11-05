// The screens of /computer-signin (P12): 「正在用 Google 登入這台電腦…」 on the
// way to Google, 「正在回到 Alca…」 on the way back to the computer, and what
// went wrong otherwise. The logic is in computer-signin.ts.

import { CS_KEY, computerParams, computerReturn, googleUrl } from "./computer-signin.ts";
import type { SiteConfig } from "./config.ts";
import { h, icon } from "./dom.ts";
import { googleButton } from "./google-button.ts";
import { t } from "./i18n/index.ts";

const screen = (title: string, sub: string, extra?: Node) =>
  h(
    "section",
    { class: "screen ob gs cs", "aria-label": t("phone.computerView.computerSignInWithGoogle") },
    h(
      "div",
      { class: "ob-head gs-hero" },
      h("span", { class: "ob-mark", "aria-hidden": "true" }, icon("laptop", 28)),
      h("h1", { class: "ob-title gs-title" }, title),
      h("p", { class: "ob-sub gs-sub" }, sub),
    ),
    extra ?? "",
  );

/**
 * Handle /computer-signin or the way back from Google for it. Returns true
 * when this page load belongs to a computer's sign-in (the app is not shown).
 */
export async function maybeComputerSignIn(root: HTMLElement, config: SiteConfig): Promise<boolean> {
  const back = await computerReturn(location.hash, sessionStorage.getItem(CS_KEY));
  if (back) {
    sessionStorage.removeItem(CS_KEY);
    history.replaceState(null, "", "/");
    if ("error" in back) {
      root.replaceChildren(screen(t("phone.computerView.signInNotCompleted"), back.error));
      return true;
    }
    root.replaceChildren(
      screen(
        t("phone.computerView.returningToAlca"),
        t("phone.computerView.signedInTheBrowserHands"),
        h(
          "a",
          { class: "text-btn cs-again", href: back.go },
          t("phone.computerView.nothingHappeningClickHereTo"),
        ),
      ),
    );
    location.replace(back.go);
    return true;
  }
  if (!/\/computer-signin\/?$/.test(location.pathname)) return false;
  const p = computerParams(location.search);
  if (!p || !config.googleClientId) {
    root.replaceChildren(
      screen(
        t("phone.computerView.thisLinkIsIncomplete"),
        config.googleClientId
          ? t("phone.computerView.goBackToAlcaOn")
          : t("phone.computerView.thisSiteDoesntHaveGoogle"),
      ),
    );
    return true;
  }
  sessionStorage.setItem(CS_KEY, JSON.stringify(p));
  const go = await googleUrl(config.googleClientId, location.origin, p);
  root.replaceChildren(
    screen(
      t("phone.computerView.signInToThisComputer"),
      t("phone.computerView.nextIsGooglesSignIn"),
      h(
        "div",
        { class: "ob-actions gs-actions" },
        googleButton({ href: go }),
        h(
          "p",
          { class: "ob-foot pair-foot" },
          icon("lock", 14),
          t("phone.computerView.alcaOnlyGetsYourGoogle"),
        ),
      ),
    ),
  );
  // Straight on unless this is a preview (screenshots): the person already pressed 用 Google 登入.
  if (!new URLSearchParams(location.search).has("preview")) setTimeout(() => location.assign(go), 400);
  return true;
}
