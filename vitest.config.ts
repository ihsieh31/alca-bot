import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** R9.3: the UI imports the shared string table as ./i18n/… (the server and the phone build put it there). */
const I18N = fileURLToPath(new URL("./packages/design/src/i18n/", import.meta.url));

export default defineConfig({
  resolve: { alias: [{ find: /^\.\/i18n\/(.+)$/, replacement: `${I18N}$1` }] },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "services/*/test/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: {
      forks: { execArgv: ["--disable-warning=ExperimentalWarning"] },
    },
  },
});
