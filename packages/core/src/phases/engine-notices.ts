import { CONTEXT_RESET } from "@alca/engines";
import type { PromptLanguage } from "../conversation-rules.ts";

/** Review 2026-11-05 #4: engine notices (`EngineEvent` "notice") the core words in the bot's language. */
export const ENGINE_NOTICES: Readonly<Record<string, Readonly<Record<PromptLanguage, string>>>> = {
  [CONTEXT_RESET]: {
    zh: "之前的對話脈絡無法還原（引擎的工作階段已不存在），這一回合從新的工作階段開始；重要的事請再說一次。",
    en: "The earlier context could not be restored (the engine's session is gone), so this turn starts a fresh session; please repeat anything important.",
  },
};
