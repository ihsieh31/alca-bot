import type { ActionClass } from "@alca/policy";

/**
 * What a connected-app tool does, as one of our action classes. It decides
 * the approval card: send / publish / delete / payment always ask (the
 * frozen host constant), write asks under 每步確認, read runs.
 *
 * Inputs: the tool slug (`GMAIL_SEND_EMAIL`) and the provider's tags
 * (`readOnlyHint`, `createHint`, `updateHint`, `destructiveHint`). Tags are
 * best effort on the provider side, so the slug's verbs can only make a
 * class stricter, and anything we cannot place fails closed to `send`.
 */

const W = (s: string) => new RegExp(`(?:^|_)(?:${s})(?:_|$)`);

const PAYMENT = W("PAY|PAYMENT|CHARGE|PURCHASE|CHECKOUT|REFUND|TRANSFER_FUNDS|PAYOUT|BUY|ORDER_CREATE");
const DELETE = W(
  "DELETE|DELETES|REMOVE|TRASH|PURGE|DESTROY|ERASE|ARCHIVE_REPO|BATCH_DELETE|REVOKE|UNSUBSCRIBE|CANCEL",
);
const SEND = W(
  "SEND|SENDS|REPLY|FORWARD|POST_MESSAGE|CHAT_POST_MESSAGE|PUSH_MESSAGE|SEND_PUSH_MESSAGE|INVITE|NOTIFY|DM|MESSAGE_SEND|SHARE",
);
const PUBLISH = W(
  "PUBLISH|POST|TWEET|COMMENT|CREATE_AN_ISSUE|CREATE_ISSUE|CREATE_A_PULL_REQUEST|MERGE|RELEASE|DEPLOY|PUSH|COMMIT|REVIEW|DISPATCH|CLOSE_ISSUE|CLOSE_PULL_REQUEST|REACT|REACTION|CREATE_EVENT|QUICK_ADD",
);
/** Local-only effects on the person's own account: drafts, labels, read marks. */
const OWN_WRITE = W(
  "DRAFT|CREATE_EMAIL_DRAFT|UPDATE_DRAFT|LABEL|LABELS|MODIFY_MESSAGES|MARK|MARK_MESSAGES_AS_READ|STAR|UNSTAR|PIN|UNPIN|SNOOZE|MOVE_TO|ADD_LABEL",
);
const READ = W(
  "GET|GETS|LIST|LISTS|FETCH|SEARCH|FIND|READ|LOOKUP|QUERY|RETRIEVE|DOWNLOAD|EXPORT|CHECK|COUNT|INSIGHT|INFO|HISTORY|DESCRIBE|VIEW|SHOW|STATUS|PREVIEW|IDS|WATCH",
);

const READ_VERBS = new Set([
  "GET",
  "LIST",
  "FETCH",
  "SEARCH",
  "FIND",
  "READ",
  "LOOKUP",
  "QUERY",
  "RETRIEVE",
  "DOWNLOAD",
  "EXPORT",
  "CHECK",
  "COUNT",
  "DESCRIBE",
  "VIEW",
]);

const DESTRUCTIVE_WINS: readonly ActionClass[] = ["payment", "delete", "send", "publish"];

export function classifyAppTool(slug: string, tags: readonly string[] = []): ActionClass {
  const s = slug.toUpperCase();
  if (PAYMENT.test(s)) return "payment";
  if (tags.includes("destructiveHint") || DELETE.test(s)) return "delete";
  // `<APP>_<VERB>_…`: a read verb right after the app name reads, whatever words follow (GMAIL_LIST_SEND_AS).
  const verb = s.split("_")[1] ?? "";
  const changes = tags.includes("createHint") || tags.includes("updateHint");
  if (!changes && READ_VERBS.has(verb)) return "read";
  // A draft or a label is only a write, even when the slug also says SEND (GMAIL_SEND_DRAFT is a send).
  if (/(?:^|_)SEND_DRAFT(?:_|$)/.test(s)) return "send";
  if (OWN_WRITE.test(s) && !SEND.test(s.replace(/_?DRAFTS?_?/g, "_"))) return "write";
  if (SEND.test(s)) return "send";
  if (PUBLISH.test(s)) return "publish";
  const readOnly = tags.includes("readOnlyHint");
  if (readOnly && !changes) return "read";
  if (!changes && READ.test(s)) return "read";
  if (tags.includes("updateHint") && !tags.includes("createHint")) return "write";
  // Creates something somewhere else, or we cannot tell: fail closed.
  return "send";
}

/** Verbs that read when nothing else in the name says otherwise (mac test 2026-11 B9). */
const PLAIN_READ = W("LIST|LISTS|GET|GETS|SEARCH|FIND|FETCH");
/** Anything that changes, starts or chains an action: such a name is never "plainly a read". */
const NOT_PLAIN = W(
  "CREATE|INSERT|ADD|NEW|UPDATE|PATCH|PUT|SET|MODIFY|EDIT|WRITE|APPEND|REPLACE|RENAME|MOVE|COPY|UPLOAD|IMPORT|SAVE|SUBMIT|RUN|EXECUTE|START|STOP|TRIGGER|ENABLE|DISABLE|ACCEPT|APPROVE|DECLINE|RESPOND|RSVP|BOOK|SCHEDULE|SYNC|RESTORE|WIPE|CLEAR|RESET|EMPTY|AND|THEN|PLUS|ALSO|WITH|OR|TO|INTO|AS|BATCH|BULK|ALL|EVERYTHING",
);

/**
 * Mac test 2026-11 B9: a tool the provider could not describe (no account,
 * provider unreachable) still fails closed — except a name that is plainly
 * a read: a LIST / GET / SEARCH / FIND / FETCH word and nothing that
 * changes, starts, chains or bulk-applies anything (`GOOGLECALENDAR_EVENTS_LIST`).
 * CREATE, SEND, DELETE, UPDATE and every other class keep their own rule.
 */
export function plainlyRead(slug: string): boolean {
  const s = slug.toUpperCase();
  if (!PLAIN_READ.test(s) || NOT_PLAIN.test(s)) return false;
  return ![PAYMENT, DELETE, SEND, PUBLISH, OWN_WRITE].some((r) => r.test(s));
}

/** The stricter of two classes (an inspection may only escalate). */
export function stricter(a: ActionClass, b: ActionClass): ActionClass {
  const rank = (c: ActionClass) => {
    const i = DESTRUCTIVE_WINS.indexOf(c);
    if (i >= 0) return 10 - i;
    return c === "read" ? 0 : 1;
  };
  return rank(b) > rank(a) ? b : a;
}

export const CLASS_WORD: Record<string, string> = {
  read: "讀取",
  write: "寫入",
  send: "寄送",
  publish: "發布",
  delete: "刪除",
  payment: "付款",
  execute: "執行",
  network: "連線",
};
