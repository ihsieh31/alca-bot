// Desktop chrome: starter suggestions, run-status words, theme (split out of app.ts, P13).
import { $ } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import type { Suggestion } from "./timeline.ts";

export const DEMO_SUGGESTIONS: Suggestion[] = [
  { title: tx("desktop.appChrome.takeANote"), text: tx("desktop.appChrome.writeMeANoteMeeting") },
  { title: tx("desktop.appChrome.tryAnApprovalCard"), text: tx("desktop.appChrome.deleteTheShoppingList") },
  { title: tx("desktop.appChrome.tryAQuestionCard"), text: tx("desktop.appChrome.askMeWhatTimeTo") },
];
export const ROUTER_DEMO_SUGGESTIONS: Suggestion[] = [
  { title: tx("desktop.appChrome.twoWorkersAtOnce"), text: tx("common.doTwoThingsForMe") },
  { title: tx("desktop.appChrome.watchdog"), text: tx("desktop.appChrome.keepAnEyeOnMy") },
  { title: tx("desktop.appChrome.rememberSomething"), text: tx("desktop.appChrome.rememberThatILikeOat") },
  { title: tx("desktop.appChrome.takeANote"), text: tx("desktop.appChrome.writeMeANoteMeeting") },
  { title: tx("desktop.appChrome.tryAQuestionCard"), text: tx("desktop.appChrome.askMeWhatTimeTo") },
];
export const CLI_SUGGESTIONS: Suggestion[] = [
  { title: tx("desktop.appChrome.lookAtThisFolder"), text: tx("desktop.appChrome.whatFilesAreInThis") },
  { title: tx("desktop.appChrome.sortOutGitStatus"), text: tx("desktop.appChrome.lookAtGitStatusFor") },
  { title: tx("desktop.appChrome.orderMyToDos"), text: tx("desktop.appChrome.orderTodaysToDosBy") },
];

export type RunState = "idle" | "running" | "waiting" | "failed";
export const STATUS_TEXT: Record<RunState, string> = {
  idle: tx("desktop.appChrome.ready"),
  running: tx("desktop.appChrome.thinking"),
  waiting: tx("common.waitingOnYou"),
  failed: tx("common.notFinished"),
};
export const LEVEL_TEXT: Record<string, string> = {
  autonomous: tx("desktop.appChrome.permissionsAutonomous"),
  confirm_each_step: tx("desktop.appChrome.permissionsAskEveryStep"),
};
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
// SVG path data (20×20 viewBox) for the theme button; built as DOM, no innerHTML.
export const THEME_ICON: Record<Theme, string[]> = {
  system: [
    "M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 12.5z",
    "M7.5 17h5M10 14v3",
  ],
  light: [
    "M10 13.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5z",
    "M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1.06 1.06M14.24 14.24l1.06 1.06M4.7 15.3l1.06-1.06M14.24 5.76l1.06-1.06",
  ],
  dark: ["M16.5 11.6A6.75 6.75 0 0 1 8.4 3.5a6.75 6.75 0 1 0 8.1 8.1z"],
};
export const THEME_LABEL: Record<Theme, string> = {
  system: tx("desktop.appChrome.appearanceSystem"),
  light: tx("desktop.appChrome.appearanceLight"),
  dark: tx("desktop.appChrome.appearanceDark"),
};

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);
export const typing = () => {
  const a = document.activeElement;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement;
};

export function applyTheme(t: Theme): void {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const btn = $("theme-toggle");
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  for (const d of THEME_ICON[t]) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  btn.replaceChildren(svg);
  btn.title = THEME_LABEL[t];
}
