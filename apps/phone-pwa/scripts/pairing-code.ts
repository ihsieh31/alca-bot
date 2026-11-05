/**
 * Mac test 2026-11 B5: the phone screenshots stopped at a disabled 配對
 * button. `POST /api/link/pairings` needs the approve key (review
 * 2026-11-04b S2.2) and the phone script sent only the local token, so the
 * answer was a 403 `{error}`; `String(pairing.code)` typed "undefined", no
 * digits, and the button (9+ digits, app/pairing.ts) never enabled. The
 * scripts now send `app.uiHeaders`, and this check stops with the server's
 * own words instead of a 30-second click timeout.
 */
export function pairingCode(answer: Record<string, unknown>): string {
  const code = typeof answer.code === "string" ? answer.code.replace(/\D/g, "") : "";
  if (/^\d{9,10}$/.test(code)) return code;
  const why = typeof answer.error === "string" ? answer.error : JSON.stringify(answer).slice(0, 200);
  throw new Error(`配對碼不是 9–10 位數字（/api/link/pairings 回：${why}）`);
}
