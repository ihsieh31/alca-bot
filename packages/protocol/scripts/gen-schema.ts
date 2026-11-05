// Writes the JSON Schemas in spec/ from the zod sources of truth.
// `--check` exits non-zero when a committed file is stale (used in CI).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../src/events.ts";
import {
  renderAgentsJsonSchema,
  renderBrowserJsonSchema,
  renderJsonSchema,
  renderLearningJsonSchema,
} from "../src/json-schema.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const files: Array<[string, string]> = [
  [resolve(root, `spec/alca-event-protocol.v${PROTOCOL_VERSION}.schema.json`), renderJsonSchema()],
  [resolve(root, `spec/alca-browser-channel.v${PROTOCOL_VERSION}.schema.json`), renderBrowserJsonSchema()],
  [resolve(root, `spec/alca-agents-channel.v${PROTOCOL_VERSION}.schema.json`), renderAgentsJsonSchema()],
  [resolve(root, `spec/alca-learning-channel.v${PROTOCOL_VERSION}.schema.json`), renderLearningJsonSchema()],
];

let stale = false;
for (const [target, next] of files) {
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      // missing file is stale
    }
    if (current !== next) {
      console.error(`spec is stale: ${target}\nrun \`pnpm spec:gen\` and commit the result`);
      stale = true;
    } else console.log(`spec up to date: ${target}`);
  } else {
    writeFileSync(target, next);
    console.log(`wrote ${target}`);
  }
}
if (stale) process.exit(1);
