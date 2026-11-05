// QR code encoder (ISO/IEC 18004): byte mode, error correction level M,
// versions 1–10 (up to 213 bytes, plenty for a pairing link). Written from
// the public standard; no dependency. Output is a square boolean matrix
// (true = dark) plus SVG and terminal renderers.

// Per version: EC codewords per block, then [blocks, data codewords] groups (level M).
const BLOCKS_M: ReadonlyArray<[number, Array<[number, number]>]> = [
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [
    22,
    [
      [2, 38],
      [2, 39],
    ],
  ],
  [
    22,
    [
      [3, 36],
      [2, 37],
    ],
  ],
  [
    26,
    [
      [4, 43],
      [1, 44],
    ],
  ],
];
const ALIGN: ReadonlyArray<number[]> = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
}
const gmul = (a: number, b: number) =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number);

function rsGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] = (next[j] as number) ^ (g[j] as number);
      next[j + 1] = (next[j + 1] as number) ^ gmul(g[j] as number, EXP[i] as number);
    }
    g = next;
  }
  return g;
}

function rsRemainder(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (rem.shift() as number);
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] = (rem[i] as number) ^ gmul(gen[i + 1] as number, factor);
  }
  return rem;
}

const dataCapacity = (v: number) => {
  const [, groups] = BLOCKS_M[v - 1] as [number, Array<[number, number]>];
  return groups.reduce((n, [b, d]) => n + b * d, 0);
};

function encodeData(bytes: Uint8Array, version: number): number[] {
  const cap = dataCapacity(version) * 8;
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < cap / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function interleave(data: number[], version: number): number[] {
  const [ec, groups] = BLOCKS_M[version - 1] as [number, Array<[number, number]>];
  const blocks: number[][] = [];
  let o = 0;
  for (const [count, size] of groups)
    for (let i = 0; i < count; i++) {
      blocks.push(data.slice(o, o + size));
      o += size;
    }
  const ecBlocks = blocks.map((b) => rsRemainder(b, ec));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i] as number);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i] as number);
  return out;
}

export interface QrCode {
  version: number;
  size: number;
  /** modules[y][x], true = dark. */
  modules: boolean[][];
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Matrix {
  readonly size: number;
  readonly m: boolean[][];
  readonly fn: boolean[][];
  readonly version: number;
  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.m = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    (this.m[y] as boolean[])[x] = dark;
    (this.fn[y] as boolean[])[x] = true;
  }
  functionPatterns() {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [s - 4, 3],
      [3, s - 4],
    ] as const)
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= s || y >= s) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
    const pos = ALIGN[this.version - 1] as number[];
    const last = pos.length - 1;
    for (let i = 0; i < pos.length; i++)
      for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            this.set(
              (pos[i] as number) + dx,
              (pos[j] as number) + dy,
              Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
            );
      }
    this.format(0);
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = s - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, dark);
        this.set(b, a, dark);
      }
    }
  }
  format(mask: number) {
    const data = (0b00 << 3) | mask; // level M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const s = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i));
    this.set(8, s - 8, true);
  }
  place(codewords: number[]) {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const up = ((right + 1) & 2) === 0;
          const y = up ? s - 1 - vert : vert;
          if ((this.fn[y] as boolean[])[x] || i >= codewords.length * 8) continue;
          (this.m[y] as boolean[])[x] = (((codewords[i >>> 3] as number) >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
    }
  }
  applyMask(mask: number) {
    const f = MASKS[mask] as (x: number, y: number) => boolean;
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (!(this.fn[y] as boolean[])[x] && f(x, y))
          (this.m[y] as boolean[])[x] = !(this.m[y] as boolean[])[x];
  }
  penalty(): number {
    const s = this.size;
    const at = (x: number, y: number) => (this.m[y] as boolean[])[x] as boolean;
    let p = 0;
    for (const horiz of [true, false])
      for (let a = 0; a < s; a++) {
        let run = 1;
        const line: boolean[] = [];
        for (let b = 0; b < s; b++) line.push(horiz ? at(b, a) : at(a, b));
        for (let b = 1; b <= s; b++) {
          if (b < s && line[b] === line[b - 1]) run++;
          else {
            if (run >= 5) p += run - 2;
            run = 1;
          }
        }
        const str = line.map((d) => (d ? "1" : "0")).join("");
        for (const pat of ["10111010000", "00001011101"]) {
          let k = str.indexOf(pat);
          while (k !== -1) {
            p += 40;
            k = str.indexOf(pat, k + 1);
          }
        }
      }
    for (let y = 0; y < s - 1; y++)
      for (let x = 0; x < s - 1; x++) {
        const c = at(x, y);
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) p += 3;
      }
    let dark = 0;
    for (const row of this.m) for (const d of row) if (d) dark++;
    p += Math.floor(Math.abs((dark * 100) / (s * s) - 50) / 5) * 10;
    return p;
  }
}

export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const header = 4 + (v < 10 ? 8 : 16);
    if (header + bytes.length * 8 <= dataCapacity(v) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new RangeError("text too long for a QR code (max 213 bytes)");
  const codewords = interleave(encodeData(bytes, version), version);
  let best: Matrix | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const mx = new Matrix(version);
    mx.functionPatterns();
    mx.place(codewords);
    mx.applyMask(mask);
    mx.format(mask);
    const score = mx.penalty();
    if (score < bestScore) {
      best = mx;
      bestScore = score;
    }
  }
  const m = best as Matrix;
  return { version, size: m.size, modules: m.m };
}

/** One <path> of unit squares, with a quiet zone of 4 modules. Colors come from CSS (currentColor). */
export function qrSvg(q: QrCode, o: { label?: string } = {}): string {
  const n = q.size + 8;
  let d = "";
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++) if ((q.modules[y] as boolean[])[x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  const label = o.label ? ` role="img" aria-label="${o.label.replace(/[<>&"]/g, "")}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"${label}><path fill="currentColor" d="${d}"/></svg>`;
}

/** Two modules per character row (▀▄█), for terminals; dark-on-light so phones read it. */
export function qrTerminal(q: QrCode): string {
  const at = (x: number, y: number) =>
    y >= 0 && y < q.size && x >= 0 && x < q.size && (q.modules[y] as boolean[])[x];
  const lines: string[] = [];
  for (let y = -2; y < q.size + 2; y += 2) {
    let line = "";
    for (let x = -2; x < q.size + 2; x++) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
