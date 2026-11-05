// Skills on the phone (§4.1 phone-skill-proposal / phone-skills): a proposal
// is a pushed page — its name, its steps as numbered rows in plain words (a
// lock on the steps Alca always asks about), 〔存成技能〕 and 〔不要〕. A saved
// skill is a row with a switch; tap it for its steps. Saving a skill never
// changes what Alca asks before paying, sending, deleting or publishing.
import { ago, h, haptic, icon } from "./dom.ts";
import { t as tx } from "./i18n/index.ts";
import { confirmClasses, markedSteps, skillMeta } from "./learn-view.ts";
import type { Session, SkillVersionView, SkillView } from "./session.ts";
import { Sheet } from "./sheet.ts";
import { group, row, switchEl, switchRow, techDetails } from "./ui.ts";

/** The steps as numbered rows; a lock marks the always-confirm ones. */
export function stepList(v: SkillVersionView, header?: string): HTMLElement {
  const marks = new Set(markedSteps(v));
  return group({
    header: header ?? tx("phone.skills.stepsHeader", { n: v.steps.length }),
    rows: v.steps.map((st, i) =>
      row({
        lead: h("span", { class: "step-num", "aria-hidden": "true" }, String(i + 1)),
        title: st.text,
        value: marks.has(i)
          ? h("span", { class: "step-lock", "aria-label": tx("phone.skills.alwaysAsks") }, icon("lock", 16))
          : null,
        attrs: { "data-marked": marks.has(i) ? "true" : undefined },
      }),
    ),
    footer: marks.size ? tx("phone.skills.lockFooter") : null,
    className: "steps",
  });
}

/** The proposal as a pushed page. */
export function openProposal(s: Session, sk: SkillView, others = 0): Sheet | undefined {
  const v = sk.pending;
  if (!v) return undefined;
  const classes = confirmClasses(v);
  const revision = sk.version > 0;
  const can = s.can("approve");
  const error = h("p", { class: "inline-error", role: "alert", hidden: true });
  let sheet!: Sheet;
  const decide = (b: HTMLButtonElement, d: "approve" | "reject") => async () => {
    const all = b.parentElement?.querySelectorAll("button") ?? [];
    for (const x of all) x.disabled = true;
    b.dataset.busy = "true";
    try {
      await s.decideSkill(sk.id, d, v.version);
      haptic(d === "approve" ? "success" : "tap");
      sheet.close();
    } catch (e) {
      for (const x of all) x.disabled = false;
      delete b.dataset.busy;
      error.textContent = e instanceof Error ? e.message : tx("common.notSentPleaseTryAgain");
      error.hidden = false;
      haptic("warn");
    }
  };
  const approve = h(
    "button",
    { class: "btn big primary", type: "button", "data-role": "approve" },
    h("span", { class: "btn-label" }, revision ? tx("common.applyUpdate") : tx("common.saveAsSkill")),
  );
  const reject = h("button", { class: "btn big secondary", type: "button" }, tx("phone.approval.dont"));
  reject.addEventListener("click", decide(reject, "reject"));
  approve.addEventListener("click", decide(approve, "approve"));
  if (!can) {
    reject.disabled = true;
    approve.disabled = true;
  }
  const body = h(
    "article",
    { class: "skill-page" },
    h(
      "header",
      { class: "task-head" },
      h(
        "p",
        { class: "ap-eyebrow" },
        revision ? tx("phone.skills.updateFor", { version: v.version }) : tx("phone.skills.alcaLearned"),
      ),
      h("h1", { class: "task-title" }, v.name),
      h(
        "p",
        { class: "task-status" },
        sk.source.threadTitle
          ? tx("phone.skills.fromThread", { threadTitle: sk.source.threadTitle })
          : v.description,
      ),
    ),
    v.triggers.length
      ? group({
          header: tx("phone.skills.mentioned"),
          rows: [row({ title: v.triggers.join(tx("phone.skills.joiner")) })],
        })
      : "",
    stepList(v),
    v.note ? h("p", { class: "fine sk-note" }, v.note) : "",
    h(
      "p",
      { class: "ap-lock" },
      icon(classes.length ? "lock" : "info", 14),
      h("span", {}, classes.length ? tx("common.onceSavedAsASkill") : tx("phone.skills.onceSavedAsASkill")),
    ),
    !can ? h("p", { class: "fine" }, tx("common.thisPhoneDoesntHaveThe")) : "",
    error,
    h("div", { class: "ap-actions" }, approve, reject),
    others > 0 ? h("p", { class: "ap-more" }, tx("phone.skills.moreMethodsWaitingForYou", { others })) : "",
    techDetails([
      [tx("phone.skills.techId"), sk.id],
      [tx("phone.skills.techVersion"), String(v.version)],
      [
        tx("phone.skills.techTools"),
        v.steps
          .map((x) => x.tool)
          .filter(Boolean)
          .join(", "),
      ],
      [tx("phone.skills.techClasses"), v.actionClasses.join(", ")],
    ]),
  );
  sheet = new Sheet(body, { label: tx("phone.skills.skillProposal"), size: "page", nav: { title: "" } });
  return sheet;
}

function openSkill(sk: SkillView, v: SkillVersionView): Sheet {
  return new Sheet(
    h(
      "div",
      { class: "skill-page" },
      h(
        "header",
        { class: "task-head" },
        h("h1", { class: "task-title" }, v.name),
        h("p", { class: "task-status" }, skillMeta(sk, ago(sk.lastUsedAt))),
      ),
      v.description ? h("p", { class: "fine sk-desc" }, v.description) : "",
      v.triggers.length
        ? group({
            header: tx("phone.skills.mentioned"),
            rows: [row({ title: v.triggers.join(tx("phone.skills.joiner")) })],
          })
        : "",
      stepList(v),
      techDetails([
        [tx("phone.skills.techId"), sk.id],
        [tx("phone.skills.techVersion"), String(v.version)],
        [
          tx("phone.skills.techTools"),
          v.steps
            .map((x) => x.tool)
            .filter(Boolean)
            .join(", "),
        ],
      ]),
    ),
    { label: v.name, size: "page", nav: { title: "", back: tx("phone.library.skills") } },
  );
}

/** One row of 技能: a proposal (opens its page) or a saved skill with its switch. */
export function skillRow(
  s: Session,
  sk: SkillView,
  o: { open(sk: SkillView): void; toggled(): void; error(msg: string): void },
): HTMLElement {
  const v = sk.pending && sk.version === 0 ? sk.pending : (sk.current ?? sk.pending);
  if (!v) return h("div");
  const proposal = !!sk.pending;
  const meta = skillMeta(sk, ago(sk.lastUsedAt));
  const locked = confirmClasses(v).length > 0;
  const title = h("span", { class: "sk-name" }, v.name, locked ? icon("lock", 14) : null);
  if (proposal && sk.version === 0)
    return row({
      title,
      sub: meta,
      subTone: "waiting",
      chevron: true,
      onclick: () => o.open(sk),
      attrs: { "data-skill": sk.id, "data-proposal": "true" },
    });
  const sw = switchEl(
    sk.status === "active",
    tx("common.text5", { p0: tx("common.enable"), name: v.name }),
    async (on, el) => {
      haptic("tap");
      try {
        await s.setSkillEnabled(sk.id, on);
        o.toggled();
      } catch (err) {
        el.checked = !on;
        o.error(err instanceof Error ? err.message : tx("common.notChanged"));
      }
    },
  );
  sw.disabled = !s.can("approve");
  const r = switchRow({ title, sub: meta, subTone: proposal ? "waiting" : undefined, sw });
  r.dataset.skill = sk.id;
  // The text part opens the steps (or the update waiting for a yes); the switch stays a switch.
  r.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("input")) return;
    if (proposal) o.open(sk);
    else openSkill(sk, v);
  });
  r.classList.add("tappable");
  return r;
}
