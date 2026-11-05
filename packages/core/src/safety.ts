import { isIPv4, isIPv6 } from "node:net";
import type { Settings } from "@alca/config";

/** Where the core reads secrets from (OS keychain, env, vault…). Never logs values. */
export interface SecretSource {
  get(name: string): string | undefined;
}

export type StartupProblemCode = "non_loopback_bind" | "missing_secret" | "weak_secret";

export interface StartupProblem {
  code: StartupProblemCode;
  detail: string;
}

export class StartupRefusedError extends Error {
  readonly problems: StartupProblem[];
  constructor(problems: StartupProblem[]) {
    super(`refusing to start: ${problems.map((p) => `${p.code} (${p.detail})`).join(", ")}`);
    this.name = "StartupRefusedError";
    this.problems = problems;
  }
}

/** Minimum length for generated local secrets (32 bytes hex = 64 chars; we accept >= 32). */
export const MIN_SECRET_LENGTH = 32;

/**
 * True only for addresses that cannot be reached from another machine.
 * Hostnames other than the literal "localhost" are rejected: DNS could
 * resolve them anywhere.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost") return true;
  if (isIPv4(h)) return h.split(".")[0] === "127";
  if (isIPv6(h)) {
    if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    return mapped?.[1] !== undefined && isLoopbackHost(mapped[1]);
  }
  return false;
}

/** Secrets the core cannot run without, derived from settings. */
export function requiredSecrets(settings: Settings): string[] {
  const out = ["core.localToken"];
  if (settings.devices.allowPairing) out.push("link.identityKey");
  for (const e of settings.models.engines) {
    if (e.enabled && e.kind === "api") out.push(`engine.${e.id}.apiKey`);
  }
  return out;
}

/** Secrets the core generates itself and therefore must be strong. */
const GENERATED = new Set(["core.localToken", "link.identityKey"]);

export function checkStartupSafety(settings: Settings, secrets: SecretSource): StartupProblem[] {
  const problems: StartupProblem[] = [];
  const host = settings.engineering.bindHost;
  if (!isLoopbackHost(host)) {
    problems.push({
      code: "non_loopback_bind",
      detail: `bindHost "${host}" is reachable from the network; the core only binds loopback — phones connect through the link sidecar`,
    });
  }
  for (const name of requiredSecrets(settings)) {
    const value = secrets.get(name);
    if (value === undefined || value.trim() === "") {
      problems.push({ code: "missing_secret", detail: name });
    } else if (GENERATED.has(name) && value.length < MIN_SECRET_LENGTH) {
      problems.push({ code: "weak_secret", detail: `${name} shorter than ${MIN_SECRET_LENGTH} chars` });
    }
  }
  return problems;
}

/** Throw StartupRefusedError unless the configuration is safe to start. */
export function assertSafeStartup(settings: Settings, secrets: SecretSource): void {
  const problems = checkStartupSafety(settings, secrets);
  if (problems.length > 0) throw new StartupRefusedError(problems);
}

export function secretsFromMap(map: Readonly<Record<string, string>>): SecretSource {
  return { get: (name) => map[name] };
}
