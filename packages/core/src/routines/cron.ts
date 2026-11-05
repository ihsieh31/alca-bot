/**
 * Five-field cron (minute hour day-of-month month day-of-week) evaluated in
 * an IANA time zone. Fields take `*`, numbers, ranges `a-b`, steps `*\/n` and
 * `a-b/n`, lists, and month / weekday names (jan…dec, sun…sat; 7 = sun).
 * Day-of-month and day-of-week follow the classic rule: when both are
 * restricted, either one matching is enough. A wall time that does not exist
 * (a spring-forward gap) is skipped; a repeated one fires the first time.
 */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function field(src: string, min: number, max: number, names?: string[], offset = 0): Set<number> {
  const out = new Set<number>();
  const num = (s: string) => {
    const i = names?.indexOf(s.toLowerCase()) ?? -1;
    const n = i >= 0 ? i + offset : Number(s);
    if (!Number.isInteger(n)) throw new CronError(`看不懂「${s}」`);
    return n;
  };
  for (const part of src.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`間隔「${stepS}」不對`);
    let lo: number;
    let hi: number;
    if (range === "*" || range === undefined) {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = num(a ?? "");
      hi = num(b ?? "");
    } else {
      lo = num(range);
      hi = stepS === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`「${part}」超出範圍 ${min}–${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError("cron 要五個欄位：分 時 日 月 星期");
  const [mi, h, dm, mo, dw] = parts as [string, string, string, string, string];
  const dow = field(dw, 0, 7, DAYS);
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: field(mi, 0, 59),
    hour: field(h, 0, 23),
    dom: field(dm, 1, 31),
    month: field(mo, 1, 12, MONTHS, 1),
    dow,
    domAny: dm === "*" || dm.startsWith("*/"),
    dowAny: dw === "*" || dw.startsWith("*/"),
  };
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function wall(d: Date, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return {
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    dow: DAYS.indexOf((p.weekday ?? "").slice(0, 3).toLowerCase()),
  };
}

/** The first matching minute strictly after `after`, in `tz`; undefined if none within ~4 years. */
export function nextCron(spec: CronSpec | string, tz: string, after: Date): Date | undefined {
  const s = typeof spec === "string" ? parseCron(spec) : spec;
  if (!isTimeZone(tz)) throw new CronError(`沒有這個時區：${tz}`);
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 4 * 366 * 24 * 3600_000;
  while (t < limit) {
    const w = wall(new Date(t), tz);
    const dayOk =
      s.domAny && s.dowAny
        ? true
        : s.domAny
          ? s.dow.has(w.dow)
          : s.dowAny
            ? s.dom.has(w.day)
            : s.dom.has(w.day) || s.dow.has(w.dow);
    if (!s.month.has(w.month) || !dayOk) {
      // Jump to the next local midnight (at least one minute).
      t += Math.max(1, (23 - w.hour) * 60 + (60 - w.minute)) * 60_000;
      continue;
    }
    if (!s.hour.has(w.hour)) {
      t += (60 - w.minute) * 60_000;
      continue;
    }
    if (!s.minute.has(w.minute)) {
      t += 60_000;
      continue;
    }
    return new Date(t);
  }
  return undefined;
}

/** A plain description of a cron in Traditional Chinese, for the routines view. */
export function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [mi, h, dm, mo, dw] = p as [string, string, string, string, string];
  const time = /^\d+$/.test(mi) && /^\d+$/.test(h) ? `${h.padStart(2, "0")}:${mi.padStart(2, "0")}` : "";
  if (time && dm === "*" && mo === "*" && dw === "*") return `每天 ${time}`;
  if (time && dm === "*" && mo === "*" && dw === "1-5") return `平日 ${time}`;
  const names = ["日", "一", "二", "三", "四", "五", "六", "日"];
  if (time && dm === "*" && mo === "*" && /^\d$/.test(dw)) return `每週${names[Number(dw)]} ${time}`;
  if (/^\*\/\d+$/.test(mi) && h === "*" && dm === "*" && mo === "*" && dw === "*")
    return `每 ${mi.slice(2)} 分鐘`;
  return expr;
}
