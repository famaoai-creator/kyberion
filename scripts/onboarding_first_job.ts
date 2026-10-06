/** Explicit public diagnostic setup. Reconstructed from the retained contract. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withExecutionContext } from '@agent/core/authority';
import { safeWriteFile } from '@agent/core/secure-io';
import { withLockSync } from '@agent/core/foundation/lock-utils';
import { compileSchema, getRegisteredEnvText, readJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import { mutateTenant } from '@agent/core/organization/tenant-governance';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import { findDotCharter, validateDotCharter, type DotCharter } from '@agent/core/dot/dot-charter';
import {
  createDraftDotCharter,
  transitionDotCharterStatus,
  checkDotActivationReadiness,
} from '@agent/core/dot/dot-lifecycle';
import {
  FRONT_DESK_EXECUTION_POLICY_PATH,
  FRONT_DESK_RECEIPT_COMMAND,
  FRONT_DESK_RECEIPT_PIPELINE,
  FRONT_DESK_RECEIPT_VERSION,
  frontDeskMappingDigest,
  type FrontDeskExecutionMapping,
  type FrontDeskExecutionPolicy,
} from '@agent/core/surface/front-desk-execution-contract';
import { assertBuiltinOnlyWorkerEventStream } from '@agent/core/workforce/worker-event-stream';
import { resolveSurfaceBrowserUrl } from '@agent/core/surface/surface-url';

const OWNER = 'onboarding-first-job';
const PRINCIPAL = 'human:presence-studio-localadmin';
const MARKER = 'public-local-diagnostic-v1';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function assertOperatorContext(tenant: string): void {
  if (!isValidTenantSlug(tenant)) throw new Error('first_job_invalid_tenant');
  if (getRegisteredEnvText('MISSION_ID') || getRegisteredEnvText('SYSTEM_ROLE'))
    throw new Error('first_job_requires_standalone_operator_context');
  const ambient = getRegisteredEnvText('KYBERION_TENANT');
  if (ambient && ambient !== tenant) throw new Error('first_job_ambient_tenant_conflict');
}

export function diagnosticDraft(tenant: string): DotCharter {
  if (!isValidTenantSlug(tenant)) throw new Error('first_job_invalid_tenant');
  return validateDotCharter({
    kind: 'dot-charter',
    dot_id: 'first-job-' + tenant,
    version: '1.0.0',
    title: 'First local diagnostic job',
    purpose: 'Produce only explicitly requested and human-approved public diagnostic receipts.',
    status: 'draft',
    scope: { tier: 'public', tenant_slug: tenant },
    goal: { statement: 'Return a verified receipt without invoking a reasoning provider.' },
    attention: { triggers: [] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_work_shapes: ['pipeline'],
      allowed_pipelines: [FRONT_DESK_RECEIPT_PIPELINE],
      max_concurrent_delegations: 1,
    },
    decisions: { default_decision: 'approve', escalate_channel: 'surface' },
    notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { heartbeat_id: 'dot-first-job-' + tenant, execution_mode: 'front_desk_diagnostic' },
  });
}

function mappingFor(tenant: string): FrontDeskExecutionMapping {
  return {
    id: 'first-job-' + tenant,
    dotId: 'first-job-' + tenant,
    viewer: {
      principalId: PRINCIPAL,
      role: 'localadmin',
      source: 'loopback',
      tenantSlugs: [tenant],
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['public'],
    },
    exactCommand: FRONT_DESK_RECEIPT_COMMAND,
    pipeline: { path: FRONT_DESK_RECEIPT_PIPELINE, version: FRONT_DESK_RECEIPT_VERSION },
  };
}

function readPolicy(): FrontDeskExecutionPolicy {
  const value = readJson<unknown>(pathResolver.rootResolve(FRONT_DESK_EXECUTION_POLICY_PATH));
  const validate = compileSchema(
    pathResolver.rootResolve('knowledge/product/schemas/front-desk-execution-policy.schema.json')
  );
  if (!validate(value)) throw new Error('first_job_policy_invalid');
  return value as FrontDeskExecutionPolicy;
}

function readOwnedTenant(tenant: string) {
  try {
    return withExecutionContext('ecosystem_architect', () => {
      const profile = readTenantProfile(tenant);
      if (!profile) return undefined;
      if (profile.status !== 'active' || profile.metadata?.onboarding_first_job !== MARKER)
        throw new Error('unrelated tenant');
      return { status: profile.status, marker: MARKER };
    });
  } catch {
    throw new Error('first_job_existing_tenant_not_owned');
  }
}

/** Pure configuration inspection. It does not provision identity or approve work. */
export function planFirstJob(tenant: string) {
  assertOperatorContext(tenant);
  const mapping = mappingFor(tenant);
  const draft = diagnosticDraft(tenant);
  const policy = readPolicy();
  const ownedTenant = readOwnedTenant(tenant);
  const existing = findDotCharter(draft.dot_id)?.charter;
  if (existing && (existing.status === 'paused' || existing.status === 'retired'))
    throw new Error('first_job_charter_not_active');
  if (existing && !isDeepStrictEqual({ ...existing, status: 'draft' }, draft))
    throw new Error('first_job_charter_conflict');
  if (existing && !ownedTenant) throw new Error('first_job_charter_without_owned_tenant');
  const conflicts = policy.mappings.filter(
    (item) =>
      item.id === mapping.id ||
      item.dotId === mapping.dotId ||
      item.viewer.principalId === PRINCIPAL
  );
  if (conflicts.some((item) => !isDeepStrictEqual(item, mapping)) || conflicts.length > 1)
    throw new Error('first_job_mapping_conflict');
  if (conflicts.length && (!ownedTenant || existing?.status !== 'active'))
    throw new Error('first_job_mapping_without_active_charter');
  const gate = checkDotActivationReadiness(existing ?? draft);
  if (!gate.ready) throw new Error('first_job_activation_not_ready');
  const pipelineDigest = frontDeskMappingDigest(mapping);
  const state = {
    version: 1,
    tenant,
    mapping,
    policy,
    draft,
    tenant_state: ownedTenant ?? null,
    charter_state: existing ?? null,
    pipeline_digest: pipelineDigest,
  };
  return {
    status: conflicts.length
      ? ('already_configured' as const)
      : ('awaiting_explicit_apply' as const),
    tenant,
    dot_id: draft.dot_id,
    mapping,
    draft,
    plan_digest: digest(state),
    pipeline_digest: pipelineDigest,
    first_job_url: resolveSurfaceBrowserUrl('presence-studio') + '/first-job',
    effects: [
      'Create or resume only this owned public diagnostic tenant and draft.',
      'Activate the strict diagnostic charter and write the exact mapping last.',
      'No credentials, member identities, execution decisions, or jobs are created.',
    ],
    next_step:
      'Review this plan, then apply its exact digest. Verified browser sign-in is separately required.',
  };
}

export function applyFirstJob(tenant: string, acceptedDigest: string) {
  assertOperatorContext(tenant);
  return withExecutionContext('ecosystem_architect', () =>
    withLockSync('first-job-setup', () => {
      const plan = planFirstJob(tenant);
      if (!acceptedDigest || acceptedDigest !== plan.plan_digest)
        throw new Error('first_job_plan_changed');
      if (plan.status === 'already_configured') return plan;
      const policyBefore = readPolicy();
      if (!readOwnedTenant(tenant))
        mutateTenant({
          verb: 'create',
          slug: tenant,
          displayName: 'Local public diagnostic: ' + tenant,
          assignedRole: 'owner',
          apply: true,
          actor: OWNER,
          metadata: { onboarding_first_job: MARKER, synthetic_public_only: true },
        });
      let charter = findDotCharter(plan.dot_id)?.charter;
      if (!charter) charter = createDraftDotCharter(plan.draft, { actor: OWNER });
      if (
        !isDeepStrictEqual({ ...charter, status: 'draft' }, plan.draft) ||
        !['draft', 'active'].includes(charter.status)
      )
        throw new Error('first_job_charter_changed');
      if (charter.status === 'draft')
        transitionDotCharterStatus(plan.dot_id, 'active', { actor: OWNER });
      if (
        !isDeepStrictEqual(readPolicy(), policyBefore) ||
        frontDeskMappingDigest(plan.mapping) !== plan.pipeline_digest
      )
        throw new Error('first_job_configuration_changed');
      safeWriteFile(
        FRONT_DESK_EXECUTION_POLICY_PATH,
        JSON.stringify(
          { ...policyBefore, mappings: [...policyBefore.mappings, plan.mapping] },
          null,
          2
        ) + '\n'
      );
      return planFirstJob(tenant);
    })
  );
}

/** One bounded pass only: no global reaper, generic wake, or automatic approval. */
export async function tickFirstJob(tenant: string) {
  assertBuiltinOnlyWorkerEventStream();
  const plan = planFirstJob(tenant);
  if (plan.status !== 'already_configured') throw new Error('first_job_setup_required');
  const loaded = findDotCharter(plan.dot_id);
  if (!loaded || loaded.charter.status !== 'active')
    throw new Error('first_job_charter_unavailable');
  const { assertFrontDeskDiagnosticDotCharter } = await import('@agent/core/dot/dot-charter');
  assertFrontDeskDiagnosticDotCharter(loaded.charter);
  const { runDotHousekeeping } = await import('@agent/core/dot/dot-dispatch');
  const { runAsDotCharter } = await import('@agent/core/dot/dot-key-results');
  const { runFrontDeskExecutionIntake } = await import('@agent/core/surface/front-desk-execution');
  const { createFirstJobTenantStatusAssertion } =
    await import('./onboarding_first_job_tenant_status.js');
  const { runDotExecutorStep } = await import('./dot_executor_step.js');
  const assertTenant = createFirstJobTenantStatusAssertion(loaded.charter, plan.mapping);
  const now = new Date();
  await runAsDotCharter(loaded.charter, () =>
    runDotHousekeeping(loaded.charter, { now: () => new Date(), assertTenant })
  );
  await runFrontDeskExecutionIntake([loaded], { now: () => new Date(), assertTenant });
  await runDotExecutorStep(now, [loaded], { scopeToActiveCharters: true, assertTenant });
  return {
    status: 'supervisor_pass_completed',
    dot_id: plan.dot_id,
    first_job_url: plan.first_job_url,
    recovery:
      'No global lease recovery was run. Uncertain work remains held for operator inspection.',
    next_step:
      'Refresh the page. A pass is not proof of work completion and does not approve anything.',
  };
}

export async function main(args: string[] = [], print: (value: unknown) => void = () => undefined) {
  if (args.includes('--help') || args.includes('-h')) {
    print(
      'Usage: pnpm onboarding first-job --tenant <new-test-tenant> [--apply --accept-plan <digest> | --tick]. Default: read-only plan.'
    );
    return;
  }
  let tenant: string | undefined, accepted: string | undefined;
  let apply = false,
    tick = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tenant') tenant = args[++i];
    else if (args[i] === '--accept-plan') accepted = args[++i];
    else if (args[i] === '--apply') apply = true;
    else if (args[i] === '--tick') tick = true;
    else if (!['--json', '--dry-run'].includes(args[i]))
      throw new Error('first_job_unknown_argument');
  }
  if (!tenant) throw new Error('first_job_tenant_required');
  if (
    (apply && args.includes('--dry-run')) ||
    (!apply && accepted) ||
    (tick && (apply || accepted || args.includes('--dry-run')))
  )
    throw new Error('first_job_conflicting_mode');
  print(
    JSON.stringify(
      tick
        ? await tickFirstJob(tenant)
        : apply
          ? applyFirstJob(tenant, accepted ?? '')
          : planFirstJob(tenant),
      null,
      2
    )
  );
}
