// Source-language strings (zh-Hant-TW) for the desktop shell (tray, splash). `check:i18n --write`
// turns them into apps/desktop-shell/ui/strings.<locale>.json, which tray.rs compiles in.
export const shell = {
  "shell.attached": "Alca 正在執行（背景服務）",
  "shell.foot": "一切都在這台電腦上執行。",
  "shell.keepsStopping": "核心一直停止，請看紀錄檔後按「重新啟動核心」",
  "shell.logFile": "紀錄檔：{path}",
  "shell.logs": "打開紀錄檔資料夾",
  "shell.noCore": "找不到 Alca 核心（設定 ALCA_CORE_CMD，或執行 scripts/install.sh）",
  "shell.open": "打開 Alca",
  "shell.openAtLogin": "登入時開啟",
  "shell.openWaiting": "查看等你決定的事",
  "shell.pair": "配對手機…",
  "shell.phones": "{n} 支手機在線上",
  "shell.quit": "結束 Alca",
  "shell.restart": "重新啟動核心",
  "shell.restarting": "核心停止了，{n} 秒後重新啟動",
  "shell.running": "Alca 正在執行",
  "shell.startFailed": "無法啟動核心：{e}",
  "shell.starting": "Alca 正在啟動…",
  "shell.stopped": "核心停止了",
  "shell.waiting": "等你決定：{n} 件",
} as const;
