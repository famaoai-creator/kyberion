/**
 * CD-11: the daily tenant pipeline op `core:customer_decision_reminders`.
 *
 * The op never runs the sweep in the pipeline process. It runs the built
 * governed facade (`dist/scripts/customer_decision.js remind`) as a child
 * process, the same way the customer room does: an explicit env without
 * SYSTEM_ROLE and without the ambient role / persona / sudo / mission keys,
 * bound to the tenant the run is bound to. The facade then assumes its own
 * narrow roles (decision_ledger, customer_decision_invite_store, the inbox's
 * shared writer) exactly as when an operator runs `customer-decision remind`,
 * so a pipeline runner under any SYSTEM_ROLE never reaches those roles and no
 * role assumption policy changes.
 *
 * The op takes the tenant only from the run's binding (a tenant pipeline under
 * `knowledge/confidential/<tenant>/pipelines/`, run by chronos bound to that
 * tenant); `tenant`, when given, must be the same. It returns ids and counts
 * only — the pipeline context is not tenant-partitioned.
 */
import { resolveIdentityContext } from '@agent/core/authority';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResultAsync } from '@agent/core/secure-io';

export const REMINDER_FACADE_SCRIPT = 'dist/scripts/customer_decision.js';
/** One tenant's sweep: every sent agenda, each send through the gate. */
export const REMINDER_FACADE_TIMEOUT_MS = 10 * 60 * 1000;

/** Keys of the secure-io exec allowlist the facade child must not inherit. */
const CLEARED_ENV = ['MISSION_ROLE', 'MISSION_ID', 'KYBERION_PERSONA', 'KYBERION_SUDO'] as const;

/** The facade child's env on top of the secure-io exec allowlist. */
export function reminderFacadeEnv(tenant: string): Record<string, string> {
  const root = getRegisteredEnvText('KYBERION_ROOT');
  const scopeRequired = getRegisteredEnvText('KYBERION_TENANT_SCOPE_REQUIRED');
  return {
    ...Object.fromEntries(CLEARED_ENV.map((key) => [key, ''])),
    // Explicitly not this process's SYSTEM_ROLE (stated so the role-assumption
    // analysis sees the child does not inherit it).
    SYSTEM_ROLE: '',
    KYBERION_TENANT: tenant,
    ...(scopeRequired ? { KYBERION_TENANT_SCOPE_REQUIRED: scopeRequired } : {}),
    ...(root ? { KYBERION_ROOT: root } : {}),
  };
}

function refuse(code: string, message: string): never {
  throw new Error(`[${code}] ${message}`);
}

/** The bound tenant of the run; another requested tenant is refused. */
export function reminderOpTenant(requested?: string): string {
  const bound = resolveIdentityContext().tenantSlug;
  if (!bound) {
    refuse(
      'CUSTOMER_DECISION_REMINDERS_TENANT_REQUIRED',
      'core:customer_decision_reminders runs only in a tenant-bound pipeline run (knowledge/confidential/<tenant>/pipelines/, installed with customer-decision reminders --install)'
    );
  }
  if (requested && requested !== bound) {
    refuse(
      'CUSTOMER_DECISION_REMINDERS_TENANT_MISMATCH',
      `the run is bound to ${bound}, not ${requested}`
    );
  }
  return bound;
}

export interface ReminderOpResult {
  tenant: string;
  dry_run: boolean;
  agendas: number;
  agenda_failures: number;
  counts: Record<string, number>;
  reminder_ids: string[];
}

function parseSweep(stdout: string): Record<string, unknown> {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return refuse(
    'CUSTOMER_DECISION_REMINDERS_OUTPUT_INVALID',
    'the reminder facade did not print a sweep result'
  );
}

export async function runCustomerDecisionReminderOp(input: {
  tenant?: string;
  dryRun?: boolean;
  now: string;
  /** Test seam: where the facade script is resolved from. */
  scriptPath?: string;
}): Promise<ReminderOpResult> {
  const tenant = reminderOpTenant(input.tenant);
  const script = input.scriptPath ?? pathResolver.rootResolve(REMINDER_FACADE_SCRIPT);
  const result = await safeExecResultAsync(
    process.execPath,
    [
      script,
      'remind',
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
      timeoutMs: REMINDER_FACADE_TIMEOUT_MS,
      maxOutputMB: 8,
    }
  );
  if (result.status !== 0) {
    refuse(
      'CUSTOMER_DECISION_REMINDERS_FAILED',
      `customer-decision remind exited ${String(result.status)} for tenant ${tenant}`
    );
  }
  const sweep = parseSweep(result.stdout);
  const reminders = Array.isArray(sweep.reminders) ? sweep.reminders : [];
  const counts =
    sweep.counts && typeof sweep.counts === 'object'
      ? (sweep.counts as Record<string, number>)
      : {};
  return {
    tenant,
    dry_run: sweep.dry_run === true,
    agendas: typeof sweep.agendas === 'number' ? sweep.agendas : 0,
    agenda_failures: Array.isArray(sweep.agenda_failures) ? sweep.agenda_failures.length : 0,
    counts,
    reminder_ids: reminders
      .map((item) =>
        item && typeof item === 'object'
          ? (item as { reminder_id?: unknown }).reminder_id
          : undefined
      )
      .filter((id): id is string => typeof id === 'string'),
  };
}
