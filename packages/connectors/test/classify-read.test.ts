import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "@alca/config";
import { openStore, type Store } from "@alca/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyAppTool, plainlyRead } from "../src/classify.ts";
import { ConnectorService } from "../src/service.ts";
import { connectorTools } from "../src/tools.ts";
import { FileKeySource, Vault } from "../src/vault.ts";
import { type MockComposio, startMockComposio } from "../testing/mock-composio.ts";

/** Mac test 2026-11 B9: reading a calendar is a read, and no account means no card. Fictional data only. */

describe("plainlyRead (B9)", () => {
  it("a LIST / GET / SEARCH / FIND / FETCH name with nothing else is a read", () => {
    for (const s of [
      "GOOGLECALENDAR_EVENTS_LIST",
      "GOOGLECALENDAR_LIST_CALENDARS",
      "GMAIL_FETCH_EMAILS",
      "GITHUB_GET_REPOSITORY",
      "NOTION_SEARCH_PAGES",
      "SLACK_FIND_USERS",
    ])
      expect(plainlyRead(s), s).toBe(true);
  });

  it("CREATE, SEND, DELETE, UPDATE and chained or bulk names never are", () => {
    for (const s of [
      "GOOGLECALENDAR_CREATE_EVENT",
      "GOOGLECALENDAR_EVENTS_LIST_AND_DELETE",
      "GMAIL_SEND_EMAIL",
      "GMAIL_GET_AND_FORWARD_EVERYTHING",
      "GMAIL_GET_THEN_DELETE_ALL",
      "NOTION_UPDATE_PAGE",
      "SLACK_FIND_AND_INVITE",
      "DRIVE_LIST_FILES_TO_TRASH",
      "GITHUB_GET_AND_MERGE",
      "CRM_FIND_OR_CREATE_CONTACT",
      "SHEETS_GET_BULK_WIPE",
      "STRIPE_LIST_CHARGES_REFUND",
      "GMAIL_LIST_DRAFTS_ADD_LABEL",
    ])
      expect(plainlyRead(s), s).toBe(false);
  });

  it("the tag-based classifier is unchanged for the classes that ask", () => {
    expect(classifyAppTool("GOOGLECALENDAR_CREATE_EVENT", [])).toBe("publish");
    expect(classifyAppTool("GMAIL_SEND_EMAIL", [])).toBe("send");
    expect(classifyAppTool("GMAIL_DELETE_MESSAGE", [])).toBe("delete");
    expect(classifyAppTool("NOTION_UPDATE_PAGE", ["updateHint"])).toBe("write");
  });
});

describe("a connector call without a usable account (B9)", () => {
  let dir: string;
  let store: Store;
  let mock: MockComposio;
  let svc: ConnectorService;
  let bot: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "alca-classify-"));
    store = openStore(join(dir, "s.sqlite"));
    bot = store.bots.ensureDefault().id;
    mock = await startMockComposio();
    const vault = new Vault(join(dir, "vault.json"), new FileKeySource(join(dir, "vault.key")));
    const s = parseSettings({ engineering: { connectors: { composioBaseUrl: mock.baseUrl } } });
    svc = new ConnectorService({ store, vault, settings: () => s });
  });
  afterEach(async () => {
    await mock.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a tool the provider cannot describe: a plain read stays a read, anything else still fails closed", async () => {
    expect(await svc.classOf("GOOGLECALENDAR_EVENTS_LIST_FICTIONAL")).toBe("read");
    expect(await svc.classOf("GOOGLECALENDAR_CREATE_FICTIONAL")).toBe("send");
    expect(await svc.classOf("GMAIL_GET_AND_FORWARD_EVERYTHING")).toBe("send");
    expect(await svc.classOf("GMAIL_GET_THEN_DELETE_ALL")).toBe("delete");
  });

  it("no account: the inspection fails (no card, no 「?」 label) and the run answers with the error", async () => {
    const use = connectorTools(svc, store).find((t) => t.spec.name === "connector_use_tool");
    const args = { slug: "GOOGLECALENDAR_EVENTS_LIST", arguments: {} };
    await expect(
      use?.inspect?.(args, { signal: AbortSignal.timeout(5000), threadId: "thr_x", botId: bot }),
    ).rejects.toThrow(/沒有可以用的/);
    const out = await use?.run(args, AbortSignal.timeout(5000), {
      actionClass: "read",
      threadId: "thr_x",
      runId: "run_x",
      botId: bot,
    });
    expect(String(out)).toMatch(/沒有可以用的/);
    expect(String(out)).not.toContain("「?」");
    expect(mock.executed).toHaveLength(0);
  });
});
