/**
 * The only door from the customer room to Kyberion: the built governed
 * facade (`dist/scripts/customer_decision.js`) run as a child process for
 * `view` / `respond` / `attachment`. The request goes in on STDIN (the token is never an
 * argument); the tenant comes from this process's own configuration.
 *
 * The child gets a minimal, explicit env ({@link facadeChildEnv}): the
 * secure-io exec allowlist (PATH, HOME, locale, TMPDIR, NODE_ENV and the
 * Vitest run markers that keep a test child on its parent's sandbox) with the
 * ambient role / persona / sudo / mission keys blanked, plus the tenant
 * binding and, when set, KYBERION_ROOT. Nothing else of this
 * process's env reaches it — in particular not SYSTEM_ROLE: under
 * `pnpm surfaces` this process runs as SYSTEM_ROLE=customer_room, and the
 * facade is a separate governed program that assumes its own narrow roles
 * (decision_ledger, customer_decision_invite_store,
 * customer_decision_deal_note_writer), exactly as when an operator runs it.
 * That is the secure-io exec helpers' default (they drop SYSTEM_ROLE unless
 * the caller passes it back in), so no role assumption policy is needed for
 * customer_room.
 */
import { getRegisteredEnvText } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResultAsync } from '@agent/core/secure-io';

export type FacadeVerb = 'view' | 'respond' | 'attachment';

export interface FacadeOutcome {
  /** Child exit status; null when it could not run. */
  status: number | null;
  stdout: string;
  /** The child was killed for time or output size. */
  aborted: boolean;
}

/**
 * Allowlisted keys (secure-io SAFE_EXEC_ENV_ALLOWLIST) a customer-triggered
 * child must not inherit from whoever started the room: an ambient role,
 * persona, sudo or mission, and model tokens the facade never uses. Blank
 * means unset to the env registry (getRegisteredEnvText).
 */
export const FACADE_CHILD_CLEARED_ENV = [
  'MISSION_ROLE',
  'MISSION_ID',
  'KYBERION_PERSONA',
  'KYBERION_SUDO',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
] as const;

/**
 * The env the facade child gets on top of the secure-io exec allowlist: the
 * tenant binding (pathResolver and the tenant-bound roles read
 * KYBERION_TENANT), the repository root override when one is set, and the
 * cleared keys above. Callers must not pass `process.env` here — that would
 * re-add every variable.
 */
export function facadeChildEnv(tenant: string): Record<string, string> {
  const root = getRegisteredEnvText('KYBERION_ROOT');
  return {
    ...Object.fromEntries(FACADE_CHILD_CLEARED_ENV.map((key) => [key, ''])),
    // Explicitly not this process's SYSTEM_ROLE (secure-io drops it anyway;
    // stated here so the role-assumption analysis sees the child does not inherit it).
    SYSTEM_ROLE: '',
    KYBERION_TENANT: tenant,
    ...(root ? { KYBERION_ROOT: root } : {}),
  };
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
        env: facadeChildEnv(options.tenant),
        timeoutMs,
        maxOutputMB,
        input: JSON.stringify(input),
      }
    );
    const aborted = /timed out|exceeded/u.test(result.error?.message ?? '');
    return { status: result.status, stdout: result.stdout, aborted };
  };
}
