import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * `<prefix>_` + 26 Crockford chars (10 time + 16 random): the same shape as
 * protocol ids, so store-made ids (bots, workers, spills, …) validate there.
 * The store does not depend on the protocol package.
 */
export function newStoreId(prefix: string, now = Date.now()): string {
  let t = "";
  let rest = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD.charAt(rest % 32) + t;
    rest = Math.floor(rest / 32);
  }
  let r = "";
  for (const b of randomBytes(16)) r += CROCKFORD.charAt(b % 32);
  return `${prefix}_${t}${r}`;
}
