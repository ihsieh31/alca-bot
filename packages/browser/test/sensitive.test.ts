import { ALWAYS_CONFIRM_ACTIONS } from "@alca/config";
import { describe, expect, it } from "vitest";
import { classifyStep, type ElementFacts, stepAllowed } from "../src/index.ts";

const btn = (name: string, extra: Partial<ElementFacts> = {}): ElementFacts => ({
  role: "button",
  name,
  ...extra,
});
const click = (name: string, pageUrl = "https://shop.test/cart", extra: Partial<ElementFacts> = {}) =>
  classifyStep({ kind: "click", pageUrl, element: btn(name, extra) }).actionClass;

describe("sensitive-action gate (action layer)", () => {
  it("classifies payment / send / delete / publish buttons in 中文 and English", () => {
    expect(click("確認付款")).toBe("payment");
    expect(click("Place order")).toBe("payment");
    expect(click("立即購買")).toBe("payment");
    expect(click("寄出")).toBe("send");
    expect(click("Send")).toBe("send");
    expect(click("送出")).toBe("send");
    expect(click("刪除這則貼文")).toBe("delete");
    expect(click("Delete repository")).toBe("delete");
    expect(click("發布")).toBe("publish");
    expect(click("Publish release")).toBe("publish");
  });

  it("leaves ordinary steps alone", () => {
    expect(click("下一頁")).toBe("write");
    expect(click("搜尋")).toBe("write");
    expect(
      classifyStep({ kind: "click", pageUrl: "https://a.test/", element: { role: "link", name: "關於我們" } })
        .actionClass,
    ).toBe("network");
    expect(
      classifyStep({ kind: "navigate", pageUrl: "about:blank", url: "https://a.test/" }).actionClass,
    ).toBe("network");
    // A sign-in form's Submit is not a send.
    expect(click("Submit", "https://a.test/login", { form: { hasPassword: true } })).toBe("write");
  });

  it("uses the form and the page: card fields, checkout pages, Enter-to-submit", () => {
    expect(click("繼續", "https://shop.test/checkout")).toBe("payment");
    expect(
      click("Continue", "https://shop.test/x", {
        form: { action: "https://shop.test/payment", hasCardFields: false },
      }),
    ).toBe("payment");
    expect(click("下一步", "https://shop.test/x", { form: { hasCardFields: true } })).toBe("payment");
    expect(
      classifyStep({
        kind: "type",
        pageUrl: "https://shop.test/x",
        element: { role: "textbox", name: "卡號", autocomplete: "cc-number" },
      }).actionClass,
    ).toBe("payment");
    expect(
      classifyStep({
        kind: "press",
        key: "Enter",
        pageUrl: "https://mail.test/",
        element: { role: "textbox", name: "內容", form: { submitLabel: "寄出" } },
      }).actionClass,
    ).toBe("send");
    expect(
      classifyStep({
        kind: "press",
        key: "Enter",
        pageUrl: "https://a.test/",
        element: { role: "searchbox", name: "搜尋", form: { isSearch: true, submitLabel: "Submit" } },
      }).actionClass,
    ).toBe("write");
  });

  it("applies domain rules for payment providers and mail", () => {
    expect(click("Continue", "https://www.paypal.com/checkoutnow")).toBe("payment");
    expect(click("Log in", "https://www.paypal.com/signin")).toBe("write");
    expect(click("傳送", "https://mail.google.com/mail/u/0/")).toBe("send");
  });

  it("an always-confirm step runs only under an approval for exactly that class", () => {
    for (const c of ALWAYS_CONFIRM_ACTIONS) {
      expect(stepAllowed(c, "write")).toBe(false);
      expect(stepAllowed(c, c)).toBe(true);
    }
    expect(stepAllowed("payment", "send")).toBe(false);
    expect(stepAllowed("write", "read")).toBe(true);
  });
});
