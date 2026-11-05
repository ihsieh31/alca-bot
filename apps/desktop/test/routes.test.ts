import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.ts";
import { desktopRoutes } from "../src/core-routes.ts";
import type { HttpError } from "../src/http.ts";
import { Reply, RouteTable } from "../src/routes.ts";

function fakeRes() {
  const out: { status?: number; body?: string } = {};
  const res = {
    writeHead: (s: number) => {
      out.status = s;
    },
    end: (b: string) => {
      out.body = String(b);
    },
  } as unknown as ServerResponse;
  return { res, out };
}
const req = (method: string) =>
  ({ method, [Symbol.asyncIterator]: async function* () {} }) as unknown as IncomingMessage;
const ctx = {} as AppContext;

describe("route table", () => {
  const table = new RouteTable()
    .mount({
      areas: ["things"],
      handle: async (r) => {
        if (r.parts[2] !== "mounted") return false;
        r.res.writeHead(204);
        r.res.end("");
        return true;
      },
    })
    .add(
      { method: "GET", path: "/api/things/:id", handle: ({ params }) => ({ id: params.id }) },
      { method: "POST", path: "/api/things", handle: () => new Reply(201, { made: true }) },
    );

  it("matches patterns, captures params, honours Reply and mounts first", async () => {
    const a = fakeRes();
    await table.dispatch(req("GET"), a.res, new URL("http://x/api/things/t%201"), ctx);
    expect(a.out).toEqual({ status: 200, body: JSON.stringify({ id: "t 1" }) });
    const b = fakeRes();
    await table.dispatch(req("POST"), b.res, new URL("http://x/api/things"), ctx);
    expect(b.out.status).toBe(201);
    const c = fakeRes();
    await table.dispatch(req("GET"), c.res, new URL("http://x/api/things/mounted"), ctx);
    expect(c.out.status).toBe(204);
  });

  it("405 for a known path under another method, 404 otherwise", async () => {
    await expect(
      table.dispatch(req("DELETE"), fakeRes().res, new URL("http://x/api/things/1"), ctx),
    ).rejects.toThrow(expect.objectContaining({ status: 405 }) as HttpError);
    await expect(
      table.dispatch(req("GET"), fakeRes().res, new URL("http://x/api/nope"), ctx),
    ).rejects.toThrow(expect.objectContaining({ status: 404 }) as HttpError);
  });

  it("the desktop table lists the core endpoints", () => {
    const rows = desktopRoutes()
      .list()
      .map((r) => `${r.method} ${r.path}`);
    expect(rows).toContain("POST /api/threads/:id/messages");
    expect(rows).toContain("POST /api/approvals/:id");
  });
});
