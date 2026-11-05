import type { Migration } from "../migrate.ts";
import { SEAL_GATED as GATED_V25 } from "./0025-seal.ts";

/**
 * Proactivity item 4 (migration 30): `offers.text` and `offers.action` are
 * sealed columns (`SEALED.offers`). An add-on offer (主動留意) is written from
 * mail and calendar evidence — 「週五前要回 王小明 的報價信」 — and its
 * action is the worker task built from the same facts, so both sat in the
 * database in plaintext although the mail itself never does. `topic` (a short
 * key a 別再提這類 matches on), `category` and the evidence ids stay plain (`topic` is sealed since migration 31).
 *
 * 1. `seal_gate` gains the fixed row `offers`. Its CHECK lists the guarded
 *    tables and a STRICT CHECK cannot be altered, so the table is made again
 *    (one closed row per guarded table, the three "fixed" triggers recreated; a gate is only ever open inside the pass's own transaction, so none is open here).
 *    It is dropped and created under its own name, never renamed, so the
 *    triggers of the other tables that read it keep pointing at it.
 * 2. `offers_owner_fixed` ("an offer is not rewritten") lets one UPDATE
 *    through, the same exception as migration 25's tables: with the `offers`
 *    gate open, `text` going from plaintext to the sealed form while
 *    `bot_id`, `source` and `created_at` stay as they were. `action` has no
 *    such trigger (it never had one).
 * 3. `meta.seal_progress` forgets `done`, `clean` and any `offers` position,
 *    so the background pass seals the offers already stored, and every backup
 *    taken until it finishes again counts as plaintext (as migration 28).
 */

export const SEAL_GATED = [...GATED_V25, "offers"] as const;

const sealed = (x: string) => `((CASE WHEN json_valid(${x}) THEN json_extract(${x}, '$."$enc"') END) IS 1)`;
const gateOpen = (tbl: string) => `EXISTS (SELECT 1 FROM seal_gate WHERE tbl = '${tbl}' AND open = 1)`;
const toSealed = (col: string) => `(NOT ${sealed(`OLD.${col}`)} AND ${sealed(`NEW.${col}`)})`;

export const sealOffersSchema: Migration = {
  version: 30,
  name: "seal offers.text / offers.action; seal gate row for offers",
  sql: `
DROP TABLE seal_gate;
CREATE TABLE seal_gate (
  tbl  TEXT PRIMARY KEY CHECK (tbl IN (${SEAL_GATED.map((t) => `'${t}'`).join(",")})),
  open INTEGER NOT NULL DEFAULT 0 CHECK (open IN (0, 1))
) STRICT;
INSERT INTO seal_gate (tbl, open) VALUES ${SEAL_GATED.map((t) => `('${t}', 0)`).join(", ")};
CREATE TRIGGER seal_gate_no_insert BEFORE INSERT ON seal_gate
BEGIN SELECT RAISE(ABORT, 'seal gates are fixed'); END;
CREATE TRIGGER seal_gate_no_delete BEFORE DELETE ON seal_gate
BEGIN SELECT RAISE(ABORT, 'seal gates are fixed'); END;
CREATE TRIGGER seal_gate_fixed BEFORE UPDATE OF tbl ON seal_gate
BEGIN SELECT RAISE(ABORT, 'seal gates are fixed'); END;

DROP TRIGGER offers_owner_fixed;
CREATE TRIGGER offers_owner_fixed BEFORE UPDATE OF bot_id, source, text, created_at ON offers
WHEN NOT (${gateOpen("offers")} AND ${toSealed("text")}
  AND NEW.bot_id IS OLD.bot_id AND NEW.source IS OLD.source AND NEW.created_at IS OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'an offer is not rewritten'); END;

UPDATE meta SET v = json_remove(v, '$.done', '$.clean', '$.offers')
  WHERE k = 'seal_progress' AND json_valid(v);
`,
};
