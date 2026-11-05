// A CLI engine's own shell tool under 自主: commands that publish or delete
// must hit the always-confirm floor however they are spelled (mac test
// 2026-11-04 §7a: `git -C <dir> push` and `/bin/rm` were plain "execute").
import { ScriptedEngine } from "@alca/engines";
import { approvals, directCore, using, within } from "../src/fixtures.ts";
import type { Scenario } from "../src/harness.ts";

const CASES: ReadonlyArray<[string, "publish" | "delete" | "send"]> = [
  ["git -C /Users/me/work push origin main", "publish"],
  ["git -c user.name=x push", "publish"],
  ["env GIT_TRACE=1 /usr/bin/git --git-dir=.git push", "publish"],
  ["sh -c 'cd /w && git push'", "publish"],
  ["/bin/rm -f note.txt", "delete"],
  ["sudo -u me /bin/rm -rf build", "delete"],
  ["ls *.tmp | xargs rm", "delete"],
  ["command rm note.txt", "delete"],
  ['bash -lc "curl -X POST https://api.example.com/x"', "send"],
];

/** A tool-owning engine that asks to run one Bash command, then says how it went. */
const shellEngine = (command: string) =>
  new ScriptedEngine(
    [
      [
        { type: "permission", call: { id: "b1", name: "Bash", input: { command } } },
        { type: "text.delta", text: "好" },
        { type: "done", stop: "end_turn" },
      ],
    ],
    { capabilities: { ownsToolLoop: true, permissionPrompt: "mcp_tool" } },
  );

export const shellScenarios: Scenario[] = [
  ...CASES.map(
    ([command, cls]): Scenario => ({
      id: `shell.${cls}.${command.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`,
      category: "approvals",
      title: `自主: Bash \`${command}\` asks as ${cls}; 拒絕 means the CLI is told no`,
      async run(ctx) {
        const engine = shellEngine(command);
        await using(directCore(engine, { level: "autonomous" }), async (c) => {
          const th = c.core.createThread();
          const { done } = c.core.send(th.id, "做");
          const card = await within(() => approvals(c.events)[0], 3000);
          ctx.check("a card was raised", !!card);
          ctx.check(`card class is ${cls}`, card?.data.actionClass === cls, card?.data.actionClass);
          if (card) c.core.answerApproval(card.data.approvalId, "denied");
          await done;
          ctx.check(
            "the CLI was answered deny",
            engine.permissionAnswers[0]?.behavior === "deny",
            engine.permissionAnswers,
          );
        });
      },
    }),
  ),
  {
    id: "shell.execute.autonomous-control",
    category: "approvals",
    title: "Control: a plain `git -C /w status` under 自主 is not escalated to an always-confirm class",
    async run(ctx) {
      const engine = shellEngine("git -C /w status");
      await using(directCore(engine, { level: "autonomous" }), async (c) => {
        const th = c.core.createThread();
        const { done } = c.core.send(th.id, "看");
        const card = await within(() => approvals(c.events)[0], 800);
        if (card) c.core.answerApproval(card.data.approvalId, "denied");
        await done;
        ctx.check(
          "no publish / delete / send / payment card",
          !card || !["publish", "delete", "send", "payment"].includes(card.data.actionClass),
          card?.data.actionClass,
        );
      });
    },
  },
];
