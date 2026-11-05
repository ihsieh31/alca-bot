import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { backupBeforeMigrate } from "./backup.ts";
import { openDatabase } from "./db.ts";
import { DbWorker } from "./db-worker.ts";
import { type MigrateResult, type Migration, migrate } from "./migrate.ts";
import { initialSchema } from "./migrations/0001-initial.ts";
import { runtimeSchema } from "./migrations/0002-runtime.ts";
import { botsSchema } from "./migrations/0003-bots.ts";
import { agentsSchema } from "./migrations/0004-agents.ts";
import { linkSchema } from "./migrations/0005-link.ts";
import { memorySchema } from "./migrations/0006-memory.ts";
import { connectorsSchema } from "./migrations/0007-connectors.ts";
import { teamSchema } from "./migrations/0008-team.ts";
import { pushSchema } from "./migrations/0009-push.ts";
import { memoryExtractSchema } from "./migrations/0010-memory-extract.ts";
import { providersSchema } from "./migrations/0011-providers.ts";
import { agentFeaturesSchema } from "./migrations/0012-agent-features.ts";
import { linkSendsSchema } from "./migrations/0013-link-sends.ts";
import { linkSendsPendingSchema } from "./migrations/0014-link-sends-pending.ts";
import { threadDeleteSchema } from "./migrations/0015-thread-delete.ts";
import { workerToolErrorsSchema } from "./migrations/0016-worker-tool-errors.ts";
import { addonsOffersSchema } from "./migrations/0017-addons-offers.ts";
import { workerHarnessSchema } from "./migrations/0018-worker-harness.ts";
import { fullAccessSchema } from "./migrations/0019-full-access.ts";
import { workerCachedTokensSchema } from "./migrations/0020-worker-cached-tokens.ts";
import { retentionSchema } from "./migrations/0021-retention.ts";
import { eraseSchema } from "./migrations/0022-erase.ts";
import { integrationsSchema } from "./migrations/0023-integrations.ts";
import { botSandboxSchema } from "./migrations/0024-bot-sandbox.ts";
import { sealSchema } from "./migrations/0025-seal.ts";
import { botLanguageSchema } from "./migrations/0026-bot-language.ts";
import { dropGoogleDirectSchema } from "./migrations/0027-drop-google-direct.ts";
import { sealJobsSchema } from "./migrations/0028-seal-jobs.ts";
import { proactiveLogSchema } from "./migrations/0029-proactive-log.ts";
import { sealOffersSchema } from "./migrations/0030-seal-offers.ts";
import { sealTopicStateSchema } from "./migrations/0031-seal-topic-state.ts";
import { careLogSchema } from "./migrations/0032-care-log.ts";
import { AddonRepo } from "./repos/addons.ts";
import { HumanInputRepo } from "./repos/approvals.ts";
import { BotRepo } from "./repos/bots.ts";
import { CareLogRepo } from "./repos/care-log.ts";
import { ClientOpRepo } from "./repos/client-ops.ts";
import { ConnectorRepo } from "./repos/connectors.ts";
import { DeviceRepo } from "./repos/devices.ts";
import { DispatchRepo } from "./repos/dispatches.ts";
import { EarlyWorkRepo } from "./repos/early.ts";
import { GitSnapshotRepo } from "./repos/git-snapshots.ts";
import { MemoryRepo } from "./repos/memories.ts";
import { OfferRepo } from "./repos/offers.ts";
import { ProactiveLogRepo } from "./repos/proactive-log.ts";
import { PushRepo } from "./repos/push.ts";
import { RoutineRepo } from "./repos/routines.ts";
import { RunRepo } from "./repos/runs.ts";
import { SkillRepo } from "./repos/skills.ts";
import { SnapshotRepo } from "./repos/snapshots.ts";
import { TeamRepo } from "./repos/team.ts";
import { ThreadRepo } from "./repos/threads.ts";
import { TriggerRepo } from "./repos/triggers.ts";
import { WorkerRepo } from "./repos/workers.ts";
import { convertAutoVacuum, type VacuumConversion } from "./retention.ts";
import { bindSealer, checkSealKey, type Sealer } from "./seal.ts";

export * from "./audit.ts";
export * from "./backup.ts";
export * from "./batch.ts";
export * from "./cjk.ts";
export * from "./db.ts";
export * from "./db-jobs.ts";
export * from "./db-worker.ts";
export * from "./erase.ts";
export * from "./export.ts";
export * from "./ids.ts";
export * from "./migrate.ts";
export * from "./perf.ts";
export * from "./repos/addons.ts";
export * from "./repos/approvals.ts";
export * from "./repos/bots.ts";
export * from "./repos/care-log.ts";
export * from "./repos/client-ops.ts";
export * from "./repos/connectors.ts";
export * from "./repos/devices.ts";
export * from "./repos/dispatch-cap.ts";
export * from "./repos/dispatches.ts";
export * from "./repos/early.ts";
export * from "./repos/git-snapshots.ts";
export * from "./repos/job-events.ts";
export * from "./repos/job-rows.ts";
export * from "./repos/memories.ts";
export * from "./repos/offers.ts";
export * from "./repos/proactive-log.ts";
export * from "./repos/push.ts";
export * from "./repos/routines.ts";
export * from "./repos/runs.ts";
export * from "./repos/skills.ts";
export * from "./repos/snapshots.ts";
export * from "./repos/team.ts";
export * from "./repos/threads.ts";
export * from "./repos/triggers.ts";
export * from "./repos/workers.ts";
export * from "./retention.ts";
export * from "./seal.ts";
export * from "./seal-pass.ts";
export * from "./upkeep.ts";

/** All migrations, in order. Append new ones; never edit shipped ones. */
export const MIGRATIONS: readonly Migration[] = [
  initialSchema,
  runtimeSchema,
  botsSchema,
  agentsSchema,
  linkSchema,
  memorySchema,
  connectorsSchema,
  teamSchema,
  pushSchema,
  memoryExtractSchema,
  providersSchema,
  agentFeaturesSchema,
  linkSendsSchema,
  linkSendsPendingSchema,
  threadDeleteSchema,
  workerToolErrorsSchema,
  addonsOffersSchema,
  workerHarnessSchema,
  fullAccessSchema,
  workerCachedTokensSchema,
  retentionSchema,
  eraseSchema,
  integrationsSchema,
  botSandboxSchema,
  sealSchema,
  botLanguageSchema,
  dropGoogleDirectSchema,
  sealJobsSchema,
  proactiveLogSchema,
  sealOffersSchema,
  sealTopicStateSchema,
  careLogSchema,
];

export interface Store {
  db: DatabaseSync;
  memory: MemoryRepo;
  skills: SkillRepo;
  threads: ThreadRepo;
  runs: RunRepo;
  human: HumanInputRepo;
  bots: BotRepo;
  workers: WorkerRepo;
  triggers: TriggerRepo;
  devices: DeviceRepo;
  connectors: ConnectorRepo;
  routines: RoutineRepo;
  /** P7: team rules, peer requests, engine providers. */
  team: TeamRepo;
  /** P8: Web Push subscriptions per paired device. */
  push: PushRepo;
  /** P13: file contents before a bot's edits (undo). */
  snapshots: SnapshotRepo;
  /** P13: 提前做 queue. */
  early: EarlyWorkRepo;
  /** P13: idempotency keys of a phone's queued sends. */
  clientOps: ClientOpRepo;
  /** P14: built-in add-ons per bot and their daily usage. */
  addons: AddonRepo;
  /** P14: the offer ledger. */
  offers: OfferRepo;
  /** Gap analysis 2026-11: 主動留意's per-candidate log (no content, migration 29). */
  proactiveLog: ProactiveLogRepo;
  /** Care moments: decisions, shown lines, mentions and reactions (no content, migration 32). */
  careLog: CareLogRepo;
  /** Plan §2.9: the dispatch ledger (fence, report once, one end per turn, waits claimed once). */
  dispatches: DispatchRepo;
  /** Phase 5: where the hidden git snapshot refs of coding turns are (cap, expiry, restore). */
  gitSnapshots: GitSnapshotRepo;
  /** `backup` is the file taken before a pending migration ran (P13). */
  migration: MigrateResult & { backup?: string };
  /** Next round §4.6: the one-time switch to auto_vacuum = INCREMENTAL at this start. */
  vacuum: VacuumConversion;
  /** R2.3: the database worker (prune, vacuum, backups, audit check, scrub, export / import, seal pass). */
  jobs: DbWorker;
  /** R7: the column sealer of this start (undefined: no data key, nothing sealed). */
  sealer: Sealer | undefined;
  /** R7.5 step 2: "new" = the key check was written at this start. */
  sealCheck: "new" | "ok" | "none";
  /** Closes the main connection; the worker is told to stop (use `stop()` to wait for it). */
  close(): void;
  /** R2.3 shutdown order: the worker finishes its batch, then the main connection closes. */
  stop(): Promise<void>;
}

export interface StoreOptions {
  /** Run the database jobs on the main thread (tests; `ALCA_DB_WORKER=inline`). */
  inlineJobs?: boolean;
  /** Target batch time of the worker's deletes (settings `engineering.perf.workerBatchMs`). */
  batchMs?: () => number;
  log?: (level: "info" | "warn" | "error", line: string) => void;
  /**
   * R7.4: seal the content columns with this (D1's data key ring). Without
   * it nothing new is sealed; a database that was sealed is refused.
   */
  sealer?: Sealer;
}

/** Open (or create) the single-file Alca state store and bring its schema up to date. */
export function openStore(
  path: string,
  migrations: readonly Migration[] = MIGRATIONS,
  o: StoreOptions = {},
): Store {
  const db = openDatabase({ path });
  // P13: a database with data gets a backup before any pending migration runs.
  let backup: string | undefined;
  let migration: MigrateResult;
  try {
    backup = backupBeforeMigrate(db, path, migrations);
    migration = migrate(db, migrations);
  } catch (err) {
    db.close();
    if (backup && err instanceof Error)
      err.message = `${err.message} (the database before this start was backed up to ${backup}; restore it with \`alca db restore\`)`;
    throw err;
  }
  // Next round §4.6: once, after the migrations (and their backup), before the repos.
  const vacuum = convertAutoVacuum(db, path, fileBytes(path));
  // R7.5 step 2: a wrong data key stops here, before any row is written.
  let sealCheck: "new" | "ok" | "none";
  try {
    sealCheck = checkSealKey(db, o.sealer);
  } catch (err) {
    db.close();
    throw err;
  }
  bindSealer(db, o.sealer);
  const bots = new BotRepo(db);
  // First launch: a team of one default bot.
  if (migrations.includes(botsSchema)) bots.ensureDefault();
  const jobs = new DbWorker({
    path,
    db,
    inline: o.inlineJobs ?? process.env.ALCA_DB_WORKER === "inline",
    ...(o.batchMs ? { batchMs: o.batchMs } : {}),
    ...(o.log ? { log: o.log } : {}),
    ...(o.sealer ? { seal: o.sealer.toWire() } : {}),
  });
  const runs = new RunRepo(db, {
    onFlushError: (err) =>
      o.log?.("warn", `run_events: held stream chunks not written (${String(err).slice(0, 200)})`),
  });
  // R7.7: held stream chunks are written before the connection closes.
  const flushRuns = () => {
    try {
      runs.flush();
    } catch (err) {
      runs.discardPending();
      o.log?.("warn", `run_events: held stream chunks not written at close (${String(err).slice(0, 200)})`);
    }
  };
  return {
    db,
    memory: new MemoryRepo(db),
    skills: new SkillRepo(db),
    threads: new ThreadRepo(db),
    runs,
    human: new HumanInputRepo(db),
    bots,
    workers: new WorkerRepo(db),
    triggers: new TriggerRepo(db),
    devices: new DeviceRepo(db),
    connectors: new ConnectorRepo(db),
    routines: new RoutineRepo(db),
    team: new TeamRepo(db),
    push: new PushRepo(db),
    snapshots: new SnapshotRepo(db),
    early: new EarlyWorkRepo(db),
    clientOps: new ClientOpRepo(db),
    addons: new AddonRepo(db),
    offers: new OfferRepo(db),
    proactiveLog: new ProactiveLogRepo(db),
    careLog: new CareLogRepo(db),
    dispatches: new DispatchRepo(db),
    gitSnapshots: new GitSnapshotRepo(db),
    migration: { ...migration, ...(backup ? { backup } : {}) },
    vacuum,
    jobs,
    sealer: o.sealer,
    sealCheck,
    close: () => {
      flushRuns();
      void jobs.close();
      db.close();
    },
    stop: async () => {
      flushRuns();
      await jobs.close();
      db.close();
    },
  };
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
