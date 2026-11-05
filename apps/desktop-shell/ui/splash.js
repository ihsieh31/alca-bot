// The shell calls alcaStatus(kind, text, logLine, foot) while the core is not up yet;
// every word comes from the shell, in its language (R9.3).
// Until the first call (at most a couple of seconds), the page fills its own
// words from the same generated JSON, by the system language; the shell's call
// then applies advanced.locale (R9.3, G2 batch 5: no Chinese in the page itself).
let told = false;
const lang = /^zh\b/i.test(navigator.language || "") ? "zh-Hant-TW" : "en";
fetch(`strings.${lang}.json`)
  .then((r) => r.json())
  .then((w) => {
    if (told) return;
    document.getElementById("text").textContent = w.starting;
    document.querySelector(".foot").textContent = w.foot;
  })
  .catch(() => undefined);

window.alcaStatus = (kind, text, log, foot) => {
  told = true;
  document.querySelector(".splash").dataset.kind = kind;
  document.getElementById("text").textContent = text;
  const l = document.getElementById("log");
  l.hidden = kind !== "stopped";
  l.textContent = log;
  if (foot) document.querySelector(".foot").textContent = foot;
};
