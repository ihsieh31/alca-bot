// Outside text (web pages, app results, emails, routine records, trigger
// events, worker and teammate reports) is put inside an <alca:…> fence so the
// model reads it as data. The fence only holds if the text cannot close it or
// open a tag of its own, so every Alca-looking tag in it is defused, whatever
// the case, spacing or line breaks a model might still read as a tag:
//   "</alca:page>", "</ALCA:PAGE >", "< /alca:page>", "<alca:memory-update>" → "‹/alca:page>" …
// The text stays readable; only the "<" turns into "‹".

const ALCA_TAG = /<(\s*\/?\s*)(alca\s*:)/gi;

/** Defuse every `<alca:…>` / `</alca:…>` look-alike in untrusted text. */
export function defuseAlcaTags(text: string): string {
  return text.replace(ALCA_TAG, "‹$1$2");
}
