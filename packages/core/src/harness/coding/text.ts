import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { encodeMixed, lineEndings } from "./eol.ts";

/**
 * Plan §4 (moved from the P15 archive): text files as the coding tools see
 * them. The BOM is stripped and remembered; the line ending is the most
 * common one (ties: the first seen); the text handed around is LF only.
 * Writing converts back, restores the BOM and replaces the file atomically
 * (temp + rename, mode kept), then reads the file back and compares its hash
 * with what was meant to be written (plan §4: write, read back, compare).
 *
 * Research audit A2: a file that is not UTF-8 (Big5, Shift-JIS, Latin-1)
 * would be written back wrong, so `utf8` says whether its bytes survive a
 * decode / encode round trip, and edit / write / apply_patch refuse a file
 * that does not (`notUtf8`). A file with mixed endings keeps the ending of
 * every line a change did not touch (eol.ts).
 */

export type Eol = "\n" | "\r\n" | "\r";

export interface LoadedText {
  text: string;
  bom: boolean;
  eol: Eol;
  mixedEol: boolean;
  /** The ending after each line, kept only when the endings are mixed. */
  endings?: Eol[];
  /** The bytes decode to UTF-8 and encode back to the same bytes (false: Big5 and the like). */
  utf8: boolean;
}

/** How a text is written back: BOM, ending, and (mixed endings) the old text and its line endings. */
export interface TextFormat {
  bom: boolean;
  eol: Eol;
  mixedEol?: boolean;
  endings?: Eol[];
  /** The LF text the endings belong to. */
  text?: string;
}

export function decodeText(raw: string): LoadedText {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const counts: Array<[Eol, number, number]> = [
    ["\r\n", 0, -1],
    ["\n", 0, -1],
    ["\r", 0, -1],
  ];
  const re = /\r\n|\n|\r/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const e = counts.find((c) => c[0] === m?.[0]) as [Eol, number, number];
    e[1]++;
    if (e[2] < 0) e[2] = m.index;
  }
  const used = counts.filter((c) => c[1] > 0);
  used.sort((a, b) => b[1] - a[1] || a[2] - b[2]);
  const eol = used[0]?.[0] ?? "\n";
  const mixedEol = used.length > 1;
  return {
    text: body.replace(/\r\n|\r/g, "\n"),
    bom,
    eol,
    mixedEol,
    ...(mixedEol ? { endings: lineEndings(body) } : {}),
    utf8: true,
  };
}

/** Whether these bytes are UTF-8 that a decode / encode round trip keeps byte for byte. */
export function isUtf8(raw: Buffer): boolean {
  return Buffer.from(raw.toString("utf8"), "utf8").equals(raw);
}

export function loadText(path: string): LoadedText {
  const raw = readFileSync(path);
  return { ...decodeText(raw.toString("utf8")), utf8: isUtf8(raw) };
}

/** The refusal for changing a file that is not UTF-8 with the text tools. */
export function notUtf8(shown: string): string {
  return `${shown} 不是 UTF-8 編碼（可能是 Big5、Shift-JIS 等），用 edit／write／apply_patch 改會把內容寫壞，所以沒有修改。請改用 bash 依原編碼處理（例如 iconv 轉換後再改、改完轉回，或用 sed／perl 直接改位元組）。`;
}

export function encodeText(lf: string, o: TextFormat): string {
  const body =
    o.mixedEol && o.endings && o.text !== undefined
      ? encodeMixed(lf, o.text, o.endings, o.eol)
      : o.eol === "\n"
        ? lf
        : lf.replace(/\n/g, o.eol);
  return o.bom ? `\uFEFF${body}` : body;
}

export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** Thrown when the bytes on disk after a write are not the bytes written. */
export class WriteVerifyError extends Error {}

let tmpSeq = 0;

/** Test hook: what reading the file back returns (default: the file). */
export const readBack = { read: (path: string): Buffer => readFileSync(path) };

/**
 * Write atomically and verify: the file read back must hash to what was
 * written. Returns that hash. A mismatch (another writer raced the rename, a
 * filter rewrote the file, a full disk) throws `WriteVerifyError`.
 */
export function saveText(path: string, lf: string, o: TextFormat): string {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : undefined;
  const tmp = `${path}.alca-${process.pid}-${Date.now()}-${tmpSeq++}.tmp`;
  const bytes = Buffer.from(encodeText(lf, o), "utf8");
  try {
    writeFileSync(tmp, bytes);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const want = sha256(bytes);
  const got = sha256(readBack.read(path));
  if (got !== want)
    throw new WriteVerifyError(
      `寫入後回讀的內容和寫入的不一樣（${path}）：可能有其他程式同時在改這個檔案。請重新 read 確認現況。`,
    );
  return want;
}

export interface FileStamp {
  mtimeMs: number;
  size: number;
  hash: string;
}

export function stampOf(path: string): FileStamp {
  const st = statSync(path);
  return { mtimeMs: st.mtimeMs, size: st.size, hash: sha256(readFileSync(path)) };
}

/** What each worker read, so an edit of a file it never read, or that changed since, is refused. */
export class ReadState {
  private readonly m = new Map<string, FileStamp>();
  note(path: string): void {
    try {
      this.m.set(path, stampOf(path));
    } catch {
      this.m.delete(path);
    }
  }
  /** Whether the worker has read (or written) this file in this run. */
  has(path: string): boolean {
    return this.m.has(path);
  }
  forget(path: string): void {
    this.m.delete(path);
  }
  /** undefined = fresh; otherwise the refusal to give the model. */
  check(path: string, shown: string): string | undefined {
    const s = this.m.get(path);
    if (!s) return `修改前請先用 read 讀取 ${shown}。`;
    return this.stale(path, shown);
  }
  /** Only the staleness half: a file never read is not stale (apply_patch carries its own context; a never-read Update only gets a reminder, see tools/patch.ts). */
  stale(path: string, shown: string): string | undefined {
    const s = this.m.get(path);
    if (!s) return undefined;
    let now: FileStamp;
    try {
      now = stampOf(path);
    } catch {
      return `${shown} 已經不存在，請重新確認。`;
    }
    if (now.size !== s.size || now.hash !== s.hash)
      return `${shown} 在你上次讀取之後已被修改（可能是格式化器、使用者或其他命令），請重新 read 後再編輯。`;
    return undefined;
  }
}
