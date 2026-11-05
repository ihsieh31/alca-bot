// R5.6: one conversation out to a `.alca-export` file and back in, shared by
// 設定 → 資料 (POST /api/export, /api/import) and the CLI (`alca export
// thread`, `alca import`). The store does the work (packages/store/src/
// export.ts) on the database worker; this file names the files and turns the
// store's errors into sentences.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tSource } from "@alca/design/i18n";

/** Where the core writes an export (and a received import) for the moment it takes; 0700. */
export function transferDir(dataDir: string): string {
  const dir = join(dataDir, "exports");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** A file name for one conversation's export: alca-thread-<id>-<yyyymmdd>.alca-export. */
export function exportFileName(threadId: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const safe = threadId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "thread";
  return `alca-thread-${safe}-${day}.alca-export`;
}

/** A private scratch path in `dir` (never a name the person chose). */
export function scratchPath(dir: string, tag: string): string {
  return join(dir, `.${tag}-${randomBytes(8).toString("hex")}.alca-export`);
}

/** The store's export / import errors (English, possibly from the worker as a bare message) in 繁中, with an HTTP status. */
export function transferError(e: unknown): { status: number; text: string } {
  const m = e instanceof Error ? e.message : String(e);
  const table: Array<[RegExp, number, string]> = [
    [/^no conversation/, 404, tSource("core.transfer.noThread")],
    [
      /not an Alca export file|unsupported export|has no conversation row|unexpected table/,
      400,
      tSource("core.transfer.notExport"),
    ],
    [/a passphrase is needed/, 400, tSource("core.transfer.needPassphrase")],
    [/wrong passphrase|damaged/, 400, tSource("core.transfer.wrongPassphrase")],
    [/from a newer Alca/, 400, tSource("core.transfer.newer")],
    [/more than .* rows/, 400, tSource("core.transfer.tooLarge")],
    [/cancelled \(the store is closing\)/, 503, tSource("core.transfer.closing")],
  ];
  for (const [re, status, text] of table) if (re.test(m)) return { status, text };
  return { status: 500, text: tSource("core.transfer.failed", { reason: m }) };
}
