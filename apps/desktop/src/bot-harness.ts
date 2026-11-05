import { type BotHarnessConfig, HARNESS_KINDS, parseBotHarness } from "@alca/core";
import { tSource } from "@alca/design/i18n";

/**
 * Phase 6: the bot editor's 進階 harness settings — the default harness, the
 * independent reviewer switch and the budget caps per harness. What the
 * editor sends replaces those; the per-harness engine and model it does not
 * show are kept from what is stored. Everything goes through
 * `parseBotHarness` (unknown keys dropped, numbers clamped), and a cap can
 * only lower the harness default when a worker starts (`resolveBudget`):
 * nothing here can widen a budget or a permission.
 *
 * Returns the JSON to store, or null for "all defaults".
 */
export function mergeBotHarness(stored: string | null | undefined, sent: unknown): string | null {
  if (sent === null) return keepEngines(parseBotHarness(stored));
  if (!sent || typeof sent !== "object" || Array.isArray(sent))
    throw new Error(tSource("core.harness.notObject"));
  const next = parseBotHarness(sent);
  const was = parseBotHarness(stored);
  const out: BotHarnessConfig = {};
  if (next.default) out.default = next.default;
  if (next.reviewer) out.reviewer = true;
  for (const kind of HARNESS_KINDS) {
    const n = next[kind] ?? {};
    const w = was[kind] ?? {};
    const one = {
      ...(w.engineId ? { engineId: w.engineId } : {}),
      ...(w.model ? { model: w.model } : {}),
      ...(n.maxSteps ? { maxSteps: n.maxSteps } : {}),
      ...(n.maxWallSec ? { maxWallSec: n.maxWallSec } : {}),
      ...(n.maxTokens ? { maxTokens: n.maxTokens } : {}),
    };
    if (Object.keys(one).length) out[kind] = one;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** "Reset to defaults" still keeps the per-harness engine and model (set elsewhere). */
function keepEngines(was: BotHarnessConfig): string | null {
  const out: BotHarnessConfig = {};
  for (const kind of HARNESS_KINDS) {
    const w = was[kind];
    const one = {
      ...(w?.engineId ? { engineId: w.engineId } : {}),
      ...(w?.model ? { model: w.model } : {}),
    };
    if (Object.keys(one).length) out[kind] = one;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
