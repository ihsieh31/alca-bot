// Node persistence for the account registry: one JSON file (0600), written
// atomically (@alca/os writeFileAtomic). The relay secret lives in its own 0600
// file next to it unless it is given in the environment.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "@alca/os";
import type { AccountSnapshot, AccountStore } from "./accounts.ts";

export class FileAccountStore implements AccountStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async load(): Promise<AccountSnapshot | undefined> {
    if (!existsSync(this.path)) return undefined;
    const v = JSON.parse(readFileSync(this.path, "utf8")) as AccountSnapshot;
    if (v?.v !== 1 || typeof v.accounts !== "object") throw new Error(`${this.path}: not an account file`);
    return v;
  }
  async save(s: AccountSnapshot): Promise<void> {
    writeFileAtomic(this.path, `${JSON.stringify(s)}\n`, { mode: 0o600 });
  }
}

/** `$ALCA_RELAY_SECRET`, else `<file>` (created with 32 random bytes, 0600, on first start). */
export function relaySecret(file: string, env: string | undefined = process.env.ALCA_RELAY_SECRET): string {
  if (env) return env;
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const s = randomBytes(32).toString("base64url");
  writeFileAtomic(file, `${s}\n`, { mode: 0o600 });
  return s;
}
