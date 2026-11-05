// Local static test site for the real-Chromium integration test (no internet).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const page = (title: string, body: string) =>
  `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px sans-serif;margin:24px} button,input,select{font:inherit;margin:4px}</style></head><body>${body}</body></html>`;

function routes(port: number): Record<string, (q: URLSearchParams, cookie: string) => string> {
  return {
    "/": () =>
      page(
        "測試商店",
        `<h1>今日精選</h1>
<form role="search" action="/search"><input type="search" name="q" aria-label="搜尋商品"><button>搜尋</button></form>
<label>排序 <select id="sort"><option value="new">最新</option><option value="price">價格</option></select></label>
<p id="sorted">未排序</p>
<a href="/cart">購物車</a>
<shadow-box></shadow-box>
<iframe src="/frame" title="同源框" width="300" height="80"></iframe>
<iframe src="http://localhost:${port}/frame" title="跨站框" width="300" height="80"></iframe>
<script>
document.getElementById("sort").addEventListener("change", (e) => {
  document.getElementById("sorted").textContent = "排序：" + e.target.selectedOptions[0].text;
});
customElements.define("shadow-box", class extends HTMLElement {
  connectedCallback() {
    const r = this.attachShadow({ mode: "open" });
    const b = document.createElement("button");
    b.textContent = "影子按鈕";
    b.onclick = () => { b.textContent = "影子已按"; };
    r.append(b);
  }
});
</script>`,
      ),
    "/frame": () => page("框", `<button onclick="this.textContent='框內已按'">框內按鈕</button>`),
    "/search": (q) =>
      page("搜尋", `<h1>搜尋結果：${(q.get("q") ?? "").replace(/[<>&]/g, "")}</h1><a href="/">回首頁</a>`),
    "/cart": () =>
      page(
        "購物車",
        `<h1>購物車</h1><p>小計 NT$1,280</p>
<form method="post" action="/pay" id="f">
<input name="cardnumber" autocomplete="cc-number" aria-label="卡號">
<button type="submit">確認付款</button>
</form>
<button id="more" onclick="this.textContent='已回到商品'">繼續購物</button>
<p id="status"></p>
<script>document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault(); document.getElementById("status").textContent = "付款完成";
});</script>`,
      ),
    "/setcookie": () => page("set", "<p>ok</p>"),
    "/whoami": (_q, cookie) =>
      page("who", `<p id="c">cookie=${cookie.includes("alca_test=1") ? "有" : "無"}</p>`),
  };
}

export async function startSite(): Promise<{ url: string; port: number; server: Server }> {
  let port = 0;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const r = routes(port)[u.pathname];
    if (!r) {
      res.writeHead(404).end("not found");
      return;
    }
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (u.pathname === "/setcookie") headers["set-cookie"] = "alca_test=1; Path=/";
    res.writeHead(200, headers).end(r(u.searchParams, String(req.headers.cookie ?? "")));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, server };
}
