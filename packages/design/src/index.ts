import { fileURLToPath } from "node:url";

/** Absolute path of the shared token stylesheet, for servers that serve it. */
export const TOKENS_CSS_PATH = fileURLToPath(new URL("../tokens.css", import.meta.url));

/** Absolute path of the UI string table folder (R9.3), served as /ui/i18n/ and copied into the phone build. */
export const I18N_DIR = fileURLToPath(new URL("./i18n/", import.meta.url));
