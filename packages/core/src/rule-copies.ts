// R9.6: English copies of standing rules that started out Chinese only (the
// router's and the worker's). The module defining a rule list registers its
// English copy here; buildStablePrompt swaps each Chinese line for its copy
// when the bot's language is English. The Chinese prompt is byte-identical to
// what it was, so its prompt cache is untouched. No imports: prompt.ts and the
// rule modules both read it without a cycle.

const EN = new Map<string, string>();

/** Register `en` as the English copy of `zh`, line by line (same length, same order). */
export function registerEnglish(zh: readonly string[], en: readonly string[]): void {
  if (zh.length !== en.length)
    throw new Error("rule copies: the English list must match the Chinese one line by line");
  for (let i = 0; i < zh.length; i++) EN.set(zh[i] as string, en[i] as string);
}

/** A rule line in the language asked for (a line without a registered copy stays as it is). */
export function ruleIn(line: string, language: "zh" | "en"): string {
  return language === "en" ? (EN.get(line) ?? line) : line;
}
