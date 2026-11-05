// R9.10: screenshots in a chosen interface language. ALCA_SHOTS_LOCALE=en takes
// every desktop and phone shot in English; unset (or zh-Hant-TW) keeps 繁中.
// The browser's language is enough: the core's advanced.locale and the phone's
// own setting default to `auto`, which follows navigator.language.
export const SHOTS_LOCALE: "zh-Hant-TW" | "en" = process.env.ALCA_SHOTS_LOCALE === "en" ? "en" : "zh-Hant-TW";
/** The browser context's locale (navigator.language) for that language. */
export const browserLocale = SHOTS_LOCALE === "en" ? "en-US" : "zh-TW";
