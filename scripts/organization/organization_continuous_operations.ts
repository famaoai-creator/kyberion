import { pathResolver } from '@agent/core/path-resolver';
import { assertContinuousOperationsReconciliationAuthority } from '@agent/core/organization/continuous-operations-sources';
import {
  COLLECTOR_NOT_STARTED_NEXT,
  readCollectorAttempt,
  recordCollectorStop,
  reconcileCollectorAttempt,
} from '../continuous/continuous_collector_state.js';
import {
  requestOrganizationWriteApproval,
  runWithOrganizationWriteApproval,
} from './organization_write_approval.js';
import { loadContinuousOperationsConfig } from '../continuous/continuous_operations_config.js';
import { runContinuousOperationsCycle } from '../continuous/continuous_operations_cycle.js';
import { inspectContinuousCadence } from '../continuous/continuous_operations_cadence.js';
import { inspectOrganizationCadenceEnrollment } from './organization_cadence_reconcile.js';
import { readOrganizationCadenceState } from '@agent/core/organization/organization-cadence';
/** Organization facade for the governed, snapshot-based continuous operations loop. */
import { resolveScopeResolution } from '@agent/core/scope-context';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { findDotCharter } from '@agent/core/dot/dot-charter';
import { runAsDotCharter } from '@agent/core/dot/dot-key-results';
import { runContinuousManagedOwner } from '../continuous/continuous_work_owner.js';
import { runContinuousOperations } from '@agent/core/organization/continuous-operations';
import { type ContinuousOperationsConfig } from '@agent/core/organization/continuous-operations-policy';

const USAGE =
  'Usage: pnpm organization continuous run --config <governed-config.json> --dry-run|--apply [--recover-admissions] [--json]';

export function assertContinuousOperationsSelectedScope(
  config: ContinuousOperationsConfig,
  selected = resolveScopeResolution().scope
): void {
  const scope = config.scope;
  if (
    selected.tier !== scope.tier ||
    selected.tenant_slug !== scope.tenant_slug ||
    selected.organization_id !== scope.organization_id ||
    selected.project_id !== scope.project_id
  ) {
    throw new Error(
      'Select the matching tier, tenant, organization and project with pnpm scope use before running this loop.'
    );
  }
}

export async function runOrganizationContinuousStatus(
  args: string[],
  print: (value: unknown) => void
): Promise<void> {
  const usage = 'Usage: pnpm organization continuous status --config <governed-config.json>';
  if (args.length === 1 && args[0] === '--help') {
    print(usage);
    return;
  }
  const [flag, ref] = args;
  if (args.length !== 2 || flag !== '--config' || !ref) throw new Error(usage);
  const config = loadContinuousOperationsConfig(ref);
  assertContinuousOperationsSelectedScope(config);
  const { scope } = config;
  const status = await withExecutionContextAsync(
    'organization_operator',
    async () => {
      const organization = readOrganizationCadenceState({
        organizationId: scope.organization_id,
        tier: scope.tier,
        tenantSlug: scope.tenant_slug,
      });
      const charter = findDotCharter(config.dot_id)?.charter;
      if (charter) assertContinuousOperationsSelectedScope(config, charter.scope);
      const collectors = charter
        ? config.sources.flatMap((source) => {
            if (source.kind !== 'pipeline') return [];
            const item = { source_id: source.source_id, pipeline_ref: source.pipeline_ref };
            try {
              const attempt = readCollectorAttempt(
                pathResolver.rootDir(),
                charter,
                source.pipeline_ref
              );
              return [
                {
                  ...item,
                  status: attempt?.status ?? 'awaiting_first_attempt',
                  attempt_id: attempt?.attempt_id,
                  pipeline_run_id: attempt?.pipeline_run_id,
                  started_at: attempt?.started_at,
                  stop_confirmed_at: attempt?.stop_confirmed_at,
                  ...(attempt?.reason_code
                    ? {
                        reason_code: attempt.reason_code,
                        next: COLLECTOR_NOT_STARTED_NEXT[attempt.reason_code],
                      }
                    : {}),
                },
              ];
            } catch {
              return [{ ...item, status: 'receipt_unavailable' }];
            }
          })
        : [];
      if (!organization || organization.status !== 'active')
        return {
          loop_id: config.loop_id,
          scope,
          status: 'awaiting_organization',
          organization_status: organization?.status ?? 'missing',
          organization_cadence: { status: 'awaiting_organization' },
          continuous_operations: { status: 'awaiting_organization', collectors },
        };
      const cadence = inspectContinuousCadence(config, charter);
      return {
        ...cadence,
        organization_cadence: inspectOrganizationCadenceEnrollment(organization),
        continuous_operations: {
          ...cadence,
          collectors,
          ...(cadence.status === 'charter_unavailable'
            ? {
                next: 'Configure the exact-scope charter named by the reviewed Continuous Operations configuration.',
              }
            : {}),
        },
      };
    },
    undefined,
    scope.tenant_slug,
    scope.organization_id
  );
  print(status);
}

export async function runOrganizationContinuousCollectorReconciliation(
  args: string[],
  print: (value: unknown) => void
): Promise<void> {
  const usage =
    'Usage: pnpm organization continuous reconcile-collector --config <ref> --pipeline-ref <ref> --attempt-id <id> --evidence <ref> --request-approval|--approval-request-id <id>';
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flags.has(flag)) throw new Error(usage);
    if (flag === '--request-approval') {
      flags.set(flag, 'true');
      continue;
    }
    if (
      ![
        '--config',
        '--pipeline-ref',
        '--attempt-id',
        '--evidence',
        '--approval-request-id',
      ].includes(flag)
    )
      throw new Error(usage);
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--')) throw new Error(usage);
    flags.set(flag, value);
  }
  const configRef = flags.get('--config');
  const pipelineRef = flags.get('--pipeline-ref');
  const attemptId = flags.get('--attempt-id');
  const evidence = flags.get('--evidence');
  const approvalId = flags.get('--approval-request-id');
  if (
    !configRef ||
    !pipelineRef ||
    !attemptId ||
    !evidence ||
    Boolean(approvalId) === flags.has('--request-approval')
  )
    throw new Error(usage);
  const config = loadContinuousOperationsConfig(configRef);
  assertContinuousOperationsSelectedScope(config);
  const { scope } = config;
  if (
    !config.sources.some(
      (source) => source.kind === 'pipeline' && source.pipeline_ref === pipelineRef
    )
  )
    throw new Error('Reconciliation requires a configured collector');
  const root = pathResolver.rootDir();
  const approvalScope = {
    command: 'continuous reconcile-collector',
    organizationId: scope.organization_id,
    tier: scope.tier,
    tenantSlug: scope.tenant_slug,
  };
  const parsed = { configRef, pipelineRef, attemptId, evidence };
  const charter = withExecutionContext(
    'organization_operator',
    () => {
      const current = findDotCharter(config.dot_id)?.charter;
      if (!current) throw new Error('Collector charter is unavailable');
      assertContinuousOperationsReconciliationAuthority(config, current);
      return current;
    },
    undefined,
    scope.tenant_slug,
    scope.organization_id
  );
  if (!approvalId) {
    await withExecutionContextAsync(
      'organization_operator',
      () => recordCollectorStop(root, charter, pipelineRef, attemptId),
      undefined,
      scope.tenant_slug,
      scope.organization_id
    );
    print(requestOrganizationWriteApproval({ scope: approvalScope, parsed }));
    return;
  }
  await withExecutionContextAsync(
    'organization_operator',
    () =>
      reconcileCollectorAttempt(
        root,
        charter,
        pipelineRef,
        attemptId,
        evidence,
        approvalId,
        (commit) =>
          runWithOrganizationWriteApproval(
            approvalId,
            approvalScope,
            parsed,
            'pnpm organization continuous reconcile-collector',
            commit
          )
      ),
    undefined,
    scope.tenant_slug,
    scope.organization_id
  );
  print({ status: 'reconciled', attempt_id: attemptId, pipeline_ref: pipelineRef });
}

export async function runOrganizationContinuousOwnerTick(
  args: string[],
  print: (value: unknown) => void
): Promise<void> {
  const [configFlag, configRef, itemFlag, itemId] = args;
  if (
    args.length !== 4 ||
    configFlag !== '--config' ||
    !configRef ||
    itemFlag !== '--work-item-id' ||
    !itemId ||
    !/^witem-[a-z0-9-]+$/i.test(itemId)
  ) {
    throw new Error(
      'Usage: pnpm organization continuous owner-tick --config <governed-config.json> --work-item-id <id>'
    );
  }
  const config = loadContinuousOperationsConfig(configRef);
  assertContinuousOperationsSelectedScope(config);
  const { scope } = config;
  const rows = await withExecutionContextAsync(
    'organization_operator',
    async () => {
      const charter = findDotCharter(config.dot_id)?.charter;
      if (!charter || charter.authority.authority_role !== 'organization_operator') {
        throw new Error('Continuous owner tick requires an organization operator charter.');
      }
      assertContinuousOperationsSelectedScope(config, charter.scope);
      return runAsDotCharter(charter, () => runContinuousManagedOwner(charter, { itemId }));
    },
    undefined,
    scope.tenant_slug,
    scope.organization_id
  );
  print(rows);
  if (!rows.length || rows.some((row) => ['blocked', 'failed', 'skipped'].includes(row.status))) {
    throw new Error(
      'Continuous owner tick made no executable progress; inspect the reported state.'
    );
  }
}

export async function runOrganizationContinuousOperations(
  args: string[],
  print: (value: unknown) => void,
  deps: {
    load?: typeof loadContinuousOperationsConfig;
    selectedScope?: typeof assertContinuousOperationsSelectedScope;
    run?: typeof runContinuousOperations;
    bind?: (config: ContinuousOperationsConfig, run: () => unknown) => unknown;
  } = {}
): Promise<void> {
  let configRef: string | undefined;
  let apply = false;
  let dryRun = false;
  let json = false;
  let recoverAdmissions = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(USAGE);
    seen.add(arg);
    if (arg === '--config' && args[i + 1] && !args[i + 1].startsWith('--')) configRef = args[++i];
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--recover-admissions') recoverAdmissions = true;
    else if (arg === '--json') json = true;
    else throw new Error(USAGE);
  }
  if (!configRef || apply === dryRun || (recoverAdmissions && !apply)) throw new Error(USAGE);
  const config = (deps.load ?? loadContinuousOperationsConfig)(configRef);
  (deps.selectedScope ?? assertContinuousOperationsSelectedScope)(config);
  const run = async () =>
    deps.run
      ? deps.run(config, { apply, recoverAdmissions })
      : runContinuousOperationsCycle(config, { apply, recoverAdmissions });
  const result = deps.bind
    ? await deps.bind(config, run)
    : await withExecutionContextAsync(
        'organization_operator',
        run,
        undefined,
        config.scope.tenant_slug,
        config.scope.organization_id
      );
  print(json ? result : { mode: apply ? 'apply' : 'dry_run', report: result });
  if (
    (result as ReturnType<typeof runContinuousOperations>).inventory.some(
      (row) => row.disposition === 'error'
    )
  ) {
    throw new Error('Continuous operations admission failed; inspect the report before retrying.');
  }
}

export {
  loadContinuousOperationsConfig,
  CONTINUOUS_CONFIG_ROOT,
} from '../continuous/continuous_operations_config.js';
export { runContinuousOperationsCycleFromRef } from '../continuous/continuous_operations_cycle.js';

export { runContinuousManagedOwner };
