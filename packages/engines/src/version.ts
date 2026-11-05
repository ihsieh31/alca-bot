import { readFileSync } from "node:fs";

/**
 * Alca's version as the engines report it to the CLIs they drive (ACP
 * `clientInfo`, the MCP servers' `info`), read from this package's
 * package.json — the one version every manifest carries (`pnpm check:versions`
 * fails on a literal written into source instead).
 */
export const ALCA_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
