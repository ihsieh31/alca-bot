import { describe, expect, it } from "vitest";
import {
  bodyFieldNames,
  type Cdp,
  CdpSession,
  type ChannelEvent,
  classifyChannel,
  classifyRequest,
  describeNotes,
  type GatedSpace,
  type NetworkConfirmRequest,
  NetworkGate,
} from "../src/index.ts";

describe("classifyRequest", () => {
  const c = (method: string, url: string, extra: Partial<Parameters<typeof classifyRequest>[0]> = {}) =>
    classifyRequest({ method, url, ...extra }).actionClass;

  it("lets reads through whatever the URL says", () => {
    expect(c("GET", "https://shop.example.com/checkout")).toBe("read");
    expect(c("HEAD", "https://x.example.com/delete")).toBe("read");
    expect(c("OPTIONS", "https://x.example.com/api/send")).toBe("read");
  });

  it("flags payment / send / delete / publish by method, path and query", () => {
    expect(c("POST", "https://shop.example.com/api/checkout")).toBe("payment");
    expect(c("POST", "https://shop.example.com/orders/place")).toBe("payment");
    expect(c("POST", "https://shop.example.com/cart/pay?x=1")).toBe("payment");
    expect(c("DELETE", "https://api.example.com/v1/items/42")).toBe("delete");
    expect(c("POST", "https://api.example.com/items/42/delete")).toBe("delete");
    expect(c("POST", "https://mail.example.com/api/messages/send")).toBe("send");
    expect(c("POST", "https://chat.example.com/api/messages")).toBe("send");
    expect(c("POST", "https://blog.example.com/api/posts")).toBe("publish");
    expect(c("POST", "https://x.example.com/api?action=delete")).toBe("delete");
    expect(c("PUT", "https://api.example.com/profile")).toBe("write");
    expect(c("POST", "https://api.example.com/search")).toBe("write");
    expect(c("POST", "https://api.example.com/postcode")).toBe("write");
  });

  it("reads form fields and GraphQL mutation names", () => {
    expect(c("POST", "https://a.example.com/login", { postData: "user=a&password=b" })).toBe("send");
    expect(
      c("POST", "https://a.example.com/x", {
        postData: "cardnumber=4111&exp=12",
        contentType: "application/x-www-form-urlencoded",
      }),
    ).toBe("payment");
    expect(
      c("POST", "https://a.example.com/x", {
        postData: '{"payment":{"cvc":"123"}}',
        contentType: "application/json",
      }),
    ).toBe("payment");
    expect(
      c("POST", "https://a.example.com/graphql", {
        postData: '{"operationName":"DeleteRepository","query":"mutation DeleteRepository { x }"}',
      }),
    ).toBe("delete");
    expect(
      c("POST", "https://a.example.com/graphql", {
        postData: '{"query":"mutation { createTweet(text: 1) { id } }"}',
      }),
    ).toBe("publish");
    expect(c("POST", "https://a.example.com/graphql", { postData: '{"query":"query { me { id } }"}' })).toBe(
      "write",
    );
    const multipart = '--b\r\ncontent-disposition: form-data; name="cc-number"\r\n\r\n4111\r\n--b--';
    expect(
      c("POST", "https://a.example.com/x", {
        postData: multipart,
        contentType: "multipart/form-data; boundary=b",
      }),
    ).toBe("payment");
    expect(bodyFieldNames("a=1&b%20c=2")).toEqual(["a", "b c"]);
  });

  it("applies domain rules, ignores label-only rules, and treats beacons by content only", () => {
    expect(c("POST", "https://www.paypal.com/xoplatform/logger")).toBe("payment");
    expect(c("POST", "https://mail.google.com/sync/u/0/i/s")).toBe("write");
    expect(c("POST", "https://t.example.com/log/share_event", { resourceType: "Ping" })).toBe("write");
    expect(c("POST", "https://t.example.com/log/share_event", { resourceType: "XHR" })).toBe("publish");
  });
});

/** A fake target session: records what the gate sends, lets the test fire requestPaused. */
function fakeSession() {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Map<string, (p: unknown) => void>();
  const cdp: Cdp = {
    closed: false,
    close() {},
    async send(method, params = {}) {
      sent.push({ method, params });
      return {};
    },
    on(method, fn) {
      listeners.set(method, (p) => fn(p, "S"));
      return () => listeners.delete(method);
    },
  };
  const pause = (requestId: string, method: string, url: string, postData?: string) =>
    listeners.get("Fetch.requestPaused")?.({
      requestId,
      resourceType: "Fetch",
      request: { method, url, ...(postData ? { postData } : {}), headers: {} },
    });
  const outcome = (id: string) =>
    sent.find(
      (s) => s.params.requestId === id && s.method.startsWith("Fetch.") && s.method !== "Fetch.enable",
    )?.method;
  const emit = (method: string, params: Record<string, unknown>) => listeners.get(method)?.(params);
  return { session: new CdpSession(cdp, "S"), sent, pause, outcome, emit };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("NetworkGate", () => {
  const space = (): GatedSpace => ({
    spaceId: "space_1",
    botId: "bot_1",
    threadId: "thr_1",
    controller: "agent",
    closed: false,
  });

  it("enables Fetch at the request stage and passes reads and plain writes", async () => {
    const f = fakeSession();
    const gate = new NetworkGate({ rules: () => [] });
    const s = space();
    await gate.attach(s, f.session);
    const enable = f.sent.find((x) => x.method === "Fetch.enable");
    expect(JSON.stringify(enable?.params)).toContain('"requestStage":"Request"');
    f.pause("r1", "GET", "https://shop.example.com/checkout");
    f.pause("r2", "POST", "https://shop.example.com/search");
    await tick();
    expect(f.outcome("r1")).toBe("Fetch.continueRequest");
    expect(f.outcome("r2")).toBe("Fetch.continueRequest");
  });

  it("blocks a sensitive request without a confirm, and passes it when the step was granted that class", async () => {
    const f = fakeSession();
    const gate = new NetworkGate({ rules: () => [], graceMs: 50 });
    const s = space();
    await gate.attach(s, f.session);
    gate.beginStep(s, "write");
    f.pause("r1", "POST", "https://shop.example.com/api/checkout");
    await tick();
    expect(f.outcome("r1")).toBe("Fetch.failRequest");
    const notes = await gate.endStep(s);
    expect(notes).toMatchObject([{ actionClass: "payment", outcome: "blocked" }]);
    expect(describeNotes(notes)).toContain("已攔下");

    gate.beginStep(s, "payment");
    f.pause("r2", "POST", "https://shop.example.com/api/checkout");
    await tick();
    expect(f.outcome("r2")).toBe("Fetch.continueRequest");
    await gate.endStep(s);
    // Inside the grace window a late request of the step still passes; after it, not.
    f.pause("r3", "POST", "https://shop.example.com/api/checkout");
    await tick();
    expect(f.outcome("r3")).toBe("Fetch.continueRequest");
    await new Promise((r) => setTimeout(r, 70));
    f.pause("r4", "POST", "https://shop.example.com/api/checkout");
    await tick();
    expect(f.outcome("r4")).toBe("Fetch.failRequest");
    // A granted class covers only itself.
    gate.beginStep(s, "payment");
    f.pause("r5", "DELETE", "https://shop.example.com/api/cart/1");
    await tick();
    expect(f.outcome("r5")).toBe("Fetch.failRequest");
  });

  it("asks once per class, holds the request until the answer, and remembers a yes for the step", async () => {
    const f = fakeSession();
    const asked: NetworkConfirmRequest[] = [];
    let answer: (v: boolean) => void = () => {};
    const gate = new NetworkGate({
      rules: () => [],
      confirm: (req) => {
        asked.push(req);
        return new Promise((r) => {
          answer = r;
        });
      },
    });
    const s = space();
    await gate.attach(s, f.session);
    gate.beginStep(s, "write");
    f.pause("a", "POST", "https://m.example.com/api/messages/send");
    f.pause("b", "POST", "https://m.example.com/api/messages/send");
    await tick();
    expect(asked.length).toBe(1);
    expect(asked[0]).toMatchObject({
      actionClass: "send",
      spaceId: "space_1",
      botId: "bot_1",
      threadId: "thr_1",
    });
    expect(asked[0]?.summary).toContain("網路層");
    expect(f.outcome("a")).toBeUndefined();
    const ended = gate.endStep(s);
    answer(true);
    await tick();
    expect(f.outcome("a")).toBe("Fetch.continueRequest");
    expect(f.outcome("b")).toBe("Fetch.continueRequest");
    const notes = await ended;
    expect(notes.map((n) => n.outcome)).toEqual(["approved", "approved"]);
    expect(describeNotes(notes)).toContain("已放行");
    // A late request right after the step rides on the same yes.
    f.pause("c", "POST", "https://m.example.com/api/messages/send");
    await tick();
    expect(f.outcome("c")).toBe("Fetch.continueRequest");
    expect(asked.length).toBe(1);
  });

  it("never gates a person at the wheel; a denied or failed confirm blocks; closing fails what waits", async () => {
    const f = fakeSession();
    let calls = 0;
    const gate = new NetworkGate({
      rules: () => [],
      confirm: async (_req, signal) => {
        calls++;
        if (calls === 1) return false;
        if (calls === 2) throw new Error("card store down");
        return new Promise((_r, reject) =>
          signal.addEventListener("abort", () => reject(new Error("closed"))),
        );
      },
    });
    const s = space();
    await gate.attach(s, f.session);
    s.controller = "user";
    f.pause("u", "POST", "https://shop.example.com/api/checkout");
    await tick();
    expect(f.outcome("u")).toBe("Fetch.continueRequest");
    s.controller = "agent";
    f.pause("d1", "POST", "https://shop.example.com/api/checkout");
    await tick();
    expect(f.outcome("d1")).toBe("Fetch.failRequest");
    f.pause("d2", "POST", "https://shop.example.com/api/checkout");
    await tick();
    expect(f.outcome("d2")).toBe("Fetch.failRequest");
    f.pause("d3", "POST", "https://shop.example.com/api/checkout");
    await tick();
    expect(f.outcome("d3")).toBeUndefined();
    s.closed = true;
    gate.forget(s);
    await tick();
    expect(f.outcome("d3")).toBe("Fetch.failRequest");
  });
});

describe("classifyChannel (R3)", () => {
  const ws = (url: string, frame?: string, pageUrl?: string) =>
    classifyChannel({ kind: "websocket", url, ...(frame ? { frame } : {}), ...(pageUrl ? { pageUrl } : {}) });

  it("treats a plain socket or frame as a write", () => {
    expect(ws("wss://chat.example.com/socket").actionClass).toBe("write");
    expect(ws("wss://chat.example.com/socket", '{"type":"typing"}').actionClass).toBe("write");
    expect(ws("wss://chat.example.com/socket", "hello password").actionClass).toBe("write");
    expect(classifyChannel({ kind: "webrtc", url: "https://meet.example.com/" }).actionClass).toBe("write");
  });

  it("reads GraphQL mutations, password and card fields in a text frame", () => {
    const g = ws(
      "wss://a.example.com/graphql",
      '{"type":"start","payload":{"query":"mutation sendMessage { x }"}}',
    );
    expect(g).toMatchObject({ actionClass: "send", reasons: ["GraphQL sendMessage"] });
    expect(ws("wss://a.example.com/s", '{"op":"login","password":"x"}').actionClass).toBe("send");
    expect(ws("wss://a.example.com/s", '{"pay":{"cardNumber":"4111"}}').actionClass).toBe("payment");
    expect(ws("wss://a.example.com/s", '{"query":"mutation { deleteRepo(id: 1) }"}').actionClass).toBe(
      "delete",
    );
  });

  it("applies domain rules to the socket host or the page host, and hands a worker fetch to classifyRequest", () => {
    const rules = [{ id: "my-chat", domain: "chat.example.com", actionClass: "send" as const, why: "x" }];
    expect(classifyChannel({ kind: "websocket", url: "wss://rt.chat.example.com/ws" }, rules)).toMatchObject({
      actionClass: "send",
      reasons: ["規則 my-chat"],
    });
    expect(
      classifyChannel(
        { kind: "websocket", url: "wss://cdn.other.net/ws", pageUrl: "https://chat.example.com/" },
        rules,
      ).actionClass,
    ).toBe("send");
    expect(
      classifyChannel({ kind: "worker-fetch", url: "https://s.example.com/api/checkout", method: "POST" })
        .actionClass,
    ).toBe("payment");
    expect(
      classifyChannel({ kind: "worker-fetch", url: "https://s.example.com/api/checkout" }).actionClass,
    ).toBe("read");
  });
});

describe("NetworkGate channels (R3)", () => {
  const space = (): GatedSpace => ({
    spaceId: "space_1",
    botId: "bot_1",
    workerId: "wkr_1",
    controller: "agent",
    closed: false,
  });
  const sendFrame = '{"query":"mutation sendMessage { send(text: 1) }"}';
  const navigations = (f: ReturnType<typeof fakeSession>) =>
    f.sent.filter((x) => x.method === "Page.navigate").map((x) => x.params.url);

  it("a tab bypasses service workers, watches WebSockets and refuses WebRTC; a worker only gets Fetch", async () => {
    const f = fakeSession();
    const gate = new NetworkGate({ rules: () => [] });
    await gate.attach(space(), f.session, "page");
    const methods = f.sent.map((x) => x.method);
    expect(methods).toEqual([
      "Fetch.enable",
      "Network.enable",
      "Network.setBypassServiceWorker",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument",
    ]);
    expect(f.sent[2]?.params).toEqual({ bypass: true });
    const script = f.sent[4]?.params as { source: string; runImmediately: boolean };
    expect(script.runImmediately).toBe(true);
    expect(script.source).toContain("RTCPeerConnection");
    expect(script.source).toContain("NotAllowedError");
    const w = fakeSession();
    await gate.attach(space(), w.session, "service_worker");
    expect(w.sent.map((x) => x.method)).toEqual(["Fetch.enable"]);
  });

  it("a failed Network.enable fails the attach (the caller keeps that target from running)", async () => {
    const sent: string[] = [];
    const cdp: Cdp = {
      closed: false,
      close() {},
      async send(method) {
        sent.push(method);
        if (method === "Network.enable") throw new Error("no Network domain");
        return {};
      },
      on: () => () => undefined,
    };
    const gate = new NetworkGate({ rules: () => [] });
    await expect(gate.attach(space(), new CdpSession(cdp, "S"), "iframe")).rejects.toThrow(
      "no Network domain",
    );
  });

  it("observes a plain socket; a send frame without a grant sends the tab to about:blank, notes stopped, notifies", async () => {
    const f = fakeSession();
    const told: ChannelEvent[] = [];
    const gate = new NetworkGate({ rules: () => [], notify: (e) => told.push(e) });
    const s = space();
    await gate.attach(s, f.session, "page");
    gate.beginStep(s, "write");
    f.emit("Network.webSocketCreated", { requestId: "w1", url: "wss://chat.example.com/socket" });
    f.emit("Network.webSocketFrameSent", {
      requestId: "w1",
      response: { opcode: 1, payloadData: '{"type":"typing"}' },
    });
    expect(navigations(f)).toEqual([]);
    f.emit("Network.webSocketFrameSent", {
      requestId: "w1",
      response: { opcode: 2, payloadData: sendFrame },
    });
    expect(navigations(f)).toEqual([]);
    f.emit("Network.webSocketFrameSent", {
      requestId: "w1",
      response: { opcode: 1, payloadData: sendFrame },
    });
    expect(navigations(f)).toEqual(["about:blank"]);
    // Frames already in flight on a stopped socket add nothing.
    f.emit("Network.webSocketFrameSent", {
      requestId: "w1",
      response: { opcode: 1, payloadData: sendFrame },
    });
    expect(navigations(f)).toEqual(["about:blank"]);
    expect(told).toMatchObject([
      {
        spaceId: "space_1",
        botId: "bot_1",
        workerId: "wkr_1",
        kind: "websocket",
        outcome: "stopped",
        actionClass: "send",
        url: "wss://chat.example.com/socket",
      },
    ]);
    expect(told[0]?.reasons).toContain("GraphQL sendMessage");
    const notes = await gate.endStep(s);
    expect(notes.map((n) => [n.kind, n.outcome])).toEqual([
      ["websocket", "observed"],
      ["websocket", "stopped"],
    ]);
    const text = describeNotes(notes);
    // A stop that lands after the step ended is reported by the next step.
    f.emit("Network.webSocketCreated", { requestId: "w9", url: "wss://chat.example.com/socket" });
    f.emit("Network.webSocketFrameSent", {
      requestId: "w9",
      response: { opcode: 1, payloadData: sendFrame },
    });
    gate.beginStep(s, "read");
    expect((await gate.endStep(s)).map((n) => n.outcome)).toEqual(["stopped"]);
    expect(text).toContain("可能已經生效");
    expect(text).toContain("寄送");
    expect(text).not.toContain("沒有送出");
  });

  it("a granted step lets the frame be; a person at the wheel is only watched", async () => {
    const f = fakeSession();
    const told: ChannelEvent[] = [];
    const gate = new NetworkGate({ rules: () => [], notify: (e) => told.push(e) });
    const s = space();
    await gate.attach(s, f.session, "page");
    gate.beginStep(s, "send");
    f.emit("Network.webSocketCreated", { requestId: "w1", url: "wss://chat.example.com/socket" });
    f.emit("Network.webSocketFrameSent", {
      requestId: "w1",
      response: { opcode: 1, payloadData: sendFrame },
    });
    expect((await gate.endStep(s)).map((n) => n.outcome)).toEqual(["observed", "step"]);
    s.controller = "user";
    gate.beginStep(s, "write");
    f.emit("Network.webSocketCreated", { requestId: "w2", url: "wss://chat.example.com/socket" });
    f.emit("Network.webSocketFrameSent", {
      requestId: "w2",
      response: { opcode: 1, payloadData: sendFrame },
    });
    expect(navigations(f)).toEqual([]);
    expect(told).toEqual([]);
  });

  it("a domain rule stops the socket at its first frame; after two stops on a host its sockets stop as they open", async () => {
    const f = fakeSession();
    const told: ChannelEvent[] = [];
    const rules = [{ id: "my-chat", domain: "chat.example.com", actionClass: "send" as const, why: "x" }];
    const gate = new NetworkGate({ rules: () => rules, notify: (e) => told.push(e) });
    const s = space();
    await gate.attach(s, f.session, "page");
    gate.beginStep(s, "write");
    f.emit("Network.webSocketCreated", { requestId: "a", url: "wss://chat.example.com/s" });
    expect(navigations(f)).toEqual([]);
    f.emit("Network.webSocketFrameSent", {
      requestId: "a",
      response: { opcode: 1, payloadData: '{"t":"hi"}' },
    });
    expect(navigations(f)).toHaveLength(1);
    f.emit("Network.webSocketCreated", { requestId: "b", url: "wss://chat.example.com/s" });
    f.emit("Network.webSocketFrameSent", {
      requestId: "b",
      response: { opcode: 1, payloadData: '{"t":"hi"}' },
    });
    expect(navigations(f)).toHaveLength(2);
    f.emit("Network.webSocketCreated", { requestId: "c", url: "wss://chat.example.com/s" });
    expect(navigations(f)).toHaveLength(3);
    expect(told.at(-1)?.reasons[0]).toContain("已被停止 2 次");
    // Another host is not struck.
    f.emit("Network.webSocketCreated", { requestId: "d", url: "wss://other.example.com/s" });
    expect(navigations(f)).toHaveLength(3);
  });

  it("a frame's stop goes through the tab session; WebRTC is noted once per page and reported", async () => {
    const frame = fakeSession();
    const tab = fakeSession();
    const told: ChannelEvent[] = [];
    const gate = new NetworkGate({ rules: () => [], notify: (e) => told.push(e) });
    const s = space();
    await gate.attach(s, frame.session, "iframe", tab.session);
    gate.beginStep(s, "write");
    frame.emit("Network.webSocketCreated", { requestId: "w", url: "wss://x.example.com/s" });
    frame.emit("Network.webSocketFrameSent", {
      requestId: "w",
      response: { opcode: 1, payloadData: sendFrame },
    });
    expect(navigations(frame)).toEqual([]);
    expect(navigations(tab)).toEqual(["about:blank"]);
    frame.emit("Runtime.bindingCalled", { name: "__alcaRtc", payload: "https://meet.example.com/r" });
    frame.emit("Runtime.bindingCalled", { name: "__alcaRtc", payload: "https://meet.example.com/r" });
    frame.emit("Runtime.bindingCalled", { name: "somethingElse", payload: "x" });
    expect(told.filter((e) => e.kind === "webrtc")).toMatchObject([
      { outcome: "blocked", url: "https://meet.example.com/r" },
    ]);
    expect(describeNotes(await gate.endStep(s))).toContain("WebRTC");
  });
});
