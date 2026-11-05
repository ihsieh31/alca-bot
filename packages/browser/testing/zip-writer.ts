import { crc32, deflateRawSync } from "node:zlib";

/** Test-only zip writer: stored / deflate entries, Unix modes, symlinks, optional broken CRC. */
export interface ZipInput {
  name: string;
  data?: Buffer | string;
  /** Unix mode incl. type bits (0o100755, 0o120777 for a link, 0o040755 for a dir). */
  mode?: number;
  store?: boolean;
  /** Write a wrong CRC (to test the integrity check). */
  badCrc?: boolean;
}

export function makeZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const isDir = e.name.endsWith("/");
    const method = isDir || e.store ? 0 : 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = e.badCrc ? (crc32(raw) ^ 0xff) >>> 0 : crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    const mode = e.mode ?? (isDir ? 0o040755 : 0o100644);
    ch.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
