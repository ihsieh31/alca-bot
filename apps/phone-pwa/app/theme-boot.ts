// BUG-10: the saved theme before the first paint. Loaded from index.html as a
// blocking classic script (CSP script-src 'self': a file, not inline), so it
// imports nothing and keeps the plan of theme.ts in a few lines — keep the
// two in step (test/theme.test.ts runs both and compares).
(() => {
  let t: string | null = null;
  try {
    t = localStorage.getItem("alca.theme");
  } catch {
    return;
  }
  if (t !== "dark" && t !== "light") return; // 跟隨系統 or nothing saved: index.html as it is
  const doc = document;
  const root = doc.documentElement;
  root.dataset.theme = t;
  root.style.colorScheme = t;
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute("content", t);
  const metas = [...doc.querySelectorAll('meta[name="theme-color"]')];
  for (const m of metas.slice(1)) m.remove();
  metas[0]?.removeAttribute("media");
  metas[0]?.setAttribute("content", t === "light" ? "#ffffff" : "#000000");
})();
