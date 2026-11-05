import { readFileSync } from "node:fs";
import {
  ALWAYS_CONFIRM_ACTIONS,
  type AlwaysConfirmAction,
  REMOVED_KEYS,
  type Settings,
  SettingsSchema,
  type UserFacingKey,
} from "./schema.ts";

export class SettingsError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid settings: ${issues.join("; ")}`);
    this.name = "SettingsError";
    this.issues = issues;
  }
}

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

export function parseSettings(input: unknown): Settings {
  const r = SettingsSchema.safeParse(input);
  if (!r.success) {
    throw new SettingsError(
      r.error.issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`),
    );
  }
  return r.data;
}

/**
 * Drop the keys of REMOVED_KEYS from a parsed config.json (in place).
 * Returns the dotted paths that were there.
 */
export function stripRemovedKeys(raw: unknown): string[] {
  const dropped: string[] = [];
  if (typeof raw !== "object" || raw === null) return dropped;
  for (const key of REMOVED_KEYS) {
    const [page, leaf] = key.split(".") as [string, string];
    const holder = (raw as Record<string, unknown>)[page];
    if (typeof holder === "object" && holder !== null && Object.hasOwn(holder, leaf)) {
      delete (holder as Record<string, unknown>)[leaf];
      dropped.push(key);
    }
  }
  return dropped;
}

/**
 * Load config.json; a missing file means "all defaults". Keys an earlier
 * version wrote and this one no longer has are dropped with a warning.
 */
export function loadSettingsFile(path: string, warn: (line: string) => void = console.warn): Settings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultSettings();
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SettingsError([`${path}: not valid JSON`]);
  }
  for (const k of stripRemovedKeys(raw))
    warn(`config.json: 「${k}」已經不再使用，略過（下次儲存設定時會移除）`);
  return parseSettings(raw);
}

/** What the settings UI renders: the five pages, without engineering params. */
export function userFacingSettings(s: Settings): Pick<Settings, UserFacingKey> {
  const { models, connections, permissions, devices, advanced } = s;
  return { models, connections, permissions, devices, advanced };
}

export function isAlwaysConfirm(actionClass: string): actionClass is AlwaysConfirmAction {
  return (ALWAYS_CONFIRM_ACTIONS as readonly string[]).includes(actionClass);
}

/**
 * Does this action need a human yes before it runs?
 * - payment / send / delete / publish: always, regardless of level.
 * - confirm_each_step: every action except pure reads.
 * - autonomous: only the always-confirm classes.
 */
export function requiresConfirmation(s: Pick<Settings, "permissions">, actionClass: string): boolean {
  if (isAlwaysConfirm(actionClass)) return true;
  if (s.permissions.level === "confirm_each_step") return actionClass !== "read";
  return false;
}
