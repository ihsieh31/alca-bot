import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake shop for the offline demo, served on its own loopback port (a
 * different origin from the Alca UI and API). Nothing is ever charged: the
 * pay button only changes text on the page. It exists so the demo can show
 * the browser panel, a semantic snapshot and the payment gate without the
 * internet.
 */

const CSS = `
*{box-sizing:border-box}body{margin:0;font:15px/1.6 -apple-system,"PingFang TC","Noto Sans CJK TC",sans-serif;color:#1d1b18;background:#f6f3ee}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 40px;background:#fff;border-bottom:1px solid #e9e3d9}
.logo{font-weight:700;letter-spacing:.08em;font-size:18px}.logo span{color:#8a6a3f}
nav a{margin-left:24px;color:#5d574e;text-decoration:none;font-size:14px}
main{display:grid;grid-template-columns:1.25fr 1fr;gap:28px;max-width:1040px;margin:32px auto;padding:0 40px}
.panel{background:#fff;border:1px solid #e9e3d9;border-radius:16px;padding:24px 26px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:15px;margin:0 0 14px;color:#5d574e;font-weight:600}
.item{display:flex;gap:18px;align-items:center;padding:14px 0;border-top:1px solid #f0ebe3}.item:first-of-type{border-top:0}
.thumb{width:76px;height:76px;border-radius:12px;background:linear-gradient(135deg,#d9c3a1,#8a6a3f);flex:none;position:relative}
.thumb.b{background:linear-gradient(135deg,#c9d3c4,#5f7562)}
.thumb::after{content:"";position:absolute;inset:22px;border-radius:50%;background:rgba(255,255,255,.35)}
.name{font-weight:600}.meta{color:#8b8478;font-size:13px}.price{margin-left:auto;font-weight:600}
label{display:block;font-size:13px;color:#5d574e;margin:12px 0 6px}
input{width:100%;height:42px;border:1px solid #ddd5c8;border-radius:10px;padding:0 12px;font:inherit;background:#fbfaf7}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.sum{display:flex;justify-content:space-between;color:#5d574e;margin:6px 0}.total{font-size:18px;color:#1d1b18;font-weight:700;border-top:1px solid #f0ebe3;padding-top:12px;margin-top:12px}
button.pay{width:100%;height:48px;margin-top:18px;border:0;border-radius:999px;background:#1d1b18;color:#fff;font:600 16px/1 inherit;cursor:pointer}
.ghost{display:block;text-align:center;margin-top:12px;color:#8a6a3f;text-decoration:none;font-size:14px}
#status{margin-top:12px;color:#2f7a3e;font-weight:600;min-height:1em}
`;

const CHECKOUT = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>結帳 · 山嵐選物</title><style>${CSS}</style></head><body>
<header><div class="logo">山嵐<span>選物</span></div><nav><a href="#">新品</a><a href="#">茶器</a><a href="#">香氛</a><a href="#">購物車（2）</a></nav></header>
<main>
<section class="panel"><h1>購物車</h1>
<div class="item"><div class="thumb"></div><div><div class="name">柴燒手捏茶杯</div><div class="meta">岩棕 · 1 件</div></div><div class="price">NT$880</div></div>
<div class="item"><div class="thumb b"></div><div><div class="name">檜木香氛小塊</div><div class="meta">補充包 · 2 件</div></div><div class="price">NT$400</div></div>
</section>
<form class="panel" method="post" action="/checkout/pay" id="pay"><h2>付款資訊</h2>
<label for="cc">信用卡卡號</label><input id="cc" name="cardnumber" autocomplete="cc-number" value="•••• •••• •••• 4242">
<div class="row"><div><label for="exp">有效期限</label><input id="exp" autocomplete="cc-exp" value="08 / 29"></div>
<div><label for="cvc">安全碼</label><input id="cvc" autocomplete="cc-csc" value="•••"></div></div>
<div class="sum"><span>小計</span><span>NT$1,280</span></div><div class="sum"><span>運費</span><span>免運</span></div>
<div class="sum total"><span>總計</span><span>NT$1,280</span></div>
<button class="pay" type="submit">確認付款 NT$1,280</button>
<a class="ghost" href="#">繼續購物</a><p id="status"></p></form>
</main>
<script>document.getElementById("pay").addEventListener("submit",function(e){e.preventDefault();document.getElementById("status").textContent="（示範）付款完成，沒有真的扣款。";});</script>
</body></html>`;

export async function startDemoShop(): Promise<{ url: string; close(): Promise<void>; server: Server }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/" || path === "/checkout") {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(CHECKOUT);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/checkout`,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
