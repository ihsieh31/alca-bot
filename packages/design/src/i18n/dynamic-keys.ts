// R9.4 rule 4: keys the UI builds at run time (`tKey(\`…${x}\`)`), so the
// unused-key check does not flag them. Keep it short: prefer a literal t("…").
export const DYNAMIC_KEYS: readonly string[] = [];
