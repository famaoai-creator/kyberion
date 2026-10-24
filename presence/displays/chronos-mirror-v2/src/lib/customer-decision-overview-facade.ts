/**
 * CD-12: how Chronos reads a tenant's customer-decision overview without
 * gaining any reach into `knowledge/confidential/<tenant>/decisions/`.
 *
 * Chronos never reads the case stores itself. It runs the built governed
 * facade (`dist/scripts/customer_decision.js overview --tenant <t> --summary --json`)
 * as a child process, bound to the resolved viewer tenant, exactly as the
 * customer room does (presence/displays/customer-room/src/server/facade.ts):
 * a minimal env on top of the secure-io exec allowlist with the ambient role,
 * persona, sudo and mission keys blanked and KYBERION_TENANT set to the one
 * tenant the viewer resolved to. The facade assumes its own narrow
 * tenant-bound roles and refuses a `--tenant` other than the bound one, so a
 * child for tenant A can never print tenant B. No role assumption is added
 * for chronos_mirror_v2.
 *
 * Responses are bounded: a timeout and an output cap on the child, a short
 * per-tenant cache plus in-flight sharing so polling cards do not fork one
 * child per request, and errors mapped to fixed messages (no stderr, paths
 * or stack traces reach the browser).
 */
import { logger } from '@agent/core/core';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResultAsync, safeExistsSync } from '@agent/core/secure-io';
import { parseJsonValue } from './json-record';
import {
  parseCustomerDecisionOverview,
  type CustomerDecisionOverviewView,
} from './customer-decision-overview-response';

export const OVERVIEW_FACADE_SCRIPT = 'dist/scripts/customer_decision.js';
export const OVERVIEW_FACADE_TIMEOUT_MS = 15_000;
export const OVERVIEW_FACADE_MAX_OUTPUT_MB = 2;
export const OVERVIEW_CACHE_TTL_MS = 15_000;
const OVERVIEW_CACHE_LIMIT = 64;

/**
 * Allowlisted keys (secure-io SAFE_EXEC_ENV_ALLOWLIST) the child must not
 * inherit from the Chronos process; blank means unset to the env registry.
 */
export const OVERVIEW_CHILD_CLEARED_ENV = [
  'MISSION_ROLE',
  'MISSION_ID',
  'KYBERION_PERSONA',
  'KYBERION_SUDO',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
] as const;

/**
 * The env the facade child gets on top of the secure-io exec allowlist. Never
 * pass `process.env` here — that would re-add every variable.
 */
export function overviewChildEnv(tenant: string): Record<string, string> {
  const root = getRegisteredEnvText('KYBERION_ROOT');
  return {
    ...Object.fromEntries(OVERVIEW_CHILD_CLEARED_ENV.map((key) => [key, ''])),
    // Not Chronos's SYSTEM_ROLE (chronos_mirror_v2): secure-io drops it anyway;
    // stated so the role-assumption analysis sees the child does not inherit it.
    SYSTEM_ROLE: '',
    KYBERION_TENANT: tenant,
    ...(root ? { KYBERION_ROOT: root } : {}),
  };
}

export interface OverviewChildOutcome {
  /** Child exit status; null when it could not run. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Killed for time or output size. */
  aborted: boolean;
}

export type OverviewChildRunner = (tenant: string) => Promise<OverviewChildOutcome>;

export const runOverviewChild: OverviewChildRunner = async (tenant) => {
  const result = await safeExecResultAsync(
    process.execPath,
    [
      pathResolver.rootResolve(OVERVIEW_FACADE_SCRIPT),
      'overview',
      '--tenant',
      tenant,
      // Summary form: no entry rows and a capped attention list (with
      // totals.attention_total), so a large tenant stays within the output cap.
      '--summary',
      '--json',
    ],
    {
      cwd: pathResolver.rootDir(),
      env: overviewChildEnv(tenant),
      timeoutMs: OVERVIEW_FACADE_TIMEOUT_MS,
      maxOutputMB: OVERVIEW_FACADE_MAX_OUTPUT_MB,
    }
  );
  // safeExecResultAsync kills the child with SIGTERM on timeout or output overflow.
  const aborted =
    /timed out|exceeded/u.test(result.error?.message ?? '') ||
    (result.status === null && !result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, aborted };
};

export type OverviewResult =
  | { ok: true; overview: CustomerDecisionOverviewView }
  | { ok: false; status: 502 | 503 | 504; error: string };

export const OVERVIEW_ERRORS = {
  not_built:
    'The customer decision overview is not available on this server: the governed customer-decision facade is not built (pnpm build).',
  timed_out:
    'The customer decision overview took too long or was too large to read. Try again shortly.',
  failed:
    'The customer decision overview could not be read. Run pnpm kyberion customer-decision overview --tenant <tenant> on the server for the diagnostic.',
  invalid: 'The customer decision overview returned an unexpected format.',
} as const;

/** The `[CODE]` of a facade diagnostic, for the server log only. */
function diagnosticCodeOf(stderr: string): string {
  return /\[([A-Z][A-Z0-9_]{2,63})\]/u.exec(stderr)?.[1] ?? 'unknown';
}

/** One child run → a validated overview of exactly `tenant`, or a fixed error. */
export async function readTenantOverview(
  tenant: string,
  run: OverviewChildRunner = runOverviewChild,
  scriptExists: () => boolean = () =>
    safeExistsSync(pathResolver.rootResolve(OVERVIEW_FACADE_SCRIPT))
): Promise<OverviewResult> {
  if (!scriptExists()) return { ok: false, status: 503, error: OVERVIEW_ERRORS.not_built };
  let outcome: OverviewChildOutcome;
  try {
    outcome = await run(tenant);
  } catch (error) {
    logger.warn(
      `customer-decision overview child did not start — ${error instanceof Error ? error.name : 'error'} | the card shows an error; check the server build | tenant=${tenant}`
    );
    return { ok: false, status: 502, error: OVERVIEW_ERRORS.failed };
  }
  if (outcome.aborted) {
    logger.warn(
      `customer-decision overview child aborted — timeout or output cap | the card shows an error; retry | tenant=${tenant}`
    );
    return { ok: false, status: 504, error: OVERVIEW_ERRORS.timed_out };
  }
  if (outcome.status !== 0) {
    logger.warn(
      `customer-decision overview child failed — ${diagnosticCodeOf(outcome.stderr)} | run customer-decision overview --tenant ${tenant} on the server | status=${String(outcome.status)}`
    );
    return { ok: false, status: 502, error: OVERVIEW_ERRORS.failed };
  }
  const overview = parseCustomerDecisionOverview(parseJsonValue(outcome.stdout.trim()), tenant);
  if (!overview) {
    logger.warn(
      `customer-decision overview child printed an unexpected shape — not a 1.0.0 overview of the bound tenant | rebuild Chronos and the facade together | tenant=${tenant}`
    );
    return { ok: false, status: 502, error: OVERVIEW_ERRORS.invalid };
  }
  return { ok: true, overview };
}

interface CacheEntry {
  /** When the run settled; undefined while it is pending. */
  at?: number;
  result: Promise<OverviewResult>;
}

/**
 * Per-tenant cache of the child's result. A pending run is shared; a
 * successful result is reused for {@link OVERVIEW_CACHE_TTL_MS}; a failure is
 * dropped as soon as it settles so the next request retries.
 */
export function createOverviewReader(
  options: {
    run?: OverviewChildRunner;
    scriptExists?: () => boolean;
    ttlMs?: number;
    now?: () => number;
  } = {}
): (tenant: string) => Promise<OverviewResult> {
  const cache = new Map<string, CacheEntry>();
  const ttl = options.ttlMs ?? OVERVIEW_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  return (tenant) => {
    const hit = cache.get(tenant);
    if (hit && (hit.at === undefined || now() - hit.at < ttl)) return hit.result;
    if (cache.size >= OVERVIEW_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const result = readTenantOverview(tenant, options.run, options.scriptExists);
    const entry: CacheEntry = { result };
    cache.delete(tenant);
    cache.set(tenant, entry);
    void result.then((settled) => {
      if (cache.get(tenant) !== entry) return;
      if (settled.ok) entry.at = now();
      else cache.delete(tenant);
    });
    return result;
  };
}

/** The process-wide reader the route uses. */
export const readCustomerDecisionOverview = createOverviewReader();
