// 資料庫 › 記憶 and 技能 (§4.1 phone-memory / -memory-item / -skills): pushed
// pages. 記憶: a search field and a 「全部 ⌄」 filter menu, then one row per
// memory — the sentence, and under it 「推測，尚未確認」 or where it came from.
// A row opens its detail page (這是對的 / 編輯 / a red 忘記 confirmed in an
// action sheet). 技能: proposals under 等你確認, saved skills with a switch.
// Everything stays on the computer: the phone only reads it over sealed Link frames.
import { ago, h, haptic, icon } from "./dom.ts";
import { t } from "./i18n/index.ts";
import {
  memoryChangeError,
  memoryQuery,
  memorySource,
  memorySourceName,
  memorySubtitle,
  NO_APPROVE_MEMORY,
} from "./learn-view.ts";
import type { MemoryItem, MemoryList, Session, SkillView } from "./session.ts";
import { actionSheet, pick, Sheet } from "./sheet.ts";
import { openProposal, skillRow } from "./skills.ts";
import { toast } from "./toast.ts";
import { emptyState, group, row, techDetails } from "./ui.ts";

const KIND: Record<string, string> = {
  preference: t("common.preference"),
  person: t("common.person"),
  fact: t("common.fact"),
  project: t("common.project"),
};

const FILTERS: Array<[string, string]> = [
  ["", t("common.all")],
  ["preference", t("common.preference")],
  ["person", t("common.person")],
  ["fact", t("common.fact")],
  ["project", t("common.project")],
  ["user", t("common.youSaid")],
  ["inferred", t("common.guess")],
];

async function exportAll(s: Session) {
  const data = (await s.exportMemory()) as { memories?: unknown[]; skills?: unknown[] };
  const name = `alca-memory-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data, null, 2)], name, { type: "application/json" });
  const nav = navigator as Navigator & { canShare?(d: { files: File[] }): boolean };
  if (nav.canShare?.({ files: [file] }))
    await nav.share({ files: [file], title: t("phone.memory.alcaMemories") });
  else {
    const a = h("a", { href: URL.createObjectURL(file), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  toast(
    t("phone.memory.exportedMemoriesAndSkills", {
      memoriesCount: data.memories?.length ?? 0,
      skillsCount: data.skills?.length ?? 0,
    }),
  );
}

/** 編輯: a form sheet with 取消 / 儲存 in its nav bar. */
function editMemory(s: Session, m: MemoryItem, done: (id: string) => void) {
  let sheet!: Sheet;
  const area = h("textarea", {
    class: "field-area",
    rows: 5,
    "aria-label": t("common.content"),
    maxlength: "2000",
  });
  area.value = m.body;
  const error = h("p", { class: "inline-error", role: "alert", hidden: true });
  const save = h("button", { class: "text-btn strong", type: "button" }, t("common.save"));
  save.addEventListener("click", async () => {
    const text = area.value.trim();
    if (!text || text === m.body) return sheet.close();
    save.disabled = true;
    try {
      const r = await s.updateMemory(m.id, text);
      toast(t("phone.memory.savedAsANewVersion"));
      sheet.close();
      done(r.memory.id);
    } catch (e) {
      save.disabled = false;
      error.textContent = memoryChangeError(e, t("common.notSaved2"));
      error.hidden = false;
    }
  });
  sheet = new Sheet(
    h(
      "div",
      { class: "form-body" },
      h("div", { class: "cells" }, h("div", { class: "row field-row" }, area)),
      error,
      h("p", { class: "group-f" }, t("phone.memory.editsAreSavedAsA")),
    ),
    {
      label: t("common.edit2"),
      size: "tall",
      nav: {
        title: t("common.edit2"),
        leading: h(
          "button",
          { class: "text-btn", type: "button", onclick: () => sheet.close() },
          t("common.cancel"),
        ),
        trailing: save,
      },
    },
  );
  requestAnimationFrame(() => area.focus());
}

function openMemory(s: Session, start: MemoryItem, changed: () => void): Sheet {
  let m = start;
  const body = h("div", { class: "memory-item" });
  let sheet!: Sheet;
  const paint = () => {
    const can = s.can("approve");
    const from = memorySource(m);
    body.replaceChildren(
      h("p", { class: "mi-body" }, m.body),
      m.quote && m.quote !== m.body
        ? h("p", { class: "mi-quote" }, t("phone.memory.text", { quote: m.quote }))
        : "",
      group({
        rows: [
          row({
            title: t("phone.memory.who"),
            value: m.origin === "user" ? t("common.youSaid") : t("phone.memory.unconfirmed"),
          }),
          from ? row({ title: t("phone.memory.source"), value: memorySourceName(m) }) : null,
          row({ title: t("phone.memory.kind"), value: KIND[m.kind] ?? m.kind }),
          row({
            title: t("phone.memory.scope"),
            value: m.scope === "shared" ? t("phone.memory.sharedByAllBots") : t("phone.memory.onlyThisBot"),
          }),
          row({
            title: t("phone.memory.used"),
            value: m.uses ? t("common.usedTimes", { uses: m.uses }) : t("common.notUsedYet"),
          }),
          row({ title: t("phone.memory.updated"), value: ago(m.updatedAt) }),
        ],
      }),
      // L7: say up front that this phone cannot edit or forget (the computer would refuse).
      can ? "" : h("p", { class: "fine", role: "note" }, NO_APPROVE_MEMORY),
      m.origin === "inferred" && can
        ? h(
            "button",
            {
              class: "btn big primary mi-confirm",
              type: "button",
              onclick: async () => {
                haptic("success");
                await s.confirmMemory(m.id).catch(() => undefined);
                toast(t("common.confirmed"));
                m = { ...m, origin: "user" };
                paint();
                changed();
              },
            },
            t("phone.memory.thatsRight"),
          )
        : "",
      can
        ? group({
            rows: [
              row({
                title: t("common.edit2"),
                tone: "accent",
                onclick: () =>
                  editMemory(s, m, () => {
                    changed();
                    sheet.close();
                  }),
              }),
            ],
          })
        : "",
      can
        ? group({
            rows: [
              row({
                title: t("common.forget"),
                tone: "danger",
                center: true,
                onclick: () =>
                  actionSheet({
                    label: t("phone.memory.forgetMemory"),
                    title:
                      m.versions > 1
                        ? t("phone.memory.allVersionsOfThisMemory", { versions: m.versions })
                        : t("phone.memory.thisMemoryWillBeDeleted"),
                    message: t("phone.memory.alcaKeepsOnlyAnIrreversible"),
                    actions: [
                      {
                        label: t("phone.memory.forgetThisAction"),
                        tone: "danger",
                        run: async () => {
                          try {
                            await s.forgetMemory(m.id);
                          } catch (e) {
                            throw new Error(
                              memoryChangeError(e, t("phone.memory.notForgottenPleaseTryAgain")),
                            );
                          }
                          toast(t("phone.memory.forgotten"));
                          changed();
                          sheet.close();
                        },
                      },
                    ],
                  }),
              }),
            ],
          })
        : "",
      techDetails([
        [t("phone.memory.techId"), m.id],
        [
          t("phone.memory.techConfidence"),
          m.origin === "inferred" ? `${Math.round(m.confidence * 100)}%` : undefined,
        ],
        [t("phone.memory.techVersions"), String(m.versions)],
        [t("phone.memory.techCreated"), m.createdAt],
        [t("phone.memory.techBot"), m.botId],
      ]),
    );
  };
  paint();
  sheet = new Sheet(body, {
    label: t("common.memory"),
    size: "page",
    nav: { title: t("common.memory"), back: t("common.memory") },
  });
  return sheet;
}

function memoryPage(s: Session): Sheet {
  let query = "";
  let filter = "";
  let data: MemoryList | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const search = h("input", {
    class: "search-input",
    type: "search",
    placeholder: t("common.searchMemories"),
    "aria-label": t("common.searchMemories"),
    enterkeyhint: "search",
    autocomplete: "off",
  });
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      query = search.value.trim();
      void load();
    }, 220);
  });
  const filterBtn = h("button", {
    class: "filter-btn",
    type: "button",
    "aria-label": t("phone.memory.filter"),
  });
  filterBtn.addEventListener("click", () =>
    pick({
      label: t("phone.memory.filter"),
      options: FILTERS.map(
        ([k, label]) =>
          [k, t("phone.memory.filterCount", { label, count: data?.counts[k || "all"] ?? 0 })] as [
            string,
            string,
          ],
      ),
      current: filter,
      onPick: (k) => {
        filter = k;
        void load();
      },
    }),
  );
  const list = h("div", { class: "mem-list" });
  const paint = () => {
    filterBtn.replaceChildren(
      h("span", {}, FILTERS.find((x) => x[0] === filter)?.[1] ?? ""),
      icon("down", 14),
    );
    if (!data) {
      list.replaceChildren(emptyState(t("common.loading2")));
      return;
    }
    list.replaceChildren(
      data.items.length
        ? group({
            rows: data.items.map((m) =>
              row({
                title: h("span", { class: "mem-body" }, m.body),
                sub: memorySubtitle(m),
                chevron: true,
                onclick: () => openMemory(s, m, () => void load()),
                attrs: { "data-origin": m.origin, "data-memory": m.id },
              }),
            ),
            footer: t("phone.memory.memoriesLiveOnlyOnYour", {
              p0: data.forgotten ? t("phone.memory.forgotten2", { forgotten: data.forgotten }) : "",
            }),
          })
        : emptyState(
            query || filter ? t("common.noMatchingMemories") : t("phone.memory.noMemoriesTitle"),
            query || filter ? undefined : t("phone.memory.noMemoriesYetSayRemember"),
          ),
    );
  };
  async function load() {
    try {
      data = await s.listMemory(memoryQuery(filter, query));
    } catch (e) {
      toast(e instanceof Error ? e.message : t("phone.memory.cantReadMemories"));
    }
    paint();
  }
  const exportBtn = h(
    "button",
    {
      class: "icon-btn",
      type: "button",
      "aria-label": t("phone.memory.exportMemoriesJson"),
      onclick: () =>
        void exportAll(s).catch((e) => toast(e instanceof Error ? e.message : t("phone.memory.notExported"))),
    },
    icon("share", 22),
  );
  const off = s.subscribe((w) => (w === "memory" || w === "scopes") && void load());
  paint();
  void load();
  return new Sheet(
    h(
      "div",
      { class: "memory-page" },
      h(
        "div",
        { class: "search-bar" },
        h("label", { class: "search" }, icon("search", 17), search),
        filterBtn,
      ),
      list,
    ),
    {
      label: t("common.memory"),
      size: "page",
      nav: { title: t("common.memory"), back: t("phone.ui.tabLibrary"), trailing: exportBtn },
      onClose: off,
    },
  );
}

function skillsPage(s: Session): Sheet {
  let skills: SkillView[] = [];
  const body = h("div", { class: "skills-page" });
  const paint = () => {
    const rowFor = (sk: SkillView) =>
      skillRow(s, sk, { open: (x) => openProposal(s, x), toggled: () => void load(), error: toast });
    const waiting = skills.filter((x) => x.pending);
    const saved = skills.filter((x) => !x.pending);
    body.replaceChildren(
      waiting.length ? group({ header: t("phone.skills.waitingHeader"), rows: waiting.map(rowFor) }) : "",
      saved.length
        ? group({
            header: t("common.savedSkills"),
            rows: saved.map(rowFor),
            footer: t("phone.memory.skillsDontChangePermissionsPayments"),
          })
        : emptyState(t("phone.skills.noSkillsTitle"), t("phone.memory.noSkillsYetAfterA")),
    );
  };
  async function load() {
    skills = await s.listSkills().catch(() => skills);
    paint();
  }
  const off = s.subscribe((w) => (w === "skill-list" || w === "skills" || w === "scopes") && void load());
  paint();
  void load();
  return new Sheet(body, {
    label: t("phone.library.skills"),
    size: "page",
    nav: { back: t("phone.ui.tabLibrary") },
    onClose: off,
  });
}

/** 記憶 or 技能, each its own page (no segmented control between them). */
export function openLibrary(s: Session, first: "memory" | "skills" = "memory"): Sheet {
  return first === "skills" ? skillsPage(s) : memoryPage(s);
}
