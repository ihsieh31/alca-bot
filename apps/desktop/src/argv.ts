/**
 * The arguments after the script, without one leading `--`.
 *
 * `pnpm desktop:demo -- --data-dir x` passes the `--` through to node on pnpm 12
 * (mac test 2026-11-04b C3), and parseArgs then reads every flag after it as a
 * positional and refuses them. A `--` anywhere else is left alone.
 */
export function scriptArgs(argv: readonly string[] = process.argv.slice(2)): string[] {
  return argv[0] === "--" ? argv.slice(1) : [...argv];
}
