import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRendezvous } from "../src/server.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ID = "box_0123456789abcdefghijkl";
const TOKEN = "pull-token-0123456789";
const pull = createHash("sha256").update(TOKEN).digest("hex");

describe("webhook mailboxes kept in a file", () => {
  it("a restarted relay still has the mailbox and the waiting events; a counter past its own drops nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alca-hooks-file-"));
    dirs.push(dir);
    const file = join(dir, "hooks.json");
    const a = await startRendezvous({ port: 0, hooks: { file } });
    expect(
      (await fetch(`${a.url}/v0/hooks/${ID}`, { method: "PUT", body: JSON.stringify({ pull }) })).status,
    ).toBe(201);
    for (const n of [1, 2])
      await fetch(`${a.url}/v0/hooks/${ID}`, {
        method: "POST",
        headers: { "webhook-id": `msg_${n}`, "webhook-timestamp": "1", "webhook-signature": "v1,x" },
        body: JSON.stringify({ n }),
      });
    await a.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const b = await startRendezvous({ port: 0, hooks: { file } });
    // Same token: the mailbox is still ours (200, not a new 201).
    expect(
      (await fetch(`${b.url}/v0/hooks/${ID}`, { method: "PUT", body: JSON.stringify({ pull }) })).status,
    ).toBe(200);
    const get = async (after: number) =>
      (await (
        await fetch(`${b.url}/v0/hooks/${ID}/events?after=${after}`, { headers: { "x-alca-pull": TOKEN } })
      ).json()) as { items: Array<{ seq: number; headers: Record<string, string> }>; seq: number };
    const r = await get(0);
    expect(r.seq).toBe(2);
    expect(r.items.map((i) => i.headers["webhook-id"])).toEqual(["msg_1", "msg_2"]);
    // A core that thinks it is at 9 (the relay started over): nothing is dropped, all come back.
    expect((await get(9)).items).toHaveLength(2);
    expect((await get(1)).items.map((i) => i.seq)).toEqual([2]);
    await b.close();
  });
});
