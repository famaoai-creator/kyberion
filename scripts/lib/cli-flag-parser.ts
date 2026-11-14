/**
 * scripts/lib/cli-flag-parser.ts
 *
 * Table-driven argv flag parsing shared by CLI scripts. Each command declares
 * a spec list — adding a flag is one table entry, not another else-if branch.
 */

export interface FlagSpec<T> {
  /** Accepted spellings, e.g. ['--slug', '--tenant']. */
  flags: readonly string[];
  /**
   * - 'next': consume the following argv entry unconditionally, even when it
   *   is absent or itself a flag (org.ts/tenant.ts/nhi.ts `args[++i]` style).
   * - 'required': consume it, but throw `<flag> requires a value` when it is
   *   absent or starts with `--` (ingest.ts takeValue style).
   * - omitted: boolean flag; consumes nothing.
   */
  takesValue?: 'next' | 'required';
  apply: (opts: T, value: string | undefined) => void;
}

export interface FlagParseHooks<T> {
  /** Bare (non-`--`) argument; defaults to ignore. */
  onBare?: (opts: T, arg: string) => void;
  /** Unmatched `--flag`; defaults to ignore. */
  onUnknown?: (opts: T, arg: string) => void;
}

export function parseCliFlags<T>(
  argv: readonly string[],
  opts: T,
  specs: readonly FlagSpec<T>[],
  hooks: FlagParseHooks<T> = {}
): T {
  const byFlag = new Map<string, FlagSpec<T>>();
  for (const spec of specs) for (const flag of spec.flags) byFlag.set(flag, spec);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const spec = byFlag.get(arg);
    if (spec) {
      let value: string | undefined;
      if (spec.takesValue === 'next') {
        value = argv[++i];
      } else if (spec.takesValue === 'required') {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new Error(`${arg} requires a value`);
        }
        value = next;
        i += 1;
      }
      spec.apply(opts, value);
      continue;
    }
    if (arg.startsWith('--')) {
      hooks.onUnknown?.(opts, arg);
      continue;
    }
    hooks.onBare?.(opts, arg);
  }
  return opts;
}
