// Review 2026-11-05: iOS focus zoom (16px fields) and 44pt tap areas, checked on the stylesheets.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("../styles/", import.meta.url);
const css = (f: string) => readFileSync(new URL(f, DIR), "utf8");
const ALL = readdirSync(DIR)
  .filter((f) => f.endsWith(".css"))
  .map((f) => [f, css(f)] as const);

/** Every top-level rule body for a selector list that equals `sel` (comments stripped). */
function rule(src: string, sel: string): string {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(clean);
  if (!m) throw new Error(`no rule for ${sel}`);
  return m[2] as string;
}

const FIELDS = [
  ["chat.css", ".composer-input"],
  ["views.css", ".field-input"],
  ["memory.css", ".search-input"],
  ["memory.css", ".field-area"],
  ["browser.css", ".bv-input"],
  ["forms.css", ".field-pair .field-input"],
  ["screens.css", ".pair-advanced .field-input"],
  ["addons.css", ".ad-model"],
] as const;

describe("phone: text fields never under 16px (iOS focus zoom, review #4)", () => {
  it("the field size token is clamped at 16px and every input / textarea / select gets it", () => {
    expect(css("plain.css")).toMatch(/--t-field:\s*max\(16px, var\(--t-body\)\)/);
    expect(css("base.css")).toMatch(/\n\ninput,\ntextarea,\nselect \{\s*font-size: var\(--t-field\);/);
  });

  it("every field rule that sets its own size keeps the 16px floor", () => {
    for (const [f, sel] of FIELDS) {
      const size = /font-size:\s*([^;]+);/.exec(rule(css(f), sel))?.[1] ?? "";
      expect(size, `${f} ${sel}`).toMatch(/^(var\(--t-field\)|max\(16px, .+\))$/);
    }
  });

  it("no rule for a field class sets a bare --t-body / smaller size", () => {
    let seen = 0;
    for (const [f, src] of ALL)
      for (const m of src.matchAll(
        /\n([^\n{}]*(?:input|textarea|select|field-area|ad-model)[^\n{}]*)\{([^}]*)\}/g,
      )) {
        const size = /font-size:\s*([^;]+);/.exec(m[2] as string)?.[1];
        if (!size || /placeholder|switch/.test(m[1] as string)) continue;
        seen++;
        expect(size, `${f} ${m[1]}`).toMatch(/--t-field|max\(16px|--t-title|--t-large/);
      }
    expect(seen).toBeGreaterThanOrEqual(FIELDS.length);
  });
});

describe("phone: 44pt tap areas without growing the visuals (review #6 / #7)", () => {
  const base = css("base.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const SMALL = [
    ".send-btn",
    ".q-send",
    ".td-copy",
    ".to-chip-x",
    ".rc-retry",
    ".filter-btn",
    ".bv-handback",
    ".bv-space",
    ".offer-card .offer-acts .btn",
    ".act-sum",
    "button.act-row",
  ];
  it("each small control gets an invisible ::before hit area of at least var(--touch)", () => {
    const m =
      /\n([^{}]*::before[^{}]*)\{([^}]*inset: min\(0px, calc\(\(100% - var\(--touch\)\) \/ 2\)\)[^}]*)\}/.exec(
        base,
      );
    expect(m).not.toBeNull();
    const sels = (m?.[1] ?? "").split(",").map((x) => x.trim());
    for (const s of SMALL) expect(sels, s).toContain(`${s}::before`);
    expect(m?.[2]).toContain('content: ""');
    expect(m?.[2]).toContain("position: absolute");
    expect(m?.[2]).not.toMatch(/background|border|box-shadow/);
    const anchor = new RegExp(
      `\\n${SMALL.map((s) => s.replace(/[.]/g, "\\.")).join(",\\n")} \\{\\s*position: relative;`,
    );
    expect(base).toMatch(anchor);
  });

  it("the drawn sizes stay as designed (no visual growth)", () => {
    const send = rule(css("chat.css"), ".send-btn");
    expect(send).toContain("width: 32px");
    expect(send).toContain("height: 32px");
    expect(rule(css("team.css"), ".to-chip-x")).toContain("width: 32px");
    expect(rule(css("views.css"), ".q-send")).toContain("width: 32px");
  });

  it("the model menu (a <select>, no ::before) is 44pt tall with the extra given back", () => {
    const m = rule(css("addons.css"), ".ad-model");
    expect(m).toContain("min-height: var(--touch)");
    expect(m).toContain("margin-block: -6px");
  });
});

describe("phone: quiet text stays readable (review #8)", () => {
  const plain = css("plain.css");
  const block = (start: string) => {
    const i = plain.indexOf(start);
    return plain.slice(i, plain.indexOf("}", i));
  };
  const token = (b: string, name: string): string => {
    const v = new RegExp(`--${name}:\\s*([^;]+);`).exec(b)?.[1]?.trim() ?? "";
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(v);
    return ref ? token(b, ref[1] as string) : v;
  };
  const hex = (v: string) => [1, 3, 5].map((i) => Number.parseInt(v.slice(i, i + 2), 16));
  const lum = (c: number[]) => {
    const [r, g, b] = c.map((x) => {
      const s = x / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
    return (x + 0.05) / (y + 0.05);
  };
  /** --fill is rgb(120 120 128 / a) over the page. */
  const fillOver = (b: string, bg: number[]) => {
    const a = Number(/--fill:\s*rgb\(120 120 128 \/ ([0-9.]+)\)/.exec(b)?.[1]);
    return [120, 120, 128].map((c, i) => Math.round(c * a + (bg[i] as number) * (1 - a)));
  };

  for (const [name, start] of [
    ["dark", ":root:is([data-theme]"],
    ["light", ':root[data-theme="light"]'],
    ["light (system)", ":root:not([data-theme])"],
  ] as const)
    it(`${name}: placeholders ≥ 4.5:1 on a field, white on the count capsule ≥ 4.5:1`, () => {
      const b = block(start);
      const bg = hex(token(b, "bg") || token(block(":root:is([data-theme]"), "bg"));
      const ph = hex(token(b, "placeholder"));
      expect(ratio(ph, fillOver(b, bg))).toBeGreaterThanOrEqual(4.5);
      expect(ratio([255, 255, 255], hex(token(b, "count-fill")))).toBeGreaterThanOrEqual(4.5);
    });

  it("no placeholder uses --label-3; the count capsule uses its own fill", () => {
    for (const [f, src] of ALL)
      for (const m of src.matchAll(/::placeholder\s*\{([^}]*)\}/g))
        expect(m[1], f).toContain("var(--placeholder)");
    expect(rule(css("base.css"), ".count")).toContain("background: var(--count-fill)");
  });
});

describe("phone: no dead rules (review #19)", () => {
  it("rules for classes nothing renders are gone", () => {
    const all = ALL.map(([, src]) => src).join("\n");
    for (const sel of [/\n\.dot \{/, /\.icon-btn\.inverse/, /\.wordmark/, /\.stale-note/, /\.switch[[:\s,{]/])
      expect(all).not.toMatch(sel);
  });
});
