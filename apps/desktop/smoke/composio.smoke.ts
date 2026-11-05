import { ComposioClient } from "@alca/connectors";
import { describe, expect, it } from "vitest";
import { env } from "./helpers.ts";

const KEY = env("ALCA_SMOKE_COMPOSIO_KEY");

// Read-only: checks the key, opens (or reuses) a session for a fixed smoke
// user id, lists that user's connected accounts and searches the Gmail tools.
describe.skipIf(!KEY)("smoke × Composio (your own account, read-only)", () => {
  const client = new ComposioClient({
    baseUrl: env("ALCA_SMOKE_COMPOSIO_BASE") ?? "https://backend.composio.dev/api/v3.1",
    apiKey: async () => KEY,
  });
  const user = env("ALCA_SMOKE_COMPOSIO_USER") ?? "alca-smoke";

  it("accepts the key and answers the calls Alca makes", async () => {
    await client.checkKey(KEY as string);
    const session = await client.createSession(user);
    expect(session).toBeTruthy();
    const accounts = await client.accounts(user);
    expect(Array.isArray(accounts)).toBe(true);
    const tools = await client.searchTools({ toolkits: ["gmail"], query: "search mail", limit: 3 });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]?.slug).toMatch(/^GMAIL_/);
  }, 60_000);

  it("never puts the key into an error message", async () => {
    const bad = new ComposioClient({
      baseUrl: env("ALCA_SMOKE_COMPOSIO_BASE") ?? "https://backend.composio.dev/api/v3.1",
      apiKey: async () => `${KEY}-wrong`,
    });
    const e = await bad.accounts(user).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect(String((e as Error).message)).not.toContain(KEY as string);
  }, 60_000);
});
