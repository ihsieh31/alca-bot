// Phase F2 (next round R7): the data key at start, and 設定 → 資料's
// encryption block. The key is D1's `core.dbKey` in the folder's vault
// (`ensureDataKey` / `getDataKey`); the store seals the content columns with
// it (`Sealer`), and the database worker seals what was written before.
import { existsSync } from "node:fs";
import { ensureDataKey, getDataKey, type KeyStatus } from "@alca/os";
import {
  appendAudit,
  CancelledError,
  type DbWorker,
  type DropPlaintextResult,
  openDatabase,
  type PlaintextBackup,
  Sealer,
  type SealStatus,
  type Store,
  sealRingOf,
  type Upkeep,
} from "@alca/store";
import { describeKeyStatus } from "./data-dir.ts";
import { HttpError } from "./http.ts";

/** The start stops: the data key cannot be read, or the database was sealed with a key this vault does not have. */
export class DataKeyStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataKeyStartError";
  }
}

const RECOVER =
  "Alca 沒有產生新的資料金鑰（那會讓已加密的對話永遠打不開）。\n" +
  "若保管庫最近才壞掉：停止 Alca，把 vault.json.bak 放回 vault.json 再啟動；換過電腦：在舊電腦 `alca secrets export`，這台 `alca secrets import`。";

/** True when the database file was already sealed (it has a ring fingerprint). Read only. */
function sealedOnDisk(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  const db = openDatabase({ path: dbPath, readOnly: true });
  try {
    return sealRingOf(db) !== undefined;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * The data key for this start. Made the first time (stored and read back by
 * D1) — but never when the vault cannot be read, and never over a database
 * that is already sealed (that would seal new rows with a second key).
 */
export async function loadSealer(
  vault: Parameters<typeof getDataKey>[0],
  dbPath: string,
): Promise<{ sealer: Sealer; created: boolean }> {
  let ring: Awaited<ReturnType<typeof getDataKey>>;
  try {
    ring = await getDataKey(vault);
  } catch (err) {
    throw new DataKeyStartError(
      `讀不到資料金鑰 core.dbKey：${err instanceof Error ? err.message : String(err)}\n${RECOVER}`,
    );
  }
  if (ring) return { sealer: new Sealer(ring), created: false };
  if (sealedOnDisk(dbPath))
    throw new DataKeyStartError(`資料庫已加密，但保管庫裡沒有資料金鑰 core.dbKey。\n${RECOVER}`);
  const made = await ensureDataKey(vault);
  return { sealer: new Sealer(made.ring), created: made.created };
}

/** 設定 → 資料 → 加密 (GET /api/settings/encryption). */
export interface EncryptionView {
  /** Always on from F2: every new write is sealed. */
  on: true;
  keyName: "core.dbKey";
  keyIds: number[];
  currentKeyId: number;
  /** Where the vault key (which protects core.dbKey) lives. */
  vault: { where: string; degraded: boolean; text: string };
  /** Rows still holding plaintext, per table, and their sum. */
  plaintext: Record<string, number>;
  remaining: number;
  sealed: Record<string, number>;
  /** When the background pass last finished. */
  doneAt?: string;
  /** The background pass is running now. */
  running: boolean;
  /** Files that may still hold plaintext (backups taken before the pass finished, files a restore set aside). */
  backups: Array<Pick<PlaintextBackup, "name" | "takenAt" | "bytes" | "kind">>;
  /** User decision: only once nothing is plaintext and the pass has finished. */
  canDropBackups: boolean;
}

/** Wait before the first pass after a start (the start's own work goes first). */
export const FIRST_PASS_DELAY_MS = 60_000;

export class SealApi {
  private readonly o: {
    store: Pick<Store, "db" | "jobs">;
    sealer: Sealer;
    vault: { keyStatus(): KeyStatus };
    log: (level: "info" | "warn", line: string) => void;
  };
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(o: SealApi["o"]) {
    this.o = o;
  }

  private get jobs(): Pick<DbWorker, "run"> {
    return this.o.store.jobs;
  }

  /** R7.5 step 4: seal what is still plaintext, on the database worker. One at a time. */
  runPass(): Promise<void> {
    if (this.running) return this.running;
    const run = this.jobs
      .run("sealPass", null)
      .then((r) => {
        const n = Object.values(r.sealed).reduce((a, b) => a + b, 0);
        if (n > 0) this.o.log("info", `背景加密：這次加密了 ${n} 列${r.done ? "，全部完成" : ""}`);
      })
      .catch((err) => {
        if (!(err instanceof CancelledError))
          this.o.log("warn", `背景加密失敗：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = run;
    return run;
  }

  /** The first pass a minute after the start (unref'd: it never keeps the process up). */
  startSoon(delayMs = FIRST_PASS_DELAY_MS): void {
    this.timer = setTimeout(() => void this.runPass(), delayMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async view(): Promise<EncryptionView> {
    const st: SealStatus & { backups: PlaintextBackup[] } = await this.jobs.run("sealStatus");
    const ks = this.o.vault.keyStatus();
    return {
      on: true,
      keyName: "core.dbKey",
      keyIds: [...this.o.sealer.keyIds],
      currentKeyId: this.o.sealer.currentKeyId,
      vault: { where: ks.where, degraded: ks.degraded, text: describeKeyStatus(ks) },
      plaintext: st.plaintext,
      remaining: st.remaining,
      sealed: st.sealed,
      ...(st.doneAt ? { doneAt: st.doneAt } : {}),
      running: !!this.running,
      backups: st.backups.map((b) => ({ name: b.name, takenAt: b.takenAt, bytes: b.bytes, kind: b.kind })),
      canDropBackups: st.remaining === 0 && !!st.doneAt && st.backups.length > 0,
    };
  }

  /** R7.5 step 5 (user decision): refused until everything is sealed; a new backup first; one audit row. */
  async dropPlaintextBackups(): Promise<DropPlaintextResult> {
    let r: DropPlaintextResult;
    try {
      r = await this.jobs.run("dropPlaintextBackups", new Date().toISOString());
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    }
    appendAudit(this.o.store.db, {
      ts: new Date().toISOString(),
      initiator: { kind: "user", id: "desktop" },
      actor: { kind: "system", id: "store" },
      action: "data.backups_dropped",
      actionClass: "delete",
      target: "backups",
      decision: "allow",
      detail: { removed: r.removed, kept: r.backup.split(/[\\/]/).pop() },
    });
    return r;
  }
}

/** The hourly slot also runs the pass (it goes on from where it stopped; cheap once done). */
export function attachSealPass(upkeep: Upkeep, seal: SealApi): void {
  const runHourly = upkeep.runHourly.bind(upkeep);
  upkeep.runHourly = (now: Date) => {
    const r = runHourly(now);
    void r.finally(() => seal.runPass());
    return r;
  };
}
