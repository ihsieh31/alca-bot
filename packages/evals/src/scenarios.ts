import { approvalScenarios } from "../scenarios/approvals.ts";
import { bypassScenarios } from "../scenarios/bypass.ts";
import { careScenarios } from "../scenarios/care.ts";
import { connectorScenarios } from "../scenarios/connectors.ts";
import { conversationScenarios, mustFollowScenarios } from "../scenarios/conversation.ts";
import { askHarnessScenarios } from "../scenarios/harness-asks.ts";
import { codingHarnessScenarios } from "../scenarios/harness-coding.ts";
import { d2HarnessScenarios } from "../scenarios/harness-d2.ts";
import { generalHarnessScenarios } from "../scenarios/harness-general.ts";
import { restartHarnessScenarios } from "../scenarios/harness-restart.ts";
import { sandboxHarnessScenarios } from "../scenarios/harness-sandbox.ts";
import { webSearchHarnessScenarios } from "../scenarios/harness-web-search.ts";
import { injectionScenarios } from "../scenarios/injection.ts";
import { memoryScenarios } from "../scenarios/memory.ts";
import { addonScenarios, proactiveScenarios } from "../scenarios/proactive.ts";
import { routerScenarios } from "../scenarios/router.ts";
import { routineScenarios } from "../scenarios/routines.ts";
import { shellScenarios } from "../scenarios/shell.ts";
import { teamScenarios } from "../scenarios/team.ts";
import type { Scenario } from "./harness.ts";

/** Every scenario, in report order. Add new files here. */
export const SCENARIOS: readonly Scenario[] = [
  ...routerScenarios,
  ...approvalScenarios,
  ...shellScenarios,
  ...bypassScenarios,
  ...memoryScenarios,
  ...routineScenarios,
  ...teamScenarios,
  ...injectionScenarios,
  // P14 (plan v10 §E)
  ...conversationScenarios,
  ...mustFollowScenarios,
  // Care moments
  ...careScenarios,
  ...proactiveScenarios,
  ...addonScenarios,
  // Worker harness (Phase 7)
  ...codingHarnessScenarios,
  ...sandboxHarnessScenarios,
  ...generalHarnessScenarios,
  ...askHarnessScenarios,
  ...restartHarnessScenarios,
  // Next round R1
  ...webSearchHarnessScenarios,
  // Next round R8
  ...connectorScenarios,
  // Next round, Phase D2 (stream wake, structured results, 續做)
  ...d2HarnessScenarios,
];
