import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Which shell runs a command (research audit A4): `/bin/sh -c` reports the
 * exit code of the last command of a pipeline only, so `false | true` would
 * read as a success. With bash on the machine every command runs under
 * `bash -o pipefail -c`; when only sh is there, a command with a pipe gets a
 * note that its exit code may hide a failure earlier in the pipe.
 */

const BASH_CANDIDATES = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"];

function findBash(): string | undefined {
  if (process.platform === "win32") return undefined;
  for (const p of BASH_CANDIDATES) if (existsSync(p)) return p;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, "bash");
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Test hook: the bash found on this machine (`null` = only sh). */
export const shellChoice: { bash: string | null | undefined } = { bash: undefined };

function bashPath(): string | null {
  if (shellChoice.bash === undefined) shellChoice.bash = findBash() ?? null;
  return shellChoice.bash;
}

export interface ShellSpawn {
  file: string;
  args: string[];
  /** Whether a failure inside a pipeline fails the command. */
  pipefail: boolean;
}

/**
 * `strict` (the host's end-of-task check): under sh, also try to turn pipefail
 * on where that sh knows it (a subshell probes it first, since an unknown
 * `set -o` would end a non-interactive sh). Whether it took is unknown, so the
 * pipe note still applies.
 */
export function shellFor(command: string, strict = false): ShellSpawn {
  const bash = bashPath();
  if (bash) return { file: bash, args: ["-o", "pipefail", "-c", command], pipefail: true };
  const body = strict ? `(set -o pipefail) 2>/dev/null && set -o pipefail\n${command}` : command;
  return { file: "/bin/sh", args: ["-c", body], pipefail: false };
}

/** A single `|` outside quotes (not `||`): the command pipes one program into another. */
export function hasPipe(command: string): boolean {
  let q: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === "|") {
      if (command[i + 1] === "|") i++;
      else if (command[i - 1] !== ">") return true; // `>|` is a redirection
    }
  }
  return false;
}

export const PIPE_NOTE =
  "（注意：這台機器沒有 bash，命令以 sh 執行且無法開 pipefail；含 | 的命令，exit code 只反映最後一段，前面的失敗可能被 pipe 吞掉。需要確認時請拆開執行或檢查輸出。）";

/** The note to add to a result, if any. */
export function pipeNote(sh: ShellSpawn, command: string): string | undefined {
  return !sh.pipefail && hasPipe(command) ? PIPE_NOTE : undefined;
}
