// Next round §3.4: the words for an audit check, shared by `alca db verify`
// and 設定 → 資料 so the two always say the same thing.
import type { VerifyResult } from "@alca/store";

const REASON: Record<string, string> = {
  hash: "hash 不符",
  prev_hash: "與前一筆接不上（中間有紀錄被刪除或改動）",
  detail_json: "內容不是有效的 JSON",
  id_gap: "編號不連續",
};

const n = (x: number) => x.toLocaleString("en-US");

function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface VerifyText {
  ok: boolean;
  /** One headline, then the advice lines (empty when it holds). */
  lines: string[];
  /** For 複製診斷: ids, times, the action name and the reason, never the detail. */
  diagnostic: string;
}

export function verifyText(r: VerifyResult, o: { total?: number; file?: string } = {}): VerifyText {
  const total = o.total ?? r.count;
  const a = r.anchor;
  const diag = JSON.stringify({
    ok: r.ok,
    rows: total,
    ...(r.brokenAt ? { brokenAt: r.brokenAt } : {}),
    anchor: a?.state ?? "absent",
    ...(a?.anchor ? { anchorLastId: a.anchor.lastId, anchorAt: a.anchor.at } : {}),
    ...(r.integrity ? { integrity: r.integrity } : {}),
  });
  if (r.brokenAt) {
    const b = r.brokenAt;
    return {
      ok: false,
      lines: [
        `✗ 稽核紀錄在第 ${n(b.id)} 筆（${b.ts}，action=${b.action}）斷開：${REASON[b.reason] ?? b.reason}。`,
        "  這表示資料庫檔案在 Alca 之外被改過（或磁碟損壞）。Alca 不會自動修復。",
        "  建議：1) 先複製整個資料夾保留現場；2) 用 `alca db verify --file <備份>` 找出最後一份完整的備份；",
        "        3) 需要時 `alca db restore <備份>`（核心要先停止）。",
      ],
      diagnostic: diag,
    };
  }
  if (a?.state === "behind" && a.anchor) {
    const tail = r.last?.id ?? 0;
    return {
      ok: false,
      lines: [
        `✗ 資料庫裡的稽核紀錄比錨點少 ${n(a.anchor.lastId - tail)} 筆（錨點：第 ${n(a.anchor.lastId)} 筆，${stamp(a.anchor.at)}）。`,
        "  可能是還原了較舊的備份，或最後幾筆被刪除。",
      ],
      diagnostic: diag,
    };
  }
  const anchorWords = o.file
    ? "（備份檔不比對錨點）"
    : a?.state === "match" || a?.state === "ahead"
      ? `；與錨點一致（${stamp(a.anchor?.at ?? "")}）`
      : "；還沒有錨點（第一次每小時檢查後就會有）";
  const integrity = r.integrity ? `。資料庫檢查：${r.integrity}` : "";
  const ok = !r.integrity || r.integrity === "ok";
  return {
    ok,
    lines: [`${ok ? "" : "✗ "}稽核紀錄：${n(total)} 筆，hash 鏈完整${anchorWords}${integrity}`],
    diagnostic: diag,
  };
}
