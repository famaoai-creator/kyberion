/**
 * CU-01: shared `--help` / unknown-flag guard for side-effecting CLI scripts.
 *
 * A script calls `guardCliArgs()` as its first statement — before any git,
 * gh, network, or file mutation. `--help` / `-h` anywhere in argv prints the
 * usage and returns `true` (the caller returns immediately, exit 0); an
 * unknown flag or an unexpected positional throws a `ScriptExitError(2)`
 * with a usage hint. The one-line summary comes from the governed CLI
 * registry (`cli-commands.json` → `description` vocabulary key), so `pnpm
 * <script> --help` and `kyberion --help` never drift apart.
 */
import { t, type VocabularyKey } from '@agent/core/t';
import { ScriptExitError } from './harness.js';
import { loadCliManifest } from '../check_cli_manifest.js';

export interface CliOptionSpec {
  /** Long flag including dashes, e.g. `--title`. */
  flag: string;
  /** The flag consumes the next argv token (or `--flag=value`). */
  value?: string;
}

export interface CliGuardSpec {
  /** How the operator invokes it, e.g. `pnpm kyberion pr create`. */
  command: string;
  /** Registry id (`cli-commands.json`) whose description/caution keys are shown. */
  manifestId?: string;
  options: readonly CliOptionSpec[];
  /** Positional placeholder shown in usage (e.g. `<slug>`); omit to reject positionals. */
  positional?: string;
  /** Leading positional subcommands that bypass the guard (their own parser owns them). */
  subcommands?: readonly string[];
}

const HELP_FLAGS = new Set(['--help', '-h']);

export function hasHelpFlag(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === '--') return false;
    if (HELP_FLAGS.has(arg)) return true;
  }
  return false;
}

function registryKeys(manifestId?: string): { description?: string; caution?: string } {
  if (!manifestId) return {};
  const manifest = loadCliManifest();
  const entry = [...manifest.commands, ...(manifest.script_commands ?? [])].find(
    (candidate) => candidate.id === manifestId
  );
  return { description: entry?.description, caution: entry?.caution };
}

export function formatCliUsage(spec: CliGuardSpec): string {
  const keys = registryKeys(spec.manifestId);
  const usageTail = [
    spec.subcommands && spec.subcommands.length > 0 ? `[${spec.subcommands.join('|')}]` : '',
    spec.positional ?? '',
    spec.options.length > 0 ? '[options]' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const lines = [t('cli:cli_guard_usage', { usage: `${spec.command} ${usageTail}`.trim() })];
  if (keys.description) lines.push('', `  ${t(keys.description as VocabularyKey)}`);
  if (keys.caution) lines.push(`  ${t(keys.caution as VocabularyKey)}`);
  if (spec.options.length > 0) {
    lines.push('', t('cli:cli_guard_options'));
    for (const option of [...spec.options, { flag: '--help' }]) {
      lines.push(`  ${option.flag}${option.value ? ` ${option.value}` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * Rewrite `--flag=value` to the two-token `--flag value` form for flags that
 * declare a value. The guard accepts both spellings, but legacy hand-rolled
 * parsers only read the two-token form; callers pass the normalized argv on.
 * Tokens after a literal `--` are left untouched.
 */
export function normalizeInlineValueFlags(
  argv: readonly string[],
  spec: Pick<CliGuardSpec, 'options'>
): string[] {
  const valued = new Set(spec.options.filter((option) => option.value).map((o) => o.flag));
  const out: string[] = [];
  let passthrough = false;
  for (const arg of argv) {
    if (passthrough) {
      out.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      out.push(arg);
      continue;
    }
    const match = /^(--[^=]+)=(.*)$/su.exec(arg);
    if (match && valued.has(match[1] as string)) out.push(match[1] as string, match[2] as string);
    else out.push(arg);
  }
  return out;
}

/**
 * Like `guardCliArgs`, but also returns the argv with `--flag=value`
 * normalized to `--flag value`. Use the returned `argv` for legacy parsers.
 */
export function guardCliArgsNormalized(
  argv: readonly string[],
  spec: CliGuardSpec,
  print: (value: unknown) => void
): { handled: boolean; argv: string[] } {
  const handled = guardCliArgs(argv, spec, print);
  return { handled, argv: normalizeInlineValueFlags(argv, spec) };
}

/**
 * Validate argv against the declared flags before any side effect.
 * Returns `true` when help was printed and the caller must return.
 */
export function guardCliArgs(
  argv: readonly string[],
  spec: CliGuardSpec,
  print: (value: unknown) => void
): boolean {
  if (hasHelpFlag(argv)) {
    print(formatCliUsage(spec));
    return true;
  }
  if (spec.subcommands?.includes(argv[0] ?? '')) return false;
  const known = new Map(spec.options.map((option) => [option.flag, option]));
  const reject = (key: VocabularyKey, params: Record<string, string>): never => {
    throw new ScriptExitError(2, t(key, { ...params, command: spec.command }));
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--') continue;
    if (arg.startsWith('-') && arg.length > 1) {
      const [flag, inlineValue] = arg.split(/=(.*)/su, 2) as [string, string | undefined];
      const option = known.get(flag);
      if (!option) reject('cli:cli_guard_unknown_option', { flag });
      if (option?.value && inlineValue === undefined) {
        const next = argv[index + 1];
        if (next === undefined || (next.startsWith('-') && next.length > 1)) {
          reject('cli:cli_guard_missing_value', { flag });
        }
        index += 1;
      }
      continue;
    }
    if (!spec.positional) reject('cli:cli_guard_unexpected_argument', { arg });
  }
  return false;
}
