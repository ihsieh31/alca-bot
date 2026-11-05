import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Settings } from "@alca/config";
import type { EditedTurn, FileSnapshot, Store } from "@alca/store";
import { expandHomeWord } from "./shell-targets.ts";

/**
 * Undo for files bots edit (P13). Just before an edit that the gate let
 * through runs, the journal keeps the file as it is (or the fact that it does
 * not exist). Edits are grouped by the person's turn — the router run that
 * dispatched the worker — so one 復原 puts back everything that turn's
 * workers changed. Covered: Claude Code's Write / Edit / MultiEdit /
 * NotebookEdit, ACP agents' edit / delete / move tool calls (paths from the
 * call's input and `locations`), and Alca's own file tools. Files a shell
 * command changes are found afterwards by comparing the bot's work folder
 * with a copy read just before the command (`keep`, shell-snapshot.ts);
 * changes outside the work folder cannot be undone.
 *
 * Undo is newest-first per file: a turn whose file a later, not undone turn
 * also edited is refused until that later turn is undone. A file over
 * `maxFileBytes` is noted but not kept, so its edit cannot be undone.
 */

export type UndoPolicy = Settings["engineering"]["undo"];

/** Claude Code's built-in tools that change files, and the input key naming the file. */
const CLI_EDIT_TOOLS: Readonly<Record<string, string>> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** Alca's own file tools that change files (path relative to the work folder). */
export const OWN_EDIT_TOOLS = new Set(["file_write", "file_edit", "write", "edit"]);

const ACP_EDIT_KINDS = new Set(["edit", "delete", "move"]);
const PATH_KEYS = ["path", "file_path", "filePath", "abs_path", "absPath", "target", "destination", "source"];

/** The files a call will change, resolved against the bot's work folder; [] = not a file edit. */
export function editTargets(
  tool: string,
  args: Record<string, unknown>,
  workDir: string | undefined,
): string[] {
  const out = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== "string" || !raw || raw.includes("\0")) return;
    // A9: `~/x` is the home folder, as the file tools (confine) read it — not `<work>/~/x`.
    const p = expandHomeWord(raw);
    if (isAbsolute(p)) out.add(resolve(p));
    else if (workDir) out.add(resolve(workDir, p));
  };
  const cliKey = CLI_EDIT_TOOLS[tool];
  if (cliKey) add(args[cliKey]);
  else if (OWN_EDIT_TOOLS.has(tool)) add(args.path);
  else if (tool === "apply_patch" && typeof args.patch === "string")
    // Plan §4: every file an apply_patch adds, updates, deletes or moves to.
    for (const m of args.patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm))
      add((m[1] ?? m[2] ?? "").trim());
  else if (typeof args.kind === "string" && ACP_EDIT_KINDS.has(args.kind)) {
    if (Array.isArray(args.paths)) for (const p of args.paths) add(p);
    for (const k of PATH_KEYS) add(args[k]);
  }
  return [...out].slice(0, 20);
}

export interface JournalCall {
  botId: string;
  threadId: string;
  runId: string;
  workerId?: string;
  tool: string;
  paths: readonly string[];
}

/** A file's state from before a call, known without reading it now (`keep`). */
export interface KnownPrior {
  path: string;
  existed: boolean;
  content?: Uint8Array;
  mode?: number;
  size?: number;
  /** Why its content was not kept (it is listed, but cannot be put back). */
  skipped?: string;
}

export type UndoResult =
  | { ok: true; restored: string[]; removed: string[]; skipped: string[] }
  | { ok: false; reason: string; paths?: string[] };

export class EditJournal {
  private readonly store: Store;
  private readonly policy: () => UndoPolicy;
  private readonly now: () => Date;

  constructor(o: { store: Store; policy: () => UndoPolicy; now?: () => Date }) {
    this.store = o.store;
    this.policy = o.policy;
    this.now = o.now ?? (() => new Date());
  }

  /** The person's turn a run belongs to: its parent run (a worker's dispatching router run), or itself. */
  turnOf(runId: string): string {
    try {
      return this.store.runs.get(runId)?.parentRunId ?? runId;
    } catch {
      return runId;
    }
  }

  /** Keep each file as it is right now (once per turn and file: the first state is what undo restores). */
  snapshot(c: JournalCall): FileSnapshot[] {
    const turn = this.turnOf(c.runId);
    const p = this.policy();
    const out: FileSnapshot[] = [];
    for (const path of c.paths) {
      if (this.store.snapshots.has(turn, path)) continue;
      const base = {
        botId: c.botId,
        threadId: c.threadId,
        runId: c.runId,
        turnRunId: turn,
        ...(c.workerId ? { workerId: c.workerId } : {}),
        tool: c.tool,
        path,
        now: this.now(),
      };
      let st: ReturnType<typeof lstatSync> | undefined;
      try {
        st = lstatSync(path);
      } catch {
        st = undefined;
      }
      if (!st) {
        out.push(this.store.snapshots.add({ ...base, existed: false }));
        continue;
      }
      if (!st.isFile()) {
        out.push(this.store.snapshots.add({ ...base, existed: true, skipped: "不是一般檔案" }));
        continue;
      }
      if (st.size > p.maxFileBytes) {
        out.push(
          this.store.snapshots.add({ ...base, existed: true, size: st.size, skipped: "檔案太大，沒有保留" }),
        );
        continue;
      }
      try {
        const content = readFileSync(path);
        out.push(
          this.store.snapshots.add({
            ...base,
            existed: true,
            content: new Uint8Array(content),
            mode: st.mode & 0o777,
            size: content.byteLength,
          }),
        );
      } catch {
        out.push(this.store.snapshots.add({ ...base, existed: true, skipped: "讀不到檔案" }));
      }
    }
    if (out.length) this.store.snapshots.prune({ threadId: c.threadId, ...this.limits() });
    return out;
  }

  /**
   * Journal changes found after a call ran (a shell command): each file's
   * state from just before it. Once per turn and file, like `snapshot`.
   */
  keep(c: Omit<JournalCall, "paths">, items: readonly KnownPrior[]): FileSnapshot[] {
    const turn = this.turnOf(c.runId);
    const out: FileSnapshot[] = [];
    for (const it of items.slice(0, 500)) {
      if (this.store.snapshots.has(turn, it.path)) continue;
      const base = {
        botId: c.botId,
        threadId: c.threadId,
        runId: c.runId,
        turnRunId: turn,
        ...(c.workerId ? { workerId: c.workerId } : {}),
        tool: c.tool,
        path: it.path,
        now: this.now(),
      };
      if (!it.existed) out.push(this.store.snapshots.add({ ...base, existed: false }));
      else if (it.skipped || !it.content)
        out.push(
          this.store.snapshots.add({
            ...base,
            existed: true,
            ...(it.size !== undefined ? { size: it.size } : {}),
            skipped: it.skipped ?? "沒有保留這個檔案",
          }),
        );
      else
        out.push(
          this.store.snapshots.add({
            ...base,
            existed: true,
            content: it.content,
            mode: it.mode ?? 0o644,
            size: it.content.byteLength,
          }),
        );
    }
    if (out.length) this.store.snapshots.prune({ threadId: c.threadId, ...this.limits() });
    return out;
  }

  private limits() {
    const p = this.policy();
    return { keepTurns: p.keepTurns, maxBytes: p.maxTotalBytes, now: this.now() };
  }

  turns(threadId: string): EditedTurn[] {
    return this.store.snapshots.turns(threadId);
  }

  /** The files a turn changed (one line per file, the first snapshot of each). */
  files(turnRunId: string): FileSnapshot[] {
    const seen = new Set<string>();
    return this.store.snapshots.ofTurn(turnRunId).filter((s) => !seen.has(s.path) && !!seen.add(s.path));
  }

  /** Put every file a turn changed back the way it was before the turn. */
  undo(threadId: string, turnRunId: string): UndoResult {
    const snaps = this.files(turnRunId);
    if (!snaps.length || snaps.some((s) => s.threadId !== threadId))
      return { ok: false, reason: "這一輪沒有可以復原的檔案修改" };
    if (snaps.some((s) => s.undoneAt)) return { ok: false, reason: "這一輪已經復原過了" };
    if (snaps.some((s) => s.prunedAt)) return { ok: false, reason: "這一輪的備份已經超過保留上限，不能復原" };
    if (this.stillRunning(turnRunId))
      return { ok: false, reason: "這一輪的工作還在進行，請等它結束或先停止" };
    const later = snaps
      .map((s) => this.store.snapshots.laterEdit(s.path, turnRunId, s.createdAt))
      .filter((s): s is FileSnapshot => !!s);
    if (later.length)
      return {
        ok: false,
        reason: "之後的對話又改過這些檔案；請先復原較新的那一輪",
        paths: [...new Set(later.map((s) => s.path))],
      };
    const restored: string[] = [];
    const removed: string[] = [];
    const skipped: string[] = [];
    for (const s of snaps) {
      if (s.skipped) {
        skipped.push(s.path);
        continue;
      }
      try {
        if (!s.existed) {
          const st = lstatSync(s.path, { throwIfNoEntry: false });
          if (st?.isFile() || st?.isSymbolicLink()) rmSync(s.path, { force: true });
          removed.push(s.path);
        } else {
          mkdirSync(dirname(s.path), { recursive: true });
          writeFileSync(s.path, s.content ?? new Uint8Array());
          if (s.mode !== null) chmodSync(s.path, s.mode);
          restored.push(s.path);
        }
      } catch {
        skipped.push(s.path);
      }
    }
    this.store.snapshots.markUndone(turnRunId, this.now());
    return { ok: true, restored, removed, skipped };
  }

  private stillRunning(turnRunId: string): boolean {
    return this.store.runs.open().some((r) => r.id === turnRunId || r.parentRunId === turnRunId);
  }
}
