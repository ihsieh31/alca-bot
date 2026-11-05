import { describe, expect, it } from "vitest";
import {
  nextLook,
  PHONE_LOGINS_NOTE,
  parseAppAction,
  phoneLoginLine,
  phoneLogins,
} from "../app/connect-view.ts";

describe("phone 連接 helpers", () => {
  it("reads a connector send card back from its summary", () => {
    const a = parseAppAction(
      "用「工作」Gmail寄送：GMAIL_SEND_EMAIL（recipient_email：wang@example.com｜subject：Re: 報價｜body：王先生您好 報價週三前寄出）",
    );
    expect(a).toMatchObject({
      account: "工作",
      app: "Gmail",
      verb: "寄送",
      tool: "GMAIL_SEND_EMAIL",
      to: "wang@example.com",
      subject: "Re: 報價",
      body: "王先生您好 報價週三前寄出",
      clipped: false,
    });
    expect(
      parseAppAction("用「團隊」Slack發布：SLACK_CHAT_POST_MESSAGE（channel：#general｜text：hi）"),
    ).toMatchObject({
      app: "Slack",
      verb: "發布",
      channel: "#general",
      body: "hi",
    });
    expect(parseAppAction("要付款 NT$1,280")).toBeUndefined();
  });

  it("prefers the call's own arguments (the whole body) over the clipped preview", () => {
    const long = "字".repeat(80);
    const clipped = parseAppAction(`用「工作」Gmail寄送：GMAIL_SEND_EMAIL（body：${long}）`);
    expect(clipped?.clipped).toBe(true);
    const full = parseAppAction(`用「工作」Gmail寄送：GMAIL_SEND_EMAIL（body：${long}）`, {
      account: "工作",
      body: `${long}完`,
    });
    expect(full).toMatchObject({ body: `${long}完`, clipped: false });
  });

  it("the next look waits for a read failure's backoff", () => {
    const now = Date.parse("2026-11-03T09:00:00Z");
    expect(nextLook("2026-11-03T09:00:30Z", null, now)).toBe("馬上");
    expect(nextLook("2026-11-03T09:00:30Z", "2026-11-03T09:16:00Z", now)).toBe("16 分鐘後");
    expect(nextLook("2026-11-03T12:00:00Z", "2026-11-03T09:10:00Z", now)).toBe("3 小時後");
    expect(nextLook(null, null, now)).toBe("");
  });
});

describe("phone 連接 → 網站登入 (design §0.2.7)", () => {
  it("keeps only what the row shows: a password in the answer never reaches the view", () => {
    const list = phoneLogins([
      {
        id: "lgn_1",
        origin: "https://shop.example.com",
        username: "amy",
        label: "購物",
        password: "hunter22",
        secret: "x",
        bots: [{ id: "bot_a", name: "小幫手" }],
      },
      { id: "lgn_2", origin: "https://news.example.com", bots: [] },
      { origin: "https://broken.example.com" },
      null,
    ]);
    expect(list).toEqual([
      {
        id: "lgn_1",
        origin: "https://shop.example.com",
        username: "amy",
        label: "購物",
        bots: [{ id: "bot_a", name: "小幫手" }],
      },
      { id: "lgn_2", origin: "https://news.example.com", bots: [] },
    ]);
    expect(JSON.stringify(list)).not.toContain("hunter22");
    expect(phoneLogins({ not: "a list" })).toEqual([]);
  });

  it("says the site, the account and who may use it, and that adding one is on the computer", () => {
    const [a, b] = phoneLogins([
      {
        id: "lgn_1",
        origin: "https://shop.example.com",
        username: "amy",
        label: "購物",
        bots: [{ id: "bot_a", name: "小幫手" }],
      },
      { id: "lgn_2", origin: "https://news.example.com:8443", bots: [] },
    ]);
    expect(phoneLoginLine(a!)).toEqual({
      title: "購物（shop.example.com）",
      account: "帳號 amy",
      who: "只給 小幫手",
    });
    expect(phoneLoginLine(b!)).toEqual({
      title: "news.example.com:8443",
      account: "沒有帳號名稱",
      who: "所有 bot 都能用",
    });
    expect(PHONE_LOGINS_NOTE).toMatch(/電腦/);
  });
});
