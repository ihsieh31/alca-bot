// R2.2 / R5.6 in the window: the 事件迴圈｜慢查詢 line of 設定 → 資料 (with
// the slow calls and the busiest statements behind 詳細), one conversation
// out as a download (the conversation row's 匯出 and 設定 → 資料), and an
// export file back in as a new conversation (匯入 needs a window Alca opened:
// it adds a conversation, the approve-key rule of ui-session.ts).
import type { Api, Thread } from "./api.ts";
import { h } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { type PerfView, perfLine } from "./perf-line.ts";
import { button, errText, kv, live, note, tag, when } from "./settings-parts.ts";

export function perfBlock(api: Api): HTMLElement {
  return live(
    "st-perf",
    () => api.call<PerfView>("GET", "/api/settings/perf"),
    (p) => {
      const s = p.lastHour ?? p.now;
      const jobs = Object.entries(p.now.jobs);
      return [
        kv(
          tx("desktop.dataTransfer.performance"),
          p.warnings.length ? tag(tx("desktop.dataTransfer.slow"), "warn") : tag(tx("common.normal"), "ok"),
          ` ${perfLine(p)}`,
        ),
        ...p.warnings.map((w) => note(w, "bad")),
        h(
          "details",
          { class: "st-perf-more" },
          h("summary", {}, tx("desktop.dataTransfer.details")),
          h(
            "p",
            { class: "st-dim" },
            tx("desktop.dataTransfer.eventLoopP50MsP99", {
              p50: s.loop.p50,
              p99: s.loop.p99,
              max: s.loop.max,
              count: p.now.lockWaitMs.count,
              max2: p.now.lockWaitMs.max,
            }),
          ),
          jobs.length
            ? h(
                "p",
                { class: "st-dim" },
                tx("desktop.dataTransfer.backgroundWork", {
                  p0: jobs
                    .map(([k, v]) => tx("desktop.dataTransfer.ms", { k, lastMs: v.lastMs, at: when(v.at) }))
                    .join(tx("common.text")),
                }),
              )
            : null,
          h("h5", { class: "st-sub" }, tx("desktop.dataTransfer.recentSlowQueries")),
          p.now.slow.length
            ? h(
                "ul",
                { class: "st-perf-list" },
                ...p.now.slow
                  .slice(-20)
                  .reverse()
                  .map((x) =>
                    h(
                      "li",
                      {},
                      h("code", {}, x.sql),
                      h("small", {}, ` ${[`${x.ms} ms`, x.conn, when(x.at)].join(tx("common.joinComma"))}`),
                    ),
                  ),
              )
            : note(tx("desktop.dataTransfer.none")),
          h("h5", { class: "st-sub" }, tx("desktop.dataTransfer.mostTimeConsumingStatements")),
          h(
            "ul",
            { class: "st-perf-list" },
            ...s.top.slice(0, 10).map((x) =>
              h(
                "li",
                {},
                h("code", {}, x.sql),
                h(
                  "small",
                  {},
                  tx("desktop.dataTransfer.callsMsTotalMaxMs", {
                    calls: x.calls,
                    totalMs: x.totalMs,
                    maxMs: x.maxMs,
                  }),
                ),
              ),
            ),
          ),
          h("p", { class: "lc-help" }, tx("desktop.dataTransfer.onlyTheStatementItselfIs")),
        ),
      ];
    },
  );
}

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Download one conversation; resolves to the file name. */
export async function exportThread(
  api: Api,
  id: string,
  o: { passphrase?: string; memories?: boolean },
): Promise<string> {
  const { blob, name } = await api.download("/api/export", {
    scope: "thread",
    id,
    options: {
      ...(o.passphrase ? { passphrase: o.passphrase } : {}),
      ...(o.memories ? { memories: true } : {}),
    },
  });
  save(blob, name);
  return name;
}

/** The export options (密語, 連同記憶) and the plain-words warning; used by the row's 匯出 and by 設定 → 資料. */
export function exportForm(
  api: Api,
  pick: () => string | null,
  done: (msg: { text: string; tone: "ok" | "bad" }) => void,
) {
  const pass = h("input", {
    type: "password",
    class: "field st-wide",
    autocomplete: "new-password",
    placeholder: tx("desktop.dataTransfer.passphraseOptionalAtLeast8"),
    "aria-label": tx("desktop.dataTransfer.passphraseForTheExportFile"),
  });
  const mem = h("input", { type: "checkbox" });
  const go = button(
    tx("common.export"),
    () => {
      const id = pick();
      if (!id) return done({ text: tx("desktop.dataTransfer.pickAChatFirst"), tone: "bad" });
      const passphrase = pass.value;
      if (passphrase && passphrase.length < 8)
        return done({ text: tx("desktop.dataTransfer.thePassphraseNeedsAtLeast"), tone: "bad" });
      go.setAttribute("disabled", "");
      void exportThread(api, id, { ...(passphrase ? { passphrase } : {}), memories: mem.checked })
        .then(
          (name) => done({ text: tx("desktop.dataTransfer.downloaded", { name }), tone: "ok" }),
          (e) => done({ text: tx("desktop.dataTransfer.notExported", { e: errText(e) }), tone: "bad" }),
        )
        .finally(() => go.removeAttribute("disabled"));
    },
    { id: "export-thread" },
  );
  return h(
    "div",
    { class: "st-export" },
    h(
      "label",
      { class: "st-check st-line" },
      mem,
      h("span", {}, h("b", {}, tx("common.includeMemoriesLearnedFromThis"))),
    ),
    h("div", { class: "st-row" }, pass),
    h("p", { class: "lc-help" }, tx("desktop.dataTransfer.theExportFileContainsThe")),
    h("div", { class: "st-row st-actions" }, go),
  );
}

function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 設定 → 資料: 匯出 (choose a conversation) and 匯入 (a file, its passphrase). */
export function transferBlock(api: Api, opened: (id: string) => void = () => undefined): HTMLElement {
  return live(
    "st-transfer",
    () => api.call<Thread[]>("GET", "/api/threads?limit=50"),
    (threads, reload) => {
      const pick = h(
        "select",
        { class: "popup", "aria-label": tx("desktop.dataTransfer.chatToExport") },
        ...threads.map((t) => h("option", { value: t.id }, t.title ?? tx("common.newChat"))),
      );
      const file = h("input", {
        type: "file",
        accept: ".alca-export",
        "aria-label": tx("desktop.dataTransfer.exportFile"),
      });
      const pass = h("input", {
        type: "password",
        class: "field st-wide",
        autocomplete: "off",
        placeholder: tx("desktop.dataTransfer.passphraseOnlyIfOneWas"),
        "aria-label": tx("desktop.dataTransfer.passphraseForTheImportFile"),
      });
      const go = button(
        tx("common.import"),
        () => {
          const f = file.files?.[0];
          if (!f) return reload({ text: tx("desktop.dataTransfer.pickAAlcaExportFile"), tone: "bad" });
          go.setAttribute("disabled", "");
          void f
            .arrayBuffer()
            .then((buf) =>
              api.call<{ threadId: string; counts: Record<string, number>; note: string }>(
                "POST",
                "/api/import",
                {
                  data: toBase64(buf),
                  ...(pass.value ? { passphrase: pass.value } : {}),
                },
              ),
            )
            .then(
              (r) => {
                reload({
                  text: tx("desktop.dataTransfer.importedMessages", {
                    messages: r.counts.messages ?? 0,
                    note: r.note,
                  }),
                  tone: "ok",
                });
                opened(r.threadId);
              },
              (e) => reload({ text: tx("desktop.dataTransfer.notImported", { e: errText(e) }), tone: "bad" }),
            )
            .finally(() => go.removeAttribute("disabled"));
        },
        { id: "import-thread" },
      );
      return [
        h("h4", { class: "st-sub" }, tx("desktop.dataTransfer.exportAChat")),
        threads.length ? h("div", { class: "st-row" }, pick) : note(tx("common.noChatsYet")),
        threads.length ? exportForm(api, () => pick.value || null, reload) : null,
        h("h4", { class: "st-sub" }, tx("desktop.dataTransfer.importAChat")),
        h("div", { class: "st-row" }, file),
        h("div", { class: "st-row" }, pass),
        h("p", { class: "lc-help" }, tx("desktop.dataTransfer.importingAlwaysAddsANew")),
        h("div", { class: "st-row st-actions" }, go),
      ];
    },
  );
}
