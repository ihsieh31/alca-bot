import { describe, expect, it } from "vitest";
import { containsSecret, findSecrets, REDACTED, redact, redactValue } from "../src/index.ts";

describe("secret filter", () => {
  const secrets: Array<[string, string]> = [
    ["api key", "我的 key 是 sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"],
    ["github", "token ghp_0123456789abcdefghijABCDEFGHIJ"],
    ["aws", "AKIAIOSFODNN7EXAMPLE"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"],
    ["bearer", "Authorization: Bearer abcdefghijklmnop1234"],
    ["pem", "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----"],
    ["url creds", "https://ian:hunter2@example.com/repo"],
    ["url param", "https://x.test/cb?access_token=abc123"],
    ["zh password", "我的密碼是 hunter2"],
    ["zh password no space", "網銀密碼：Abc12345"],
    ["otp", "驗證碼 482913"],
    ["en password", "password: correct-horse"],
    ["card", "卡號 4111 1111 1111 1111"],
    ["tw id", "身分證 A123456789"],
    ["entropy", "用這個 Zk3pQ9vX2mL7rT5wB8nC4hJ6dF1gY0sA"],
  ];
  for (const [name, text] of secrets)
    it(`flags ${name}`, () => {
      expect(containsSecret(text)).toBe(true);
      expect(redact(text)).toContain(REDACTED);
    });

  it("leaves ordinary text alone", () => {
    for (const t of [
      "我喜歡喝燕麥奶拿鐵",
      "明天十點跟設計師開會",
      "電話分機 1234",
      "訂單編號 20261103",
      "pinterest 上的圖",
      "https://example.com/products/bluetooth-headphones",
      "4111 1111 1111 1112",
      "A123456788",
    ])
      expect(findSecrets(t)).toEqual([]);
  });

  it("masks values under secret-sounding keys and inside nested args", () => {
    expect(
      redactValue({ url: "https://shop.test", password: "x", nested: [{ note: "密碼是 abc" }] }),
    ).toEqual({
      url: "https://shop.test",
      password: REDACTED,
      nested: [{ note: `密碼是 ${REDACTED}` }],
    });
  });
});
