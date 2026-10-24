/**
 * The only door from the customer room to Kyberion: the built governed
 * facade (`dist/scripts/customer_decision.js`) run as a child process for
 * `view` / `respond`. The request goes in on STDIN (the token is never an
 * argument); the tenant comes from this process's own configuration.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResultAsync } from '@agent/core/secure-io';

export type FacadeVerb = 'view' | 'respond';

export interface FacadeOutcome {
  /** Child exit status; null when it could not run. */
  status: number | null;
  stdout: string;
  /** The child was killed for time or output size. */
  aborted: boolean;
}

export type FacadeSpawner = (
  verb: FacadeVerb,
  input: Record<string, unknown>
) => Promise<FacadeOutcome>;

export const FACADE_SCRIPT = 'dist/scripts/customer_decision.js';
export const FACADE_TIMEOUT_MS = 15_000;
export const FACADE_MAX_OUTPUT_MB = 1;

export interface FacadeSpawnerOptions {
  tenant: string;
  timeoutMs?: number;
  maxOutputMB?: number;
  /** Test seam: where the facade script is resolved from. */
  scriptPath?: string;
  /** Extra facade arguments (test-only: `--dir <scratch>`). */
  extraArgs?: string[];
}

export function createFacadeSpawner(options: FacadeSpawnerOptions): FacadeSpawner {
  const timeoutMs = options.timeoutMs ?? FACADE_TIMEOUT_MS;
  const maxOutputMB = options.maxOutputMB ?? FACADE_MAX_OUTPUT_MB;
  const script = options.scriptPath ?? pathResolver.rootResolve(FACADE_SCRIPT);
  return async (verb, input) => {
    const result = await safeExecResultAsync(
      process.execPath,
      [script, verb, '--tenant', options.tenant, '--json', ...(options.extraArgs ?? [])],
      {
        cwd: pathResolver.rootDir(),
        env: { ...process.env, KYBERION_TENANT: options.tenant },
        timeoutMs,
        maxOutputMB,
        input: JSON.stringify(input),
      }
    );
    const aborted = /timed out|exceeded/u.test(result.error?.message ?? '');
    return { status: result.status, stdout: result.stdout, aborted };
  };
}
