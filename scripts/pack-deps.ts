// Copy external runtime dependencies, with everything they depend on, out of
// this checkout's installed tree (pnpm's .pnpm store or a flat node_modules)
// into a packed tree's node_modules, laid out so plain Node resolution finds
// each one: one hoisted copy per package at <out>/node_modules/<name>, and a
// copy nested under the package that needs it when another version already
// holds the hoisted slot. `dependencies` are required (missing = error);
// `optionalDependencies` are packed when installed and skipped when not.
// Peer dependencies are the host's to provide and are not followed.
import { cpSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

type Pkg = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
const readPkg = (dir: string): Pkg => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Pkg;

/** Where Node would find `name` from a package at `from` (its real path): its own, then each ancestor's node_modules. */
export function findPackage(from: string, name: string): string | undefined {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export class DepPacker {
  /** Packed path → the real source it was copied from. */
  readonly placed = new Map<string, string>();
  readonly out: string;
  constructor(outRoot: string) {
    this.out = outRoot;
  }

  /**
   * Pack `name` as needed by the package whose source is at `from` and whose
   * packed copy is at `requester` (a nested copy goes under its node_modules).
   * Returns the packed path, or undefined for a missing optional dependency.
   */
  place(name: string, from: string, requester: string, optional = false): string | undefined {
    const src = findPackage(from, name);
    if (!src) {
      if (optional) return undefined;
      throw new Error(`${name} (needed by ${basename(from)}) is not installed; run pnpm install`);
    }
    const top = join(this.out, "node_modules", name);
    for (const slot of [top, join(requester, "node_modules", name)]) {
      const there = this.placed.get(slot);
      if (there === src) return slot; // already packed here (also ends dependency cycles)
      if (there !== undefined) continue; // another version holds this slot
      this.placed.set(slot, src);
      cpSync(src, slot, {
        recursive: true,
        dereference: true,
        // pnpm keeps a package's dependencies beside it, not inside; skip any nested store anyway.
        filter: (p) => !p.slice(src.length).split(sep).includes("node_modules"),
      });
      const pkg = readPkg(src);
      for (const dep of Object.keys(pkg.dependencies ?? {})) this.place(dep, src, slot);
      for (const dep of Object.keys(pkg.optionalDependencies ?? {})) this.place(dep, src, slot, true);
      return slot;
    }
    throw new Error(`${name}: two versions conflict at ${top} and under ${requester}`);
  }

  /** Every packed package, name@version, sorted. */
  list(): string[] {
    return [...this.placed.keys()]
      .map((p) => {
        const pkg = readPkg(p);
        return `${pkg.name}@${pkg.version}`;
      })
      .sort();
  }
}
