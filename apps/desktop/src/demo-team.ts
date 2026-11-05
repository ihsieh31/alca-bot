import { type ScriptStep, streamText } from "@alca/engines";

/**
 * Offline demo of the team (P7): what a router model would do with
 * teammates. The person names a teammate ("請研究員…", "問寫手…") and the
 * router asks or delegates; a teammate's request is answered or handed to
 * its own worker; a peer report is summarised for the person.
 */

const say = (text: string, delay = 12): ScriptStep[] => streamText(text, 2, delay);
const call = (id: string, name: string, input: Record<string, unknown>): ScriptStep[] => [
  { type: "tool.call", id, name, input },
  { type: "done", stop: "tool_use" },
];

/** Teammates listed in the router's `<alca:team>` block. */
export function teammates(volatile: string): Array<{ name: string; role: string }> {
  const block = /<alca:team>\n([\s\S]*?)\n<\/alca:team>/.exec(volatile)?.[1] ?? "";
  return block
    .split("\n")
    .map((l) => /^- 「([^」]+)」bot_[0-9A-Z]{26}(?:：([^（\n]+))?/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1] as string, role: (m[2] ?? "").trim() }));
}

export const myName = (volatile: string) => /你是「([^」]+)」/.exec(volatile)?.[1] ?? "Alca";

/** The person's message names a teammate: ask or delegate. */
export function teamFirst(text: string, volatile: string): ScriptStep[] | undefined {
  const mates = teammates(volatile);
  if (!mates.length) return undefined;
  const t = text.replace(/^[@＠]\S+\s*/, "");
  for (const m of mates) {
    const i = t.indexOf(m.name);
    if (i < 0) continue;
    const before = t.slice(0, i);
    const rest =
      t
        .slice(i + m.name.length)
        .replace(/^[，,：:\s]*(幫我|幫忙|去)?/, "")
        .trim() || t;
    if (/問/.test(before))
      return [
        ...say(`我問一下「${m.name}」。`),
        ...call("rt-peer", "peer_ask", { bot: m.name, question: rest }),
      ];
    if (/請|交給|讓|派|找/.test(before))
      return [
        ...say(`這件交給「${m.name}」${m.role ? `（${m.role}）` : ""}最適合，我請他處理。`),
        ...call("rt-peer", "peer_delegate", { bot: m.name, task: rest }),
      ];
  }
  // The lead routes by role when the person names none.
  if (/你是團隊的領頭/.test(volatile)) {
    const pick = mates.find((m) => m.role.length >= 2 && t.includes(m.role.slice(0, 2)));
    if (pick)
      return [
        ...say(`我請「${pick.name}」來做這件，他負責${pick.role}。`),
        ...call("rt-peer", "peer_delegate", { bot: pick.name, task: t }),
      ];
  }
  return undefined;
}

/** A teammate's request arrived (`<alca:peer>`). */
export function teamRequest(msg: string, volatile: string): ScriptStep[] | undefined {
  const m =
    /<alca:peer id="[^"]+" kind="(ask|delegate)" from="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/alca:peer>/.exec(msg);
  if (!m) return undefined;
  const [, kind, from, text] = m as unknown as [string, string, string, string];
  const me = myName(volatile);
  if (kind === "delegate" && /查|整理|比價|寫|稿|結帳|寄|刪除|翻譯|報告|研究/.test(text))
    return [
      ...say(`收到「${from}」的交辦，我開一個任務去做。`),
      ...call("rt-one", "worker_start", { title: text.slice(0, 14), goal: text }),
    ];
  return say(
    `${me}的回答：${kind === "ask" ? `關於「${text.slice(0, 40)}」，` : ""}我這邊整理好了，重點是先確認時間，再分頭進行。`,
  );
}

/** A teammate answered (`<alca:peer-report>`). */
export function teamReport(msg: string): ScriptStep[] | undefined {
  const m =
    /<alca:peer-report id="[^"]+" bot="([^"]+)" kind="[a-z]+" status="([a-z]+)">\n([\s\S]*?)<\/alca:peer-report>/.exec(
      msg,
    );
  if (!m) return undefined;
  const [, bot, status, body] = m as unknown as [string, string, string, string];
  const text = body.replace(/^原因：.*\n?/, "").trim();
  if (status !== "done") return say(`「${bot}」這次沒有完成（${status}）。${text.split("\n")[0] ?? ""}`);
  const line = text.split("\n").filter(Boolean).at(-1) ?? text;
  return say(`「${bot}」回覆了：${line.slice(0, 200)}`);
}
