// G1: the line under 「或用配對碼」 about the last pairing's protocol. Pure (no
// DOM) so the wording is tested. PAKE v1 is removed: the core refuses a
// v1-only device, the person has to update the phone page and pair again, and
// this says so on the computer too, because an old phone page only shows the
// bare code.
import { t } from "./i18n/index.ts";

export interface PakeRecentView {
  flow: string;
  version: number;
  ok: boolean;
  at: string;
  error?: string;
}

export interface PakeStatusView {
  recent: PakeRecentView[];
}

export function pakeNote(p: PakeStatusView | undefined): string | undefined {
  const last = p?.recent[0];
  if (!last) return undefined;
  if (last.error === "upgrade_required")
    return t("desktop.linkPakeNote.anOldPhonePairingProtocol", {
      p0: last.flow === "enroll" ? t("desktop.linkPakeNote.joinWithGoogleSignIn") : t("common.pair"),
    });
  return undefined;
}
