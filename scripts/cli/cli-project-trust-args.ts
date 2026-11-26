/**
 * `pnpm kyberion project-trust request <pipeline-path> [--json]
 * [--allow-unattended] [--runs-per-day <N>]` arguments. Pure so the flag rules
 * are unit-testable; the library re-validates the cap
 * (requestedRunsPerDay) before anything reaches an approval card.
 */
export const PROJECT_TRUST_REQUEST_USAGE =
  'Usage: pnpm kyberion project-trust request <pipeline-path> [--json] [--allow-unattended] [--runs-per-day <N>]';

export interface ParsedProjectTrustRequest {
  inputPath: string;
  json: boolean;
  allowUnattended: boolean;
  /** Omitted: the library default (DEFAULT_RUN_MANIFEST_RUNS_PER_DAY). */
  runsPerDay?: number;
}

export function parseProjectTrustRequestArgs(
  firstArg: string | undefined,
  restArgs: string[]
): ParsedProjectTrustRequest {
  if (firstArg !== 'request' || !restArgs[0] || restArgs[0].startsWith('--'))
    throw new Error(PROJECT_TRUST_REQUEST_USAGE);
  const [inputPath, ...flags] = restArgs;
  let runsPerDay: number | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const inline = flag.startsWith('--runs-per-day=') ? flag.slice('--runs-per-day='.length) : null;
    if (flag === '--json' || flag === '--allow-unattended') continue;
    // A misspelled flag (e.g. --runs-per-days) must not silently fall back to a default.
    if (flag !== '--runs-per-day' && inline === null)
      throw new Error(
        `unknown argument '${flag}' for project-trust request | next: ${PROJECT_TRUST_REQUEST_USAGE}`
      );
    const value = inline ?? flags[(index += 1)];
    if (value === undefined || !/^\d+$/u.test(value))
      throw new Error(
        `--runs-per-day needs a whole number of runs (received: ${value ?? '<none>'}) | next: ${PROJECT_TRUST_REQUEST_USAGE}`
      );
    runsPerDay = Number(value);
  }
  return {
    inputPath,
    json: flags.includes('--json'),
    allowUnattended: flags.includes('--allow-unattended'),
    ...(runsPerDay !== undefined ? { runsPerDay } : {}),
  };
}
