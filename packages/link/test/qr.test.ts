import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeQr, qrSvg, qrTerminal } from "../src/qr.ts";

const hasZbar = (() => {
  try {
    execFileSync("zbarimg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Render to a PGM (6 px per module, quiet zone included) for a real decoder. */
function pgm(text: string): string {
  const q = encodeQr(text);
  const n = q.size + 8;
  const sc = 6;
  const rows: string[] = [];
  for (let y = 0; y < n * sc; y++) {
    const row: number[] = [];
    for (let x = 0; x < n * sc; x++) {
      const mx = Math.floor(x / sc) - 4;
      const my = Math.floor(y / sc) - 4;
      const dark = mx >= 0 && my >= 0 && mx < q.size && my < q.size && q.modules[my]?.[mx];
      row.push(dark ? 0 : 1);
    }
    rows.push(row.join(" "));
  }
  return `P2\n${n * sc} ${n * sc}\n1\n${rows.join("\n")}\n`;
}

describe("QR encoder", () => {
  it("picks the smallest version and renders SVG / terminal", () => {
    expect(encodeQr("hi").version).toBe(1);
    expect(encodeQr("x".repeat(100)).version).toBe(6);
    expect(encodeQr("x".repeat(120)).version).toBe(7);
    expect(() => encodeQr("x".repeat(300))).toThrow(RangeError);
    const svg = qrSvg(encodeQr("hi"), { label: "配對 QR" });
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 29 29"/);
    expect(qrTerminal(encodeQr("hi")).split("\n").length).toBe(13);
  });

  it.skipIf(!hasZbar)("decodes with a real reader (zbarimg) at versions 1–10", () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-qr-"));
    const texts = [
      "hi",
      "https://alca.example/#pair=381204957&fp=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd",
      "配對：381-204-957",
      "x".repeat(150),
      "y".repeat(213),
    ];
    for (const [i, t] of texts.entries()) {
      const f = join(dir, `${i}.pgm`);
      writeFileSync(f, pgm(t));
      const out = execFileSync("zbarimg", ["-q", "--raw", f], { stdio: ["ignore", "pipe", "ignore"] })
        .toString("utf8")
        .trim();
      expect(out).toBe(t);
    }
  });
});
