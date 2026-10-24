/**
 * CD-12: the weekly tenant pipeline op `core:customer_decision_learning`.
 *
 * Same shape as `core:customer_decision_reminders` (reminder-op.ts): the op
 * never counts in the pipeline process. It runs the built governed facade
 * (`dist/scripts/customer_decision.js learning`) as a child with the same
 * explicit env (no SYSTEM_ROLE, no ambient role / persona / sudo / mission
 * keys, bound to the run's tenant), so the facade assumes its own narrow
 * roles exactly as when an operator runs `customer-decision learning`.
 *
 * The tenant comes only from the run's binding; `tenant`, when given, must be
 * the same. It returns ids and counts only.
 */
import { resolveIdentityContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResultAsync } from '@agent/core/secure-io';
import { REMINDER_FACADE_SCRIPT, reminderFacadeEnv } from './reminder-op.js';

export const LEARNING_FACADE_TIMEOUT_MS = 5 * 60 * 1000;

function refuse(code: string, message: string): never {
  throw new Error(`[${code}] ${message}`);
}

/** The bound tenant of the run; another requested tenant is refused. */
export function learningOpTenant(requested?: string): string {
  const bound = resolveIdentityContext().tenantSlug;
  if (!bound) {
    refuse(
      'CUSTOMER_DECISION_LEARNING_TENANT_REQUIRED',
      'core:customer_decision_learning runs only in a tenant-bound pipeline run (knowledge/confidential/<tenant>/pipelines/, installed with customer-decision learning --install)'
    );
  }
  if (requested && requested !== bound) {
    refuse(
      'CUSTOMER_DECISION_LEARNING_TENANT_MISMATCH',
      `the run is bound to ${bound}, not ${requested}`
    );
  }
  return bound;
}

export interface LearningOpResult {
  tenant: string;
  dry_run: boolean;
  report_date: string;
  cases: number;
  case_failures: number;
  suggestions: number;
  created: number;
  existing: number;
  learning_ids: string[];
}

function parseRun(stdout: string): Record<string, unknown> {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return refuse(
    'CUSTOMER_DECISION_LEARNING_OUTPUT_INVALID',
    'the learning facade did not print a learning result'
  );
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export async function runCustomerDecisionLearningOp(input: {
  tenant?: string;
  dryRun?: boolean;
  now: string;
  /** Test seam: where the facade script is resolved from. */
  scriptPath?: string;
}): Promise<LearningOpResult> {
  const tenant = learningOpTenant(input.tenant);
  const script = input.scriptPath ?? pathResolver.rootResolve(REMINDER_FACADE_SCRIPT);
  const result = await safeExecResultAsync(
    process.execPath,
    [
      script,
      'learning',
      '--tenant',
      tenant,
      '--now',
      input.now,
      '--json',
      ...(input.dryRun ? ['--dry-run'] : []),
    ],
    {
      cwd: pathResolver.rootDir(),
      env: reminderFacadeEnv(tenant),
      timeoutMs: LEARNING_FACADE_TIMEOUT_MS,
      maxOutputMB: 8,
    }
  );
  if (result.status !== 0) {
    refuse(
      'CUSTOMER_DECISION_LEARNING_FAILED',
      `customer-decision learning exited ${String(result.status)} for tenant ${tenant}`
    );
  }
  const run = parseRun(result.stdout);
  const counts =
    run.counts && typeof run.counts === 'object' ? (run.counts as Record<string, unknown>) : {};
  const suggestions = Array.isArray(run.suggestions) ? run.suggestions : [];
  return {
    tenant,
    dry_run: run.dry_run === true,
    report_date: typeof run.report_date === 'string' ? run.report_date : '',
    cases: count(run.cases),
    case_failures: Array.isArray(run.case_failures) ? run.case_failures.length : 0,
    suggestions: count(counts.suggestions),
    created: count(counts.created),
    existing: count(counts.existing),
    learning_ids: suggestions
      .map((item) =>
        item && typeof item === 'object'
          ? (item as { learning_id?: unknown }).learning_id
          : undefined
      )
      .filter((id): id is string => typeof id === 'string'),
  };
}
