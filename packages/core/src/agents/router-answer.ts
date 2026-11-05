import type { InitiatorT } from "@alca/protocol";
import type { Store, WorkerRecord } from "@alca/store";
import { defuseAlcaTags } from "@alca/tools";
import type { HostTool } from "../turn.ts";
import type { WorkerSupervisor } from "./workers.ts";

/**
 * Plan §2.8: the router answers a worker's NEEDS_INPUT with `worker_answer`.
 * Who may answer is the supervisor's check (`answerRefusal`): a person-only
 * question only with the person's own words (a turn the person started); the
 * rest by the router itself only at the bot's effective autonomous level.
 * The answer goes to a continuation worker on the same dispatch; a second
 * answer to the same question is refused by the database.
 */

export const ANSWER_RULE =
  "工人回報 NEEDS_INPUT 時：標「只有本人能答」的一律問使用者，等他回覆後用 worker_answer 轉交他的原話；回報裡寫你可以自己回答的，才用已知資訊以 worker_answer 回答；其他情況問使用者。答案照題號順序，每題一個。";

/** R9.6: ANSWER_RULE in English (registered with the router's rules). */
export const ANSWER_RULE_EN =
  'When a worker reports NEEDS_INPUT: a question marked "only the person can answer" always goes to the user; wait for the reply, then pass their own words on with worker_answer. Answer with worker_answer from what you know only where the report says you may answer yourself; otherwise ask the user. Give the answers in the order of the question numbers, one per question.';

export interface AnswerDeps {
  store: Store;
  workers: () => WorkerSupervisor;
  initiatorOf: (runId: string) => InitiatorT;
}

export function answerTool(d: AnswerDeps): HostTool {
  return {
    spec: {
      name: "worker_answer",
      description:
        "回答工人的 NEEDS_INPUT（工人回報 status=needs_input 時）：workerId 與 answers（照題號順序，每題一個答案）。工作會由新的工人帶著回答接著做。只有使用者本人能回答的題目，只能轉交使用者自己說的答案。",
      inputSchema: {
        type: "object",
        properties: {
          workerId: { type: "string" },
          answers: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        },
        required: ["workerId", "answers"],
        additionalProperties: false,
      },
    },
    actionClass: "read",
    run: async (a, _signal, ctx) => {
      if (!ctx) throw new Error("沒有回合資訊");
      const id = typeof a.workerId === "string" ? a.workerId : "";
      const answers = Array.isArray(a.answers)
        ? a.answers.map((x) => (typeof x === "string" ? x : String(x ?? "")))
        : typeof a.answers === "string"
          ? [a.answers]
          : [];
      const w = d.store.workers.get(id);
      if (!w || w.botId !== ctx.botId) throw new Error(`找不到工人 ${id}`);
      const next = d.workers().answer(id, answers, d.initiatorOf(ctx.runId).kind);
      return `已轉交回答，工作由 ${next.id} 接著做；完成時你會收到回報。`;
    },
  };
}

/**
 * Mac test 2026-11 B7: what the router reads when the person answered a
 * worker's NEEDS_INPUT from a worker panel (desktop or phone). Without it
 * the router only heard the continuation worker say "the person answered",
 * and rightly refused to take a worker's word for the person's. The note
 * goes in as an inbox item the person initiated (`from="user"`), before the
 * continuation reports.
 */
export function panelAnswerNote(
  w: Pick<WorkerRecord, "id" | "title">,
  questions: ReadonlyArray<{ question: string }>,
  answers: readonly string[],
  nextId: string,
): string {
  return [
    `<alca:panel-answer worker="${w.id}" from="user" title="${w.title.replaceAll('"', "'")}">`,
    "使用者在面板回答了：",
    ...answers.map((a, i) => {
      const q = questions[i]?.question;
      return `${i + 1}. ${q ? `${defuseAlcaTags(q)} → ` : ""}${defuseAlcaTags(a)}`;
    }),
    "</alca:panel-answer>",
    `這是使用者本人在工人面板上送出的回答（不是工人轉述的），已經交給 ${nextId} 接著做。不要再問一次；簡短告訴使用者收到了、正在接著做即可。`,
  ].join("\n");
}

/** What the router reads when a worker's question expired unanswered (once). */
export function expiredReport(w: WorkerRecord): string {
  return [
    `<alca:worker id="${w.id}" status="expired" ok="false" title="${w.title.replaceAll('"', "'")}">`,
    `工人「${defuseAlcaTags(w.title)}」問的問題 72 小時沒有人回答，已經過期；這件工作停在這裡。`,
    "</alca:worker>",
    "請簡短告訴使用者這件工作因為沒有收到回答而停止，需要的話可以重新交辦。",
  ].join("\n");
}
