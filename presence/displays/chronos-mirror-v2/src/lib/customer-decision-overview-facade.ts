/**
 * CD-12: how Chronos reads a tenant's customer-decision overview, case
 * detail and learning view without gaining any reach into
 * `knowledge/confidential/<tenant>/decisions/`.
 *
 * Chronos never reads the case stores itself. It runs the built governed
 * facade (`dist/scripts/customer_decision.js overview --tenant <t> … --json`,
 * a fixed argv per view kind, see {@link facadeArgs}) as a child process,
 * bound to the resolved viewer tenant, exactly as the
 * customer room does (presence/displays/customer-room/src/server/facade.ts):
 * a minimal env on top of the secure-io exec allowlist with the ambient role,
 * persona, sudo and mission keys blanked and KYBERION_TENANT set to the one
 * tenant the viewer resolved to. The facade assumes its own narrow
 * tenant-bound roles and refuses a `--tenant` other than the bound one, so a
 * child for tenant A can never print tenant B. No role assumption is added
 * for chronos_mirror_v2.
 *
 * Responses are bounded: a timeout and an output cap on the child, a short
 * per-view cache (`kind:tenant:arg`) plus in-flight sharing so polling cards
 * do not fork one child per request, at most {@link FACADE_CHILD_CONCURRENCY}
 * children at once, and errors mapped to fixed messages (no stderr, paths or
 * stack traces reach the browser).
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
import {
  isCustomerDecisionCaseId,
  parseCustomerDecisionCaseDetail,
  type CustomerDecisionCaseDetailView,
} from './customer-decision-case-response';
import {
  isLearningReportDate,
  parseCustomerDecisionLearningView,
  type CustomerDecisionLearningViewData,
} from './customer-decision-learning-response';

export const OVERVIEW_FACADE_SCRIPT = 'dist/scripts/customer_decision.js';
export const OVERVIEW_FACADE_TIMEOUT_MS = 15_000;
export const OVERVIEW_FACADE_MAX_OUTPUT_MB = 2;
export const OVERVIEW_CACHE_TTL_MS = 15_000;
const OVERVIEW_CACHE_LIMIT = 64;
/** Facade children running at once, across every view kind and tenant. */
export const FACADE_CHILD_CONCURRENCY = 4;

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

export type CustomerDecisionFacadeKind = 'overview' | 'case' | 'learning';

/** What each view kind's child prints, as Chronos keeps it. */
export interface CustomerDecisionFacadeValues {
  overview: CustomerDecisionOverviewView;
  case: CustomerDecisionCaseDetailView;
  learning: CustomerDecisionLearningViewData;
}

/**
 * The fixed facade argv of a view kind. `arg` is the case id (`case`,
 * required) or the report date (`learning`, optional: the latest report when
 * omitted). The routes validate both before calling; an invalid value still
 * never reaches the child.
 */
export function facadeArgs(
  kind: CustomerDecisionFacadeKind,
  tenant: string,
  arg?: string
): string[] {
  if (kind === 'overview')
    // Summary form: no entry rows and a capped attention list (with
    // totals.attention_total), so a large tenant stays within the output cap.
    return ['overview', '--tenant', tenant, '--summary', '--json'];
  if (kind === 'case') {
    if (!arg || !isCustomerDecisionCaseId(arg)) throw new Error('invalid case id');
    return ['overview', '--tenant', tenant, '--case', arg, '--detail', '--json'];
  }
  if (arg !== undefined && !isLearningReportDate(arg)) throw new Error('invalid report date');
  return ['overview', '--tenant', tenant, '--learning', ...(arg ? ['--date', arg] : []), '--json'];
}

export interface OverviewChildOutcome {
  /** Child exit status; null when it could not run. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Killed for time or output size. */
  aborted: boolean;
}

export type OverviewChildRunner = (tenant: string, args: string[]) => Promise<OverviewChildOutcome>;

export const runOverviewChild: OverviewChildRunner = async (tenant, args) => {
  const result = await safeExecResultAsync(
    process.execPath,
    [pathResolver.rootResolve(OVERVIEW_FACADE_SCRIPT), ...args],
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

export type FacadeResult<K extends CustomerDecisionFacadeKind> =
  | { ok: true; value: CustomerDecisionFacadeValues[K] }
  | { ok: false; status: 404 | 502 | 503 | 504; error: string };

export const OVERVIEW_ERRORS = {
  not_built:
    'Customer decisions are not available on this server: the governed customer-decision facade is not built (pnpm build).',
  timed_out: 'Customer decisions took too long or were too large to read. Try again shortly.',
  failed:
    'Customer decisions could not be read. Run pnpm kyberion customer-decision overview --tenant <tenant> on the server for the diagnostic.',
  invalid: 'Customer decisions returned an unexpected format.',
  case_not_found: 'This case has no customer decisions, or it no longer exists.',
  report_not_found: 'There is no learning report for this date.',
} as const;

/** Facade diagnostic codes that mean "nothing there" (404), not a failure. */
const NOT_FOUND_ERRORS: Partial<Record<CustomerDecisionFacadeKind, Record<string, string>>> = {
  case: { CUSTOMER_DECISION_CASE_NOT_FOUND: OVERVIEW_ERRORS.case_not_found },
  learning: { CUSTOMER_DECISION_REPORT_NOT_FOUND: OVERVIEW_ERRORS.report_not_found },
};

/** The `[CODE]` of a facade diagnostic, for the server log only. */
function diagnosticCodeOf(stderr: string): string {
  return /\[([A-Z][A-Z0-9_]{2,63})\]/u.exec(stderr)?.[1] ?? 'unknown';
}

/** The child's parsed stdout as the view of exactly the requested tenant (and case / date). */
function parseFacadeValue<K extends CustomerDecisionFacadeKind>(
  kind: K,
  value: unknown,
  tenant: string,
  arg?: string
): CustomerDecisionFacadeValues[K] | undefined {
  const parsed =
    kind === 'overview'
      ? parseCustomerDecisionOverview(value, tenant)
      : kind === 'case'
        ? parseCustomerDecisionCaseDetail(value, tenant, arg)
        : parseCustomerDecisionLearningView(value, tenant, arg);
  return parsed as CustomerDecisionFacadeValues[K] | undefined;
}

/** One child run → a validated view of exactly `tenant`, or a fixed error. */
export async function readFacadeView<K extends CustomerDecisionFacadeKind>(
  kind: K,
  tenant: string,
  arg?: string,
  run: OverviewChildRunner = runOverviewChild,
  scriptExists: () => boolean = () =>
    safeExistsSync(pathResolver.rootResolve(OVERVIEW_FACADE_SCRIPT))
): Promise<FacadeResult<K>> {
  if (!scriptExists()) return { ok: false, status: 503, error: OVERVIEW_ERRORS.not_built };
  let outcome: OverviewChildOutcome;
  try {
    outcome = await run(tenant, facadeArgs(kind, tenant, arg));
  } catch (error) {
    logger.warn(
      `customer-decision ${kind} child did not start — ${error instanceof Error ? error.name : 'error'} | the view shows an error; check the server build | tenant=${tenant}`
    );
    return { ok: false, status: 502, error: OVERVIEW_ERRORS.failed };
  }
  if (outcome.aborted) {
    logger.warn(
      `customer-decision ${kind} child aborted — timeout or output cap | the view shows an error; retry | tenant=${tenant}`
    );
    return { ok: false, status: 504, error: OVERVIEW_ERRORS.timed_out };
  }
  if (outcome.status !== 0) {
    const code = diagnosticCodeOf(outcome.stderr);
    const notFound = NOT_FOUND_ERRORS[kind]?.[code];
    if (notFound) return { ok: false, status: 404, error: notFound };
    logger.warn(
      `customer-decision ${kind} child failed — ${code} | run customer-decision overview --tenant ${tenant} on the server | status=${String(outcome.status)}`
    );
    return { ok: false, status: 502, error: OVERVIEW_ERRORS.failed };
  }
  const value = parseFacadeValue(kind, parseJsonValue(outcome.stdout.trim()), tenant, arg);
  if (!value) {
    logger.warn(
      `customer-decision ${kind} child printed an unexpected shape — not a 1.0.0 view of the bound tenant | rebuild Chronos and the facade together | tenant=${tenant}`
    );
    return { ok: false, status: 502, error: OVERVIEW_ERRORS.invalid };
  }
  return { ok: true, value };
}

/** At most `limit` tasks run at once; the rest wait in arrival order. */
export function createConcurrencyLimit(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

interface CacheEntry {
  /** When the run settled; undefined while it is pending. */
  at?: number;
  result: Promise<FacadeResult<CustomerDecisionFacadeKind>>;
}

export type CustomerDecisionFacadeReader = <K extends CustomerDecisionFacadeKind>(
  kind: K,
  tenant: string,
  arg?: string
) => Promise<FacadeResult<K>>;

/**
 * Per-view cache of the child's result, keyed `kind:tenant:arg`. A pending
 * run is shared; a successful result is reused for {@link OVERVIEW_CACHE_TTL_MS};
 * a failure (a not-found included) is dropped as soon as it settles so the
 * next request retries. At most `concurrency` children run at once.
 */
export function createFacadeReader(
  options: {
    run?: OverviewChildRunner;
    scriptExists?: () => boolean;
    ttlMs?: number;
    now?: () => number;
    concurrency?: number;
  } = {}
): CustomerDecisionFacadeReader {
  const cache = new Map<string, CacheEntry>();
  const ttl = options.ttlMs ?? OVERVIEW_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const limited = createConcurrencyLimit(options.concurrency ?? FACADE_CHILD_CONCURRENCY);
  const runChild = options.run ?? runOverviewChild;
  const run: OverviewChildRunner = (tenant, args) => limited(() => runChild(tenant, args));
  return <K extends CustomerDecisionFacadeKind>(kind: K, tenant: string, arg?: string) => {
    const key = `${kind}:${tenant}:${arg ?? ''}`;
    const hit = cache.get(key);
    if (hit && (hit.at === undefined || now() - hit.at < ttl))
      return hit.result as Promise<FacadeResult<K>>;
    if (cache.size >= OVERVIEW_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const result = readFacadeView(kind, tenant, arg, run, options.scriptExists);
    const entry: CacheEntry = { result };
    cache.delete(key);
    cache.set(key, entry);
    void result.then((settled) => {
      if (cache.get(key) !== entry) return;
      if (settled.ok) entry.at = now();
      else cache.delete(key);
    });
    return result;
  };
}

/** The process-wide reader every customer-decision route uses. */
export const readCustomerDecisionFacade = createFacadeReader();
