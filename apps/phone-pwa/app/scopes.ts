// BUG-14: what this phone may do (`chat`, `approve`, …) comes in Link's `ready`
// and, when the computer changes it while the phone is connected, as a
// `link` event `{type: "scopes", scopes}` (apps/desktop/src/link.ts setScopes).

/** A scope list from the wire, or undefined when it is not one. */
export function scopesFrom(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/** The new scopes a Link event carries, or undefined when it is not a scope change. */
export function scopesEvent(ch: string, e: unknown): string[] | undefined {
  if (ch !== "link" || !e || typeof e !== "object") return undefined;
  const l = e as { type?: unknown; scopes?: unknown };
  return l.type === "scopes" ? scopesFrom(l.scopes) : undefined;
}
