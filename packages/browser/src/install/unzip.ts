import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";

/**
 * A small zip reader for the Chrome for Testing archives, so first-run setup
 * needs no `unzip` on the machine. It reads the central directory (zip64
 * included), streams each entry (stored or deflate) to disk, checks every
 * entry's CRC-32 and size, keeps Unix permissions and symlinks (the macOS app
 * bundle has both), and refuses any path or link that would land outside the
 * destination.
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** Unix mode from the external attributes, 0 when the archive was not made on Unix. */
  mode: number;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, b, off, len - off, pos + off);
    if (n === 0) throw new ZipError("壓縮檔被截斷");
    off += n;
  }
  return b;
}

const big = (b: Buffer, o: number) => {
  const v = b.readBigUInt64LE(o);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("壓縮檔太大");
  return Number(v);
};

/** Read the central directory. */
export function listZip(file: string): ZipEntry[] {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    if (eocd < 0) throw new ZipError("不是 zip 檔（找不到目錄結尾）");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new ZipError("zip64 目錄定位資料缺失");
      const z64 = readAt(fd, big(tail, loc + 8), 56);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new ZipError("zip64 目錄結尾損壞");
      count = big(z64, 32);
      cdSize = big(z64, 40);
      cdOffset = big(z64, 48);
    }
    if (cdOffset + cdSize > size) throw new ZipError("壓縮檔目錄超出檔案範圍");
    const cd = readAt(fd, cdOffset, cdSize);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError("壓縮檔目錄損壞");
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const ext = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      // zip64 extra: the 0xFFFFFFFF fields, in order.
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (usize === 0xffffffff) {
            usize = big(cd, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = big(cd, q);
            q += 8;
          }
          if (localOffset === 0xffffffff) localOffset = big(cd, q);
        }
        e += 4 + len;
      }
      out.push({
        name,
        method,
        flags,
        crc,
        compressedSize,
        size: usize,
        localOffset,
        mode: madeBy === 3 ? (ext >>> 16) & 0xffff : 0,
      });
      p = end + commentLen;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/** Where an entry lands, or a ZipError when it would escape `root`. */
export function safeTarget(root: string, name: string): string {
  const clean = name.replaceAll("\\", "/");
  if (!clean || isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || clean.split("/").includes(".."))
    throw new ZipError(`拒絕不安全的路徑：${name}`);
  const out = resolve(root, clean);
  const rel = relative(root, out);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new ZipError(`拒絕不安全的路徑：${name}`);
  return out;
}

function dataOffset(fd: number, e: ZipEntry): number {
  const h = readAt(fd, e.localOffset, 30);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new ZipError(`項目標頭損壞：${e.name}`);
  return e.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

/** Counts bytes and the CRC-32 of what flows through. */
class Check extends Transform {
  crc = 0;
  bytes = 0;
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
    this.crc = crc32(chunk, this.crc);
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

export interface ExtractOptions {
  onEntry?: (done: number, total: number, name: string) => void;
  signal?: AbortSignal;
}

/** Extract every entry of `file` into `dest` (created). */
export async function extractZip(
  file: string,
  dest: string,
  o: ExtractOptions = {},
): Promise<{ entries: number }> {
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const entries = listZip(file);
  const links: Array<{ at: string; target: string }> = [];
  const fd = openSync(file, "r");
  try {
    let done = 0;
    for (const e of entries) {
      if (o.signal?.aborted) throw o.signal.reason ?? new Error("aborted");
      const target = safeTarget(root, e.name);
      const type = e.mode & S_IFMT;
      if (e.flags & 1) throw new ZipError(`不支援加密項目：${e.name}`);
      if (e.name.endsWith("/") || type === S_IFDIR) {
        mkdirSync(target, { recursive: true });
      } else {
        if (e.method !== 0 && e.method !== 8) throw new ZipError(`不支援的壓縮方式 ${e.method}：${e.name}`);
        mkdirSync(dirname(target), { recursive: true });
        const start = dataOffset(fd, e);
        const check = new Check();
        const chunks: Buffer[] = [];
        const raw =
          e.compressedSize > 0
            ? createReadStream(file, { start, end: start + e.compressedSize - 1 })
            : Readable.from([]);
        const sink =
          type === S_IFLNK
            ? new Writable({
                write(c: Buffer, _e, cb) {
                  chunks.push(c);
                  cb();
                },
              })
            : createWriteStream(target, { mode: 0o600 });
        if (e.method === 8) await pipeline(raw, createInflateRaw(), check, sink);
        else await pipeline(raw, check, sink);
        if (check.bytes !== e.size || check.crc >>> 0 !== e.crc >>> 0)
          throw new ZipError(`項目校驗失敗（CRC/大小不符）：${e.name}`);
        if (type === S_IFLNK) links.push({ at: target, target: Buffer.concat(chunks).toString("utf8") });
        else chmodSync(target, e.mode & 0o777 ? e.mode & 0o777 : 0o644);
      }
      done++;
      o.onEntry?.(done, entries.length, e.name);
    }
  } finally {
    closeSync(fd);
  }
  // Links last, each checked to stay inside the destination.
  for (const l of links) {
    if (isAbsolute(l.target)) throw new ZipError(`拒絕指向外部的連結：${l.target}`);
    const resolved = resolve(dirname(l.at), l.target);
    const rel = relative(root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new ZipError(`拒絕指向外部的連結：${l.target}`);
    if (sep === "\\") continue; // Windows archives carry no links; never create one there
    symlinkSync(l.target, l.at);
  }
  return { entries: entries.length };
}
