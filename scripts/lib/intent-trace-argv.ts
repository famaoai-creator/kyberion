/**
 * `pnpm intent:trace <id>` already names the `trace` verb in the script name,
 * so the subcommand is implicit there (no `intent:trace trace <id>` stutter).
 * An explicit leading `trace` keeps working. Outside the `intent:trace`
 * package script (tests, direct `tsx` runs) argv is passed through unchanged.
 */
export const INTENT_TRACE_SCRIPT = 'intent:trace';

export function withImplicitTraceSubcommand(
  argv: readonly string[],
  lifecycleEvent: string | undefined
): string[] {
  if (lifecycleEvent !== INTENT_TRACE_SCRIPT) return [...argv];
  const firstPositional = argv.find((arg) => !arg.startsWith('-'));
  if (firstPositional === undefined || firstPositional === 'trace') return [...argv];
  return ['trace', ...argv];
}
