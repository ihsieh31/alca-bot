import { describe, expect, it } from "vitest";
import { type AXNode, buildSnapshot, type FrameTree, isRefCurrent, parseElementRef } from "../src/index.ts";

let n = 0;
function ax(
  role: string,
  name: string,
  backend?: number,
  kids: AXNode[] = [],
  extra: Partial<AXNode> = {},
): AXNode[] {
  const id = `a${++n}`;
  const node: AXNode = {
    nodeId: id,
    role: { value: role },
    name: { value: name },
    childIds: kids.filter((k) => !k.parentId).map((k) => k.nodeId),
    ...(backend !== undefined ? { backendDOMNodeId: backend } : {}),
    ...extra,
  };
  for (const k of kids) if (!k.parentId) k.parentId = id;
  return [node, ...kids];
}
const tree = (nodes: AXNode[], over: Partial<FrameTree> = {}): FrameTree => ({
  sessionId: "S",
  frameId: "F",
  loaderId: "L1",
  url: "https://shop.test/",
  nodes,
  ...over,
});

describe("semantic snapshot", () => {
  it("numbers only actionable elements, folds wrappers and repeated text", () => {
    const nodes = ax("RootWebArea", "商店", 1, [
      ...ax("generic", "", 2, [
        ...ax("heading", "購物車", 3, ax("StaticText", "購物車"), {
          properties: [{ name: "level", value: { value: 1 } }],
        }),
        ...ax("StaticText", "共 2 件商品"),
        ...ax("button", "確認付款", 4, ax("StaticText", "確認付款")),
        ...ax("textbox", "優惠碼", 5, [], { value: { value: "SALE" } }),
        ...ax("link", "回首頁", 6, [], {
          properties: [{ name: "url", value: { value: "https://shop.test/" } }],
        }),
        ...ax("button", "確認付款", 7),
      ]),
      ...ax("none", "", 8, [], { ignored: true }),
    ]);
    const s = buildSnapshot([tree(nodes)], { snapshotId: "snap1" });
    expect(s.text).toBe(
      [
        '- heading "購物車" [h1]',
        '- text "共 2 件商品"',
        '- button "確認付款" @1',
        '- textbox "優惠碼" @2 value="SALE"',
        '- link "回首頁" @3 → https://shop.test/',
        '- button "確認付款" @4',
      ].join("\n"),
    );
    expect([...s.refs.values()].map((h) => [h.ref, h.backendNodeId, h.nth])).toEqual([
      [1, 4, 0],
      [2, 5, 0],
      [3, 6, 0],
      [4, 7, 1],
    ]);
    expect(s.refs.get(1)).toMatchObject({
      snapshotId: "snap1",
      loaderId: "L1",
      frameId: "F",
      role: "button",
    });
    expect(s.captcha).toBe(false);
    expect(isRefCurrent(s.refs.get(1)!, "snap1")).toBe(true);
    expect(isRefCurrent(s.refs.get(1)!, "snap2")).toBe(false);
  });

  it("stitches child frames in at their owner iframe and flags captchas", () => {
    const main = ax("RootWebArea", "登入", 1, [...ax("Iframe", "", 10), ...ax("button", "登入", 11)]);
    const child = ax("RootWebArea", "", 1, ax("checkbox", "我不是機器人", 2));
    const s = buildSnapshot(
      [
        tree(main),
        tree(child, {
          sessionId: "S2",
          frameId: "F2",
          loaderId: "L9",
          url: "https://www.google.com/recaptcha/api2/anchor",
          parentFrameId: "F",
          ownerBackendNodeId: 10,
        }),
      ],
      { snapshotId: "x" },
    );
    expect(s.text).toBe(["- iframe", '  - checkbox "我不是機器人" @1', '- button "登入" @2'].join("\n"));
    expect(s.refs.get(1)).toMatchObject({ sessionId: "S2", frameId: "F2", loaderId: "L9" });
    expect(s.captcha).toBe(true);
  });

  it("stays within the character budget", () => {
    const many = ax(
      "RootWebArea",
      "",
      1,
      Array.from({ length: 200 }, (_, i) => ax("link", `第 ${i} 篇文章`, 100 + i)).flat(),
    );
    const s = buildSnapshot([tree(many)], { snapshotId: "x", maxChars: 600 });
    expect(s.truncated).toBe(true);
    expect(s.text.length).toBeLessThan(700);
    expect(s.text.endsWith("已截斷；可用 browser_read 讀取全文）")).toBe(true);
  });

  it("parses refs strictly", () => {
    expect(parseElementRef("@12")).toBe(12);
    expect(parseElementRef("12")).toBe(12);
    expect(parseElementRef(3)).toBe(3);
    expect(["@0", "@-1", "@1a", "@", "", 1.5, null].map(parseElementRef)).toEqual(Array(7).fill(undefined));
  });
});
