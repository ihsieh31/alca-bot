// The account registry on Durable Object storage: one key per account
// (`acct:<hash>`), so no value grows past the storage limit; a save writes
// only the accounts that changed and deletes the ones that are gone.
import type { AccountSnapshot, AccountStore, ComputerEntry } from "@alca/rendezvous/accounts";
import type { DurableStorage } from "./cf-types.ts";

const PREFIX = "acct:";

export class DurableAccountStore implements AccountStore {
  private last = new Map<string, string>();
  private readonly storage: DurableStorage;
  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  async load(): Promise<AccountSnapshot> {
    const rows = await this.storage.list<ComputerEntry[]>({ prefix: PREFIX });
    const accounts: Record<string, ComputerEntry[]> = {};
    for (const [k, v] of rows) {
      const acct = k.slice(PREFIX.length);
      accounts[acct] = v;
      this.last.set(acct, JSON.stringify(v));
    }
    return { v: 1, accounts };
  }

  async save(s: AccountSnapshot): Promise<void> {
    const put: Record<string, unknown> = {};
    const now = new Map<string, string>();
    for (const [acct, list] of Object.entries(s.accounts)) {
      const j = JSON.stringify(list);
      now.set(acct, j);
      if (this.last.get(acct) !== j) put[PREFIX + acct] = list;
    }
    const gone = [...this.last.keys()].filter((a) => !now.has(a)).map((a) => PREFIX + a);
    if (Object.keys(put).length) await this.storage.put(put);
    if (gone.length) await this.storage.delete(gone);
    this.last = now;
  }
}
