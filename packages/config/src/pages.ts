import type { UserFacingKey } from "./schema.ts";

export interface SettingsPage {
  id: UserFacingKey;
  title: string;
  titleEn: string;
  summary: string;
  /** Rendered collapsed until the user opens it. */
  collapsed: boolean;
}

/** Exactly five user-facing pages. Engineering params are deliberately absent. */
export const SETTINGS_PAGES: readonly SettingsPage[] = Object.freeze([
  {
    id: "models",
    title: "模型",
    titleEn: "Models",
    summary: "只列出偵測到或已登入的引擎與 API key",
    collapsed: false,
  },
  {
    id: "connections",
    title: "連接",
    titleEn: "Connections",
    summary: "依帳號列出整合，勾選哪些 agent 可用",
    collapsed: false,
  },
  {
    id: "permissions",
    title: "權限",
    titleEn: "Permissions",
    summary: "自主／每步確認；付款、寄送、刪除、對外發布永遠確認",
    collapsed: false,
  },
  {
    id: "devices",
    title: "裝置",
    titleEn: "Devices",
    summary: "掃 QR 配對手機，逐台設定權限、隨時撤銷",
    collapsed: false,
  },
  {
    id: "advanced",
    title: "進階",
    titleEn: "Advanced",
    summary: "學習總開關、自架會合伺服器、記錄等級",
    collapsed: true,
  },
] as const satisfies readonly SettingsPage[]);
