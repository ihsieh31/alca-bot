// Next-round §5.4: the bot editor's sandbox draft — pure, no DOM (tested in
// apps/desktop/test/sandbox-routes.test.ts).

export type SandboxMode = "auto" | "on" | "off";
export type SandboxNetwork = "open" | "none";

export interface SandboxDraft {
  mode: SandboxMode;
  network: SandboxNetwork;
  extra: string;
}

/** The stored JSON text as a draft (anything unreadable is the default). */
export function sandboxDraft(stored: string | null | undefined): SandboxDraft {
  let v: Record<string, unknown> = {};
  try {
    v = stored ? (JSON.parse(stored) as Record<string, unknown>) : {};
  } catch {
    v = {};
  }
  const mode: SandboxMode = v.mode === "on" || v.mode === "off" ? v.mode : "auto";
  const network: SandboxNetwork = v.network === "none" ? "none" : "open";
  const extra = Array.isArray(v.extraWritable)
    ? v.extraWritable.filter((p): p is string => typeof p === "string").join("\n")
    : "";
  return { mode, network, extra };
}

/** The body to send, or undefined when nothing changed. */
export function sandboxBody(
  start: SandboxDraft,
  d: SandboxDraft,
): { mode: SandboxMode; network: SandboxNetwork; extraWritable: string[] } | undefined {
  const lines = (s: string) =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const same =
    start.mode === d.mode &&
    start.network === d.network &&
    lines(start.extra).join("\n") === lines(d.extra).join("\n");
  return same ? undefined : { mode: d.mode, network: d.network, extraWritable: lines(d.extra) };
}
