import {
  buildOrganizationManagementView,
  buildOrganizationOperationRecord,
  buildOrganizationProjectLink,
  buildOrganizationCadence,
  buildOrganizationDecision,
  listOrganizationDecisions,
  listOrganizationIncidents,
  listOrganizationOperationalStates,
  reconcileOrganizationState,
} from '@agent/core/organization/organization-operating-model-management';
import {
  buildOrganizationDomainRecord,
  buildOrganizationLearningCandidate,
  buildOrganizationObjectiveAddition,
  buildOrganizationKeyResultAddition,
  buildOrganizationKeyResultRemoval,
  buildOrganizationPurposeRecord,
  buildOrganizationScaffold,
  buildOrganizationServiceAddition,
  buildOrganizationServiceState,
  ensureOrganizationOperationalState,
  enqueueOrganizationLearningCandidate,
  loadOrganizationOperation,
  listOrganizationOperationRuns,
  saveOrganizationOperation,
  saveOrganizationCadence,
  saveOrganizationDecision,
  loadOrganizationIncident,
  saveOrganizationIncident,
} from '@agent/core/organization/organization-operating-model-operations';
import { readOrganizationKrMeasurements } from '@agent/core/dot/dot-key-results';
import { rollUpObjectiveProgress } from '@agent/core/organization/organization-objective-progress';
import { formatObjectiveProgress } from './organization_objective_measure.js';
import {
  loadOrganizationOperatingModelCatalog,
  resolveOrganizationWork,
  saveOrganizationDomain,
  saveOrganizationOperationalState,
  saveOrganizationPurpose,
  saveOrganizationService,
  saveOrganizationServiceState,
  organizationOperationalStatePath,
  assertOrganizationParent,
  setOrganizationParent,
  transitionOrganizationLifecycle,
} from '@agent/core/organization/organization-operating-model-persistence';
import {
  removeOrganizationEntity,
  retireOrganizationEntity,
  type OrganizationTier,
} from '@agent/core/organization/organization-operating-model';
import { resolveScopeResolution } from '@agent/core/scope-context';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import {
  createOrganizationIncident,
  transitionOrganizationIncident,
  transitionOrganizationDecision,
} from '@agent/core/organization/organization-interventions';
import { verifyDecisionApprovalRef } from './organization_decision_approval.js';
import {
  defaultOperationRunId,
  recordOrganizationOperationRun,
  type OrganizationOperationRunOutcome,
} from '@agent/core/organization/organization-operation-run-recording';
import { validateWritePermission } from '@agent/core/tier-guard';
import type { KeyResultMetric } from '@agent/core/key-result-spec';
import type {
  OrganizationCadenceRecord,
  OrganizationDecisionRecord,
  OrganizationIncidentRecord,
  OrganizationManagementView,
  OrganizationOperationalState,
  OrganizationOperationRecord,
  OrganizationServiceRecord,
} from '@agent/core/organization/organization-operating-model';
import { defineScript, isDirectScript } from './lib/harness.js';

type Print = (value: unknown) => void;

import { parseArgs, usage, type ParsedArgs } from './organization_operating_model_args.js';

/** Organization state file an --apply write in this invocation targets; set per run. */
let writePreflightTarget: string | undefined;

function resolveWriteMode(parsed: ParsedArgs, command: string): 'dry_run' | 'apply' {
  if (parsed.dryRun === parsed.apply) {
    throw new Error(`Specify exactly one of --dry-run or --apply for ${command}.`);
  }
  if (parsed.apply && writePreflightTarget) {
    // Check the write authority before touching any record: a denied write
    // counts as a policy violation, and repeated violations trip the kill switch.
    const guard = validateWritePermission(writePreflightTarget);
    if (!guard.allowed) {
      throw new Error(
        `${command} --apply is not permitted for persona '${getRegisteredEnvText('KYBERION_PERSONA') || 'unknown'}' (${guard.reason}). ` +
          'Organization writes need KYBERION_PERSONA=sovereign, or MISSION_ROLE=organization_operator with KYBERION_TENANT set to this tenant; nothing was written.'
      );
    }
  }
  return parsed.apply ? 'apply' : 'dry_run';
}
function requireFlags(command: string, flags: Record<string, string | undefined>): void {
  const missing = Object.entries(flags)
    .filter(([, value]) => !value)
    .map(([flag]) => flag);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required for ${command}.`
    );
  }
}

let activePrint: Print = () => undefined;

function emit(value: unknown, json: boolean): void {
  if (json) {
    activePrint(JSON.stringify(value, null, 2));
    return;
  }
  activePrint(JSON.stringify(value, null, 2));
}

/**
 * Active objectives with their latest key-result progress. Measurements come
 * from `pnpm organization objective kr measure` or from dots attached to the
 * objective; a ledger that cannot be read degrades to the titles alone.
 */
function objectiveStatusLines(
  view: OrganizationManagementView,
  scope: { tier: string; tenantSlug?: string }
): string[] {
  const active = (view.purpose?.objectives || []).filter((entry) => entry.status === 'active');
  if (!active.length || !view.purpose) return [];
  const purpose = { ...view.purpose, objectives: active };
  const progressScope = {
    organizationId: view.organization_id,
    tier: scope.tier as OrganizationTier,
    ...(scope.tenantSlug ? { tenantSlug: scope.tenantSlug } : {}),
  };
  // Projects that name an objective are listed under it, so the status shows
  // which work is meant to move which goal.
  const withProjects = (objectiveIds: string[], lines: string[]) =>
    lines.flatMap((line, index) => {
      const projects = view.solution_projects.filter(
        (project) =>
          project.status !== 'archived' && project.objective_ids?.includes(objectiveIds[index]!)
      );
      return projects.length
        ? [
            line,
            `  Projects: ${projects.map((project) => `${project.name} (${project.status})`).join(', ')}`,
          ]
        : [line];
    });
  try {
    const progress = rollUpObjectiveProgress(progressScope, {
      readMeasurements: (s) => readOrganizationKrMeasurements(s),
      loadPurpose: () => purpose,
    });
    const lines = formatObjectiveProgress(progress);
    const unmeasured = lines.some((line) => line.includes('unmeasured'));
    const withLinks = withProjects(
      progress.objectives.map((objective) => objective.objective_id),
      lines
    );
    return unmeasured
      ? [
          ...withLinks,
          'Next: measure objective key results with pnpm organization objective kr measure ... --apply',
        ]
      : withLinks;
  } catch {
    return withProjects(
      active.map((objective) => objective.objective_id),
      active.map((objective) => `Objective: ${objective.title}`)
    );
  }
}

function printStatus(
  view: OrganizationManagementView,
  scope: { tier: string; tenantSlug?: string },
  relatives: {
    parent?: OrganizationOperationalState;
    subsidiaries: OrganizationOperationalState[];
  } = {
    subsidiaries: [],
  }
): void {
  const accounting = view.control_plane.accounting;
  activePrint(`${view.operational_state?.name || view.organization_id} (${view.organization_id})`);
  activePrint(`Scope: ${scope.tier} / ${scope.tenantSlug || 'shared'}`);
  const parentId = view.operational_state?.parent_organization_id;
  if (parentId) activePrint(`Parent: ${relatives.parent?.name || parentId} (${parentId})`);
  if (relatives.subsidiaries.length) {
    activePrint(
      `Subsidiaries: ${relatives.subsidiaries.map((entry) => `${entry.name} (${entry.organization_id})`).join(', ')}`
    );
  }
  activePrint(`Lifecycle: ${view.operational_state?.status || 'missing'}`);
  activePrint(`Purpose: ${view.readiness.purpose}`);
  activePrint(`Reconciliation: ${view.reconciliation.status}`);
  activePrint(
    `Work: ${accounting.active_projects} active / ${view.solution_projects.filter((project) => project.status === 'draft').length} draft projects, ${accounting.active_operations} operations, ${accounting.open_incidents} open incidents, ${accounting.pending_decisions} pending decisions`
  );
  for (const line of objectiveStatusLines(view, scope)) activePrint(line);
  for (const project of view.solution_projects.filter(
    (entry) => entry.status === 'active' || entry.status === 'draft'
  )) {
    activePrint(
      `Project: ${project.name} — ${project.status === 'draft' ? 'draft' : project.current_phase || 'phase unknown'}${project.state_updated_at ? ` (state updated ${project.state_updated_at})` : ''}`
    );
  }
  for (const decision of view.decisions.filter(
    (entry) => entry.status === 'proposed' || entry.status === 'pending_approval'
  )) {
    activePrint(`Decision: ${decision.title} — ${decision.status} (due ${decision.due_at})`);
  }
  for (const operation of view.operations.filter(
    (entry) => entry.status === 'active' || entry.status === 'draft'
  )) {
    const state = view.operation_states.find(
      (entry) => entry.operation_id === operation.operation_id
    );
    activePrint(
      `Operation: ${operation.name} — ${operation.status}, ${state ? `last run ${state.status} at ${state.last_run_at || state.updated_at}` : 'no run recorded'}, ${operation.execution_target.kind}${operation.execution_target.ref ? ` (${operation.execution_target.ref})` : ''}`
    );
  }
  activePrint(
    `Services: ${accounting.healthy_services}/${accounting.active_services} healthy with fresh observations`
  );
  if (view.reconciliation.services_without_state.length) {
    activePrint(`Unobserved services: ${view.reconciliation.services_without_state.join(', ')}`);
    activePrint(
      'Next: collect a timestamped service observation, then record it with pnpm organization service state set'
    );
  }
  if (accounting.pending_decisions > 0) {
    activePrint(
      'Next: review proposed decisions in the organization cadence before external action'
    );
  }
  if (view.reconciliation.operations_without_state.length) {
    activePrint(
      `Operations awaiting first evidence: ${view.reconciliation.operations_without_state.join(', ')}`
    );
  }
  if (
    view.reconciliation.status !== 'clean' &&
    !view.reconciliation.services_without_state.length &&
    accounting.pending_decisions === 0
  ) {
    activePrint('Next: pnpm organization reconcile --dry-run --json (with this scope selected)');
  }
}

type OrgEarlyCommandContext = { parsed: ReturnType<typeof parseArgs>; activePrint: Print };

const EARLY_ORGANIZATION_COMMAND_HANDLERS: Record<string, (ctx: OrgEarlyCommandContext) => void> = {
  help: (ctx) => {
    const { activePrint } = ctx;

    activePrint(usage());
    return;
  },
  model: (ctx) => {
    const { parsed } = ctx;

    emit(loadOrganizationOperatingModelCatalog(), parsed.json);
    return;
  },
};

type OrgCommandContext = {
  parsed: ReturnType<typeof parseArgs>;
  organizationId: string | undefined;
  readScope: { tier: OrganizationTier; tenantSlug: string | undefined };
  activePrint: Print;
};

type OrgCommandHandler = (ctx: OrgCommandContext) => void;

const handlePauseResumeArchive: OrgCommandHandler = (ctx) => {
  const { parsed, organizationId } = ctx;

  if (!organizationId) throw new Error(`--organization-id is required for ${parsed.command}.`);
  requireFlags(parsed.command, { '--tier': parsed.tier });
  const mode = resolveWriteMode(parsed, parsed.command);
  const next =
    mode === 'apply'
      ? transitionOrganizationLifecycle({
          organizationId,
          tier: parsed.tier!,
          tenantSlug: parsed.tenantSlug,
          verb: parsed.command as 'pause' | 'resume' | 'archive',
          reason: parsed.reason,
        })
      : {
          status: 'dry-run',
          verb: parsed.command,
          organization_id: organizationId,
          tier: parsed.tier,
          tenant_slug: parsed.tenantSlug,
          reason: parsed.reason,
        };
  emit({ mode, state: next }, parsed.json);
  return;
};

const handleRetireRemove: OrgCommandHandler = (ctx) => {
  const { parsed, organizationId } = ctx;

  if (!organizationId) throw new Error(`--organization-id is required for ${parsed.command}.`);
  requireFlags(parsed.command, {
    '--tier': parsed.tier,
    '--kind': parsed.recordKind,
    '--record-id': parsed.recordId,
  });
  const mode = resolveWriteMode(parsed, parsed.command);
  const next =
    mode === 'apply'
      ? parsed.command === 'retire'
        ? retireOrganizationEntity({
            organizationId,
            tier: parsed.tier!,
            tenantSlug: parsed.tenantSlug,
            kind: parsed.recordKind!,
            recordId: parsed.recordId!,
            reason: parsed.reason,
          })
        : removeOrganizationEntity({
            organizationId,
            tier: parsed.tier!,
            tenantSlug: parsed.tenantSlug,
            kind: parsed.recordKind!,
            recordId: parsed.recordId!,
            reason: parsed.reason,
          })
      : {
          status: 'dry-run',
          kind: parsed.recordKind,
          record_id: parsed.recordId,
          organization_id: organizationId,
          tier: parsed.tier,
          tenant_slug: parsed.tenantSlug,
          reason: parsed.reason,
        };
  emit({ mode, record: next }, parsed.json);
  return;
};

const handleProjectAttachProjectDetach: OrgCommandHandler = (ctx) => {
  const { parsed, organizationId } = ctx;

  if (!organizationId) throw new Error(`--organization-id is required for ${parsed.command}.`);
  requireFlags(parsed.command, { '--project-id': parsed.projectId });
  const mode = resolveWriteMode(parsed, parsed.command);
  const record = buildOrganizationProjectLink({
    organizationId,
    projectId: parsed.projectId!,
    tier: parsed.tier,
    tenantSlug: parsed.tenantSlug,
    detach: parsed.command === 'project detach',
  });
  const savedPaths = mode === 'apply' ? [saveOrganizationOperationalState(record)] : [];
  emit({ mode, state: record, saved_paths: savedPaths }, parsed.json);
  return;
};

const READ_VIEW_HANDLED: unique symbol = Symbol('read-view-handled');

type ReadViewResolver = (
  view: ReturnType<typeof buildOrganizationManagementView>,
  ctx: OrgCommandContext
) => unknown;

const READ_COMMAND_VIEWS: Record<string, ReadViewResolver> = {
  status: (view, { parsed, organizationId, readScope }) => {
    if (parsed.json) return view;
    const siblings = listOrganizationOperationalStates({
      tier: readScope.tier,
      tenantSlug: readScope.tenantSlug,
    });
    printStatus(view, readScope, {
      parent: siblings.find(
        (entry) => entry.organization_id === view.operational_state?.parent_organization_id
      ),
      subsidiaries: siblings.filter((entry) => entry.parent_organization_id === organizationId),
    });
    return READ_VIEW_HANDLED;
  },
  'domain list': (view) => view.domains,
  'service list': (view, { parsed }) =>
    parsed.health
      ? view.services.map((service) => ({
          service,
          state:
            view.service_states.find((state) => state.service_id === service.service_id) || null,
        }))
      : view.services,
  'operation list': (view, { parsed }) =>
    parsed.status
      ? view.operations.filter((operation) => operation.status === parsed.status)
      : view.operations,
  'project list': (view) => view.solution_projects,
  lineage: (view) => view.lineage,
  'cadence list': (view, { parsed }) =>
    parsed.status
      ? view.cadences.filter((cadence) => cadence.status === parsed.status)
      : view.cadences,
  'decision list': (view, { parsed }) => {
    // Ordered newest-first so "last meeting's decisions" is the head of the
    // list rather than something the reader has to scan for.
    const decisions = [...view.decisions].sort((left, right) =>
      left.updated_at < right.updated_at ? 1 : left.updated_at > right.updated_at ? -1 : 0
    );
    return [
      ...(parsed.cadenceId
        ? decisions.filter((decision) => decision.cadence_id === parsed.cadenceId)
        : decisions),
    ].filter(
      (decision) =>
        (!parsed.status || decision.status === parsed.status) &&
        (!parsed.decisionId || decision.decision_id === parsed.decisionId)
    );
  },
  'learning list': (view, { parsed }) =>
    parsed.status
      ? view.learning_candidates.filter((candidate) => candidate.status === parsed.status)
      : view.learning_candidates,
  'purpose show': (view) => view.purpose,
  'objective kr list': (view, { parsed }) =>
    (view.purpose?.objectives || [])
      .filter((objective) => !parsed.objectiveId || objective.objective_id === parsed.objectiveId)
      .map((objective) => ({
        objective_id: objective.objective_id,
        key_results: objective.key_results || [],
      })),
  show: (view) => view,
};

const handleReadCommand: OrgCommandHandler = (ctx) => {
  const { parsed, organizationId, readScope } = ctx;
  if (!organizationId) {
    throw new Error(
      'Select an organization with --organization-id or pnpm scope use --organization <id>.'
    );
  }
  const view = buildOrganizationManagementView({
    organizationId,
    tier: readScope.tier,
    tenantSlug: readScope.tenantSlug,
  });
  const result = READ_COMMAND_VIEWS[parsed.command]?.(view, ctx);
  if (result !== READ_VIEW_HANDLED) emit(result, parsed.json);
};

const ORGANIZATION_COMMAND_HANDLERS: Record<string, OrgCommandHandler> = {
  list: (ctx) => {
    const { parsed, readScope, activePrint } = ctx;

    const organizations = listOrganizationOperationalStates(readScope);
    if (parsed.json) emit(organizations, true);
    else if (!organizations.length) {
      activePrint(`No organizations in ${readScope.tier} / ${readScope.tenantSlug || 'shared'}.`);
    } else {
      for (const organization of organizations) {
        activePrint(
          `${organization.organization_id}\t${organization.status}\t${organization.name}`
        );
      }
    }
    return;
  },
  'work resolve': (ctx) => {
    const { parsed, organizationId, readScope } = ctx;

    if (!organizationId) {
      throw new Error(
        'Select an organization with --organization-id or pnpm scope use --organization <id>.'
      );
    }
    if (!parsed.intent) throw new Error('--intent is required for work resolve.');
    if (!parsed.dryRun) throw new Error('work resolve is read-only and requires --dry-run.');
    emit(
      resolveOrganizationWork({
        utterance: parsed.intent,
        organizationId,
        tier: readScope.tier,
        tenantSlug: readScope.tenantSlug,
      }),
      parsed.json
    );
    return;
  },
  reconcile: (ctx) => {
    const { parsed, organizationId, readScope } = ctx;

    if (!organizationId) {
      throw new Error(
        'Select an organization with --organization-id or pnpm scope use --organization <id>.'
      );
    }
    if (parsed.dryRun && parsed.apply) {
      throw new Error('--dry-run and --apply cannot be used together.');
    }
    // Reconcile stays a read-only preview by default; --apply goes through
    // the same write preflight as every other organization write.
    const mode = parsed.apply ? resolveWriteMode(parsed, 'reconcile') : 'dry_run';
    emit(
      reconcileOrganizationState({
        organizationId,
        tier: readScope.tier,
        tenantSlug: readScope.tenantSlug,
        apply: mode === 'apply',
      }),
      parsed.json
    );
    return;
  },
  'learning enqueue': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) {
      throw new Error(
        'Select an organization with --organization-id or pnpm scope use --organization <id>.'
      );
    }
    if (!parsed.tier) throw new Error('--tier is required for learning enqueue.');
    const mode = resolveWriteMode(parsed, 'learning enqueue');
    if (
      !parsed.learningId ||
      !parsed.sourceType ||
      !parsed.sourceRef ||
      !parsed.title ||
      !parsed.summary ||
      !parsed.targetKind
    ) {
      throw new Error(
        '--learning-id, --source-type, --source-ref, --title, --summary, and --target-kind are required.'
      );
    }
    const input = {
      learningId: parsed.learningId,
      organizationId,
      sourceType: parsed.sourceType,
      sourceRef: parsed.sourceRef,
      title: parsed.title,
      summary: parsed.summary,
      targetKind: parsed.targetKind,
      evidenceRefs: parsed.evidenceRefs,
      tier: parsed.tier,
      tenantSlug: parsed.tenantSlug,
    };
    emit(
      mode === 'apply'
        ? enqueueOrganizationLearningCandidate(input)
        : buildOrganizationLearningCandidate(input),
      parsed.json
    );
    return;
  },
  init: (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for init.');
    requireFlags('init', { '--name': parsed.name, '--tier': parsed.tier });
    const mode = resolveWriteMode(parsed, 'init');
    const scaffold = buildOrganizationScaffold({
      organizationId,
      name: parsed.name!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      purpose: parsed.purposeText,
      principles: parsed.principles,
      ownerRole: parsed.ownerRole,
      parentOrganizationId: parsed.parentOrganizationId,
    });
    const savedPaths: string[] = [];
    if (mode === 'apply') {
      savedPaths.push(saveOrganizationOperationalState(scaffold.state));
      if (scaffold.purpose) savedPaths.push(saveOrganizationPurpose(scaffold.purpose));
    }
    emit({ mode, ...scaffold, saved_paths: savedPaths }, parsed.json);
    return;
  },
  'parent set': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for parent set.');
    requireFlags('parent set', { '--tier': parsed.tier });
    if (Boolean(parsed.parentOrganizationId) === Boolean(parsed.clearParent)) {
      throw new Error('parent set requires exactly one of --parent-organization-id | --clear.');
    }
    const mode = resolveWriteMode(parsed, 'parent set');
    const parentOrganizationId = parsed.parentOrganizationId || null;
    if (mode === 'dry_run' && parentOrganizationId) {
      assertOrganizationParent({
        organizationId,
        parentOrganizationId,
        tier: parsed.tier!,
        tenantSlug: parsed.tenantSlug,
      });
    }
    const state =
      mode === 'apply'
        ? setOrganizationParent({
            organizationId,
            tier: parsed.tier!,
            tenantSlug: parsed.tenantSlug,
            parentOrganizationId,
          })
        : {
            organization_id: organizationId,
            tier: parsed.tier,
            tenant_slug: parsed.tenantSlug,
            parent_organization_id: parentOrganizationId,
          };
    emit({ mode, state }, parsed.json);
    return;
  },
  pause: handlePauseResumeArchive,
  resume: handlePauseResumeArchive,
  archive: handlePauseResumeArchive,
  retire: handleRetireRemove,
  remove: handleRetireRemove,
  'purpose set': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for purpose set.');
    requireFlags('purpose set', {
      '--name': parsed.name,
      '--tier': parsed.tier,
      '--purpose': parsed.purposeText,
      '--owner-role': parsed.ownerRole,
    });
    const mode = resolveWriteMode(parsed, 'purpose set');
    const record = buildOrganizationPurposeRecord({
      organizationId,
      name: parsed.name!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      purpose: parsed.purposeText!,
      principles: parsed.principles,
      ownerRole: parsed.ownerRole!,
      approvalState: parsed.approvalState,
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationPurpose(record)] : [];
    emit({ mode, purpose: record, saved_paths: savedPaths }, parsed.json);
    return;
  },
  'objective add': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for objective add.');
    requireFlags('objective add', {
      '--tier': parsed.tier,
      '--objective-id': parsed.objectiveId,
      '--title': parsed.title,
    });
    const mode = resolveWriteMode(parsed, 'objective add');
    const record = buildOrganizationObjectiveAddition({
      organizationId,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      objective: {
        objective_id: parsed.objectiveId!,
        title: parsed.title!,
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.horizon ? { horizon: parsed.horizon } : {}),
        status: 'active',
        ...(parsed.ownerRole ? { owner_role: parsed.ownerRole } : {}),
      },
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationPurpose(record)] : [];
    emit({ mode, purpose: record, saved_paths: savedPaths }, parsed.json);
    return;
  },
  'objective kr add': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for objective kr add.');
    requireFlags('objective kr add', {
      '--tier': parsed.tier,
      '--objective-id': parsed.objectiveId,
      '--kr-id': parsed.krId,
      '--title': parsed.title,
      '--metric-json': parsed.metricJson,
      '--direction': parsed.direction,
    });
    if (parsed.target === undefined || !Number.isFinite(parsed.target)) {
      throw new Error('--target <number> is required for objective kr add.');
    }
    let metric: KeyResultMetric;
    try {
      metric = JSON.parse(parsed.metricJson!) as KeyResultMetric;
    } catch {
      throw new Error('--metric-json must be valid JSON.');
    }
    const mode = resolveWriteMode(parsed, 'objective kr add');
    const record = buildOrganizationKeyResultAddition({
      organizationId,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      objectiveId: parsed.objectiveId!,
      keyResult: {
        kr_id: parsed.krId!,
        title: parsed.title!,
        metric,
        target: parsed.target,
        direction: parsed.direction!,
        ...(parsed.baseline !== undefined ? { baseline: parsed.baseline } : {}),
        ...(parsed.unit ? { unit: parsed.unit } : {}),
        ...(parsed.weight !== undefined ? { weight: parsed.weight } : {}),
      },
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationPurpose(record)] : [];
    emit({ mode, purpose: record, saved_paths: savedPaths }, parsed.json);
    return;
  },
  'objective kr remove': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for objective kr remove.');
    requireFlags('objective kr remove', {
      '--tier': parsed.tier,
      '--objective-id': parsed.objectiveId,
      '--kr-id': parsed.krId,
    });
    const mode = resolveWriteMode(parsed, 'objective kr remove');
    const record = buildOrganizationKeyResultRemoval({
      organizationId,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      objectiveId: parsed.objectiveId!,
      krId: parsed.krId!,
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationPurpose(record)] : [];
    emit({ mode, purpose: record, saved_paths: savedPaths }, parsed.json);
    return;
  },
  'domain add': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for domain add.');
    requireFlags('domain add', {
      '--tier': parsed.tier,
      '--domain-id': parsed.domainId,
      '--name': parsed.name,
      '--owner-role': parsed.ownerRole,
    });
    const mode = resolveWriteMode(parsed, 'domain add');
    const record = buildOrganizationDomainRecord({
      organizationId,
      domainId: parsed.domainId!,
      name: parsed.name!,
      ownerRole: parsed.ownerRole!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      purpose: parsed.purposeText,
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationDomain(record)] : [];
    emit({ mode, domain: record, saved_paths: savedPaths }, parsed.json);
    return;
  },
  'service add': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for service add.');
    requireFlags('service add', {
      '--tier': parsed.tier,
      '--service-id': parsed.serviceId,
      '--domain-id': parsed.domainId,
      '--name': parsed.name,
      '--outcome': parsed.outcome,
      '--owner-role': parsed.ownerRole,
    });
    const mode = resolveWriteMode(parsed, 'service add');
    const addition = buildOrganizationServiceAddition({
      organizationId,
      serviceId: parsed.serviceId!,
      domainId: parsed.domainId!,
      name: parsed.name!,
      outcome: parsed.outcome!,
      ownerRole: parsed.ownerRole!,
      consumers: parsed.consumers,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      sloTarget: parsed.sloTarget,
      sloWindow: parsed.sloWindow,
      runbookRefs: parsed.runbookRefs,
      status: parsed.recordStatus as OrganizationServiceRecord['status'] | undefined,
    });
    const savedPaths =
      mode === 'apply'
        ? [saveOrganizationService(addition.service), saveOrganizationDomain(addition.domain)]
        : [];
    emit({ mode, ...addition, saved_paths: savedPaths }, parsed.json);
    return;
  },
  'cadence add': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for cadence add.');
    requireFlags('cadence add', {
      '--tier': parsed.tier,
      '--cadence-id': parsed.cadenceId,
      '--name': parsed.name,
      '--cadence-type': parsed.cadenceType,
      '--schedule': parsed.schedule,
      '--owner-role': parsed.ownerRole,
    });
    const mode = resolveWriteMode(parsed, 'cadence add');
    const record = buildOrganizationCadence({
      organizationId,
      cadenceId: parsed.cadenceId!,
      name: parsed.name!,
      cadenceType: parsed.cadenceType!,
      schedule: parsed.schedule!,
      ownerRole: parsed.ownerRole!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      status: parsed.recordStatus as OrganizationCadenceRecord['status'] | undefined,
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationCadence(record)] : [];
    emit({ mode, cadence: record, saved_paths: savedPaths }, parsed.json);
    return;
  },
  'decision add': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for decision add.');
    requireFlags('decision add', {
      '--tier': parsed.tier,
      '--decision-id': parsed.decisionId,
      '--cadence-id': parsed.cadenceId,
      '--title': parsed.title,
      '--decision-owner': parsed.decisionOwner,
      '--due-at': parsed.dueAt,
    });
    const mode = resolveWriteMode(parsed, 'decision add');
    if (parsed.recordStatus && parsed.recordStatus !== 'proposed')
      throw new Error(
        "New decisions must start as proposed (omit --record-status or pass 'proposed'); then advance with " +
          "'decision transition': proposed -> pending_approval -> approved (-> implemented), " +
          "with 'deferred' as a side branch and 'rejected' as terminal. " +
          'Approving also requires --rationale and --approval-ref <channel:id>.'
      );
    if (
      listOrganizationDecisions({
        organizationId,
        tier: parsed.tier,
        tenantSlug: parsed.tenantSlug,
      }).some((entry) => entry.decision_id === parsed.decisionId)
    )
      throw new Error(`Decision already exists: ${parsed.decisionId}`);
    const addition = buildOrganizationDecision({
      organizationId,
      decisionId: parsed.decisionId!,
      cadenceId: parsed.cadenceId!,
      title: parsed.title!,
      decisionOwner: parsed.decisionOwner!,
      dueAt: parsed.dueAt!,
      options: parsed.options,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      decisionType: parsed.decisionType,
      status: parsed.recordStatus as OrganizationDecisionRecord['status'] | undefined,
      requestedBy: parsed.requestedBy,
      chosenOption: parsed.chosenOption,
      rationale: parsed.rationale,
      followUpRefs: parsed.followUpRefs,
    });
    const savedPaths =
      mode === 'apply'
        ? [saveOrganizationDecision(addition.decision), saveOrganizationCadence(addition.cadence)]
        : [];
    emit({ mode, ...addition, saved_paths: savedPaths }, parsed.json);
    return;
  },
  'incident add': (ctx) => {
    const { parsed, organizationId } = ctx;

    requireFlags('incident add', {
      '--organization-id': organizationId,
      '--tier': parsed.tier,
      '--incident-id': parsed.incidentId,
      '--title': parsed.title,
      '--severity': parsed.severity,
      '--owner-role': parsed.ownerRole,
      '--impact-summary': parsed.impactSummary,
    });
    const mode = resolveWriteMode(parsed, 'incident add');
    if (
      loadOrganizationIncident(parsed.incidentId!, {
        organizationId: organizationId!,
        tier: parsed.tier,
        tenantSlug: parsed.tenantSlug,
      })
    )
      throw new Error(`Incident already exists: ${parsed.incidentId}`);
    const incident = createOrganizationIncident({
      incidentId: parsed.incidentId!,
      organizationId: organizationId!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      title: parsed.title!,
      severity: parsed.severity!,
      ownerRole: parsed.ownerRole!,
      impactSummary: parsed.impactSummary!,
      serviceId: parsed.serviceId,
      operationId: parsed.operationId,
    });
    emit(
      {
        mode,
        incident,
        saved_path: mode === 'apply' ? saveOrganizationIncident(incident) : null,
      },
      parsed.json
    );
    return;
  },
  'incident transition': (ctx) => {
    const { parsed, organizationId } = ctx;

    requireFlags('incident transition', {
      '--organization-id': organizationId,
      '--tier': parsed.tier,
      '--incident-id': parsed.incidentId,
      '--record-status': parsed.recordStatus,
    });
    const mode = resolveWriteMode(parsed, 'incident transition');
    const current = loadOrganizationIncident(parsed.incidentId!, {
      organizationId: organizationId!,
      tier: parsed.tier,
      tenantSlug: parsed.tenantSlug,
    });
    if (!current) throw new Error(`Incident not found: ${parsed.incidentId}`);
    if (parsed.recordStatus === 'closed') {
      const reviewRef = parsed.postIncidentReviewRef || current.post_incident_review_ref || '';
      const prefix =
        current.tier === 'confidential'
          ? `knowledge/confidential/${current.tenant_slug}/`
          : current.tier === 'personal'
            ? current.tenant_slug
              ? `knowledge/personal/${current.tenant_slug}/`
              : ''
            : 'knowledge/public/';
      if (
        !prefix ||
        !reviewRef.startsWith(prefix) ||
        reviewRef.includes('\\') ||
        reviewRef.split('/').includes('..') ||
        !safeExistsSync(pathResolver.rootResolve(reviewRef))
      )
        throw new Error(
          'Closing an incident requires an existing review in the same knowledge tier and tenant.'
        );
    }
    const incident = transitionOrganizationIncident(
      current,
      parsed.recordStatus as OrganizationIncidentRecord['status'],
      {
        impactSummary: parsed.impactSummary,
        mitigationMissionId: parsed.mitigationMissionId,
        postIncidentReviewRef: parsed.postIncidentReviewRef,
      }
    );
    emit(
      {
        mode,
        incident,
        saved_path: mode === 'apply' ? saveOrganizationIncident(incident) : null,
      },
      parsed.json
    );
    return;
  },
  'decision transition': (ctx) => {
    const { parsed, organizationId } = ctx;

    requireFlags('decision transition', {
      '--organization-id': organizationId,
      '--tier': parsed.tier,
      '--decision-id': parsed.decisionId,
      '--record-status': parsed.recordStatus,
    });
    const mode = resolveWriteMode(parsed, 'decision transition');
    const current = listOrganizationDecisions({
      organizationId: organizationId!,
      tier: parsed.tier,
      tenantSlug: parsed.tenantSlug,
    }).find((decision) => decision.decision_id === parsed.decisionId);
    if (!current) throw new Error(`Decision not found: ${parsed.decisionId}`);
    const target = parsed.recordStatus as OrganizationDecisionRecord['status'];
    const approvalRef =
      target === 'approved' || target === 'rejected'
        ? verifyDecisionApprovalRef(parsed.approvalRef, current, target)
        : undefined;
    const decision = transitionOrganizationDecision(current, target, {
      chosenOption: parsed.chosenOption,
      rationale: parsed.rationale,
      approvalRef,
      followUpRefs: parsed.followUpRefs,
    });
    emit(
      {
        mode,
        decision,
        saved_path: mode === 'apply' ? saveOrganizationDecision(decision) : null,
      },
      parsed.json
    );
    return;
  },
  'incident list': (ctx) => {
    const { parsed, organizationId, readScope } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for incident list.');
    emit(
      listOrganizationIncidents({
        organizationId,
        tier: readScope.tier,
        tenantSlug: readScope.tenantSlug,
      }).filter((incident) => !parsed.incidentId || incident.incident_id === parsed.incidentId),
      parsed.json
    );
    return;
  },
  'state ensure': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for state ensure.');
    requireFlags('state ensure', { '--tier': parsed.tier });
    const mode = resolveWriteMode(parsed, 'state ensure');
    const result = ensureOrganizationOperationalState({
      organizationId,
      name: parsed.name,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
    });
    const savedPaths =
      mode === 'apply' && !result.already_present
        ? [saveOrganizationOperationalState(result.state)]
        : [];
    emit(
      {
        mode,
        already_present: result.already_present,
        state: result.state,
        saved_paths: savedPaths,
      },
      parsed.json
    );
    return;
  },
  'service state set': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for service state set.');
    requireFlags('service state set', {
      '--tier': parsed.tier,
      '--service-id': parsed.serviceId,
      '--health-status': parsed.healthStatus,
    });
    const mode = resolveWriteMode(parsed, 'service state set');
    const state = buildOrganizationServiceState({
      organizationId,
      serviceId: parsed.serviceId!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      health: parsed.healthStatus!,
      reconcileStatus: parsed.reconcileStatus,
      freshnessSeconds: parsed.freshnessSeconds,
      confidence: parsed.confidence,
      sourceTimestamp: parsed.sourceTimestamp,
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationServiceState(state)] : [];
    emit({ mode, service_state: state, saved_paths: savedPaths }, parsed.json);
    return;
  },
  'operation add': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for operation add.');
    // Presets shrink the required flag surface for the common shapes (dogfood
    // showed a first `operation add` needed 8+ flags). `runbook`: an
    // event-driven op whose execution target is a governed runbook doc —
    // --execution-ref stays required (validated against the operation scope).
    const preset = parsed.preset?.trim().toLowerCase();
    if (preset && preset !== 'runbook') {
      throw new Error(`Unknown --preset '${parsed.preset}'. Supported: runbook`);
    }
    const presetDefaults =
      preset === 'runbook'
        ? {
            operationType: 'event_driven' as const,
            ownerRole: 'operator',
            executionKind: 'runbook' as const,
          }
        : {};
    const operationType = parsed.operationType ?? presetDefaults.operationType;
    const ownerRole = parsed.ownerRole ?? presetDefaults.ownerRole;
    const executionKind = parsed.executionKind ?? presetDefaults.executionKind;
    requireFlags('operation add', {
      '--tier': parsed.tier,
      '--operation-id': parsed.operationId,
      '--name': parsed.name,
      '--operation-type': operationType,
      '--owner-role': ownerRole,
    });
    const mode = resolveWriteMode(parsed, 'operation add');
    const record = buildOrganizationOperationRecord({
      organizationId,
      operationId: parsed.operationId!,
      name: parsed.name!,
      operationType: operationType!,
      ownerRole: ownerRole!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      serviceId: parsed.serviceId,
      purpose: parsed.purposeText,
      triggerKind: parsed.triggerKind,
      triggerExpression: parsed.triggerExpression,
      triggerTimezone: parsed.triggerTimezone,
      deadline:
        parsed.deadlineBusinessDay !== undefined || parsed.deadlineTime
          ? {
              kind: 'business_day_of_month',
              business_day: parsed.deadlineBusinessDay!,
              time: parsed.deadlineTime!,
            }
          : undefined,
      executionKind,
      executionRef: parsed.executionRef,
      evidenceOutputs: parsed.evidenceOutputs,
      allowedActions: parsed.allowedActions,
      approvalRequiredActions: parsed.approvalRequiredActions,
      forbiddenActions: parsed.forbiddenActions,
      sourceRefs: parsed.operationSourceRefs,
      status: parsed.recordStatus as OrganizationOperationRecord['status'] | undefined,
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationOperation(record)] : [];
    emit({ mode, operation: record, saved_paths: savedPaths }, parsed.json);
    return;
  },
  'operation run record': (ctx) => {
    const { parsed, organizationId } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for operation run record.');
    requireFlags('operation run record', {
      '--tier': parsed.tier,
      '--operation-id': parsed.operationId,
      '--run-id': parsed.runId,
      '--run-status': parsed.runStatus,
      '--result-summary': parsed.resultSummary,
    });
    const mode = resolveWriteMode(parsed, 'operation run record');
    const result = recordOrganizationOperationRun({
      organizationId,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      operationId: parsed.operationId!,
      runId: parsed.runId!,
      runStatus: parsed.runStatus as OrganizationOperationRunOutcome,
      resultSummary: parsed.resultSummary!,
      evidenceRefs: parsed.evidenceRefs,
      exceptionRefs: parsed.exceptionRefs,
      executionRef: parsed.executionRef,
      startedAt: parsed.startedAt,
      completedAt: parsed.completedAt,
      apply: mode === 'apply',
    });
    emit({ mode, ...result }, parsed.json);
    return;
  },
  'operation done': (ctx) => {
    const { parsed, organizationId, readScope } = ctx;

    if (!organizationId)
      throw new Error(
        '--organization-id is required for operation done (or select one with pnpm scope use).'
      );
    requireFlags('operation done', { '--operation-id': parsed.operationId });
    const tier = (parsed.tier || readScope.tier) as 'personal' | 'confidential' | 'public';
    const tenantSlug = parsed.tenantSlug || readScope.tenantSlug;
    const mode = resolveWriteMode(parsed, 'operation done');
    const scope = { organizationId, tier, tenantSlug };
    const operation = loadOrganizationOperation(parsed.operationId!, scope);
    if (!operation) throw new Error(`Organization operation not found: ${parsed.operationId}`);
    // An operator-attested completion of a runbook cites the runbook it followed.
    const evidenceRefs = parsed.evidenceRefs.length
      ? parsed.evidenceRefs
      : operation.execution_target.kind === 'runbook' && operation.execution_target.ref
        ? [operation.execution_target.ref]
        : [];
    if (!evidenceRefs.length) {
      throw new Error(
        'operation done needs --evidence-ref unless the operation targets a runbook.'
      );
    }
    const runId =
      parsed.runId ||
      defaultOperationRunId(
        operation,
        new Set(listOrganizationOperationRuns(scope).map((run) => run.run_id))
      );
    const result = recordOrganizationOperationRun({
      ...scope,
      operationId: operation.operation_id,
      runId,
      autoSuffixRunId: !parsed.runId,
      runStatus: 'succeeded',
      resultSummary: parsed.resultSummary || '完了（運用者申告）',
      evidenceRefs,
      apply: mode === 'apply',
    });
    emit({ mode, ...result }, parsed.json);
    return;
  },
  'operation run list': (ctx) => {
    const { parsed, organizationId, readScope } = ctx;

    if (!organizationId) throw new Error('--organization-id is required for operation run list.');
    const runs = listOrganizationOperationRuns({
      organizationId,
      tier: readScope.tier,
      tenantSlug: readScope.tenantSlug,
    }).filter((run) => !parsed.operationId || run.operation_id === parsed.operationId);
    emit(runs, parsed.json);
    return;
  },
  'project attach': handleProjectAttachProjectDetach,
  'project detach': handleProjectAttachProjectDetach,
  show: handleReadCommand,
  status: handleReadCommand,
  'purpose show': handleReadCommand,
  'objective kr list': handleReadCommand,
  'domain list': handleReadCommand,
  'service list': handleReadCommand,
  'operation list': handleReadCommand,
  'project list': handleReadCommand,
  lineage: handleReadCommand,
  'cadence list': handleReadCommand,
  'decision list': handleReadCommand,
  'learning list': handleReadCommand,
};

export function runOrganizationOperatingModelCli(
  args: string[] = [],
  print: Print = () => undefined
): void {
  const previousPrint = activePrint;
  activePrint = print;
  try {
    const parsed = parseArgs(args);
    const earlyHandler = EARLY_ORGANIZATION_COMMAND_HANDLERS[parsed.command];
    if (earlyHandler) {
      earlyHandler({ parsed, activePrint });
      return;
    }
    const currentScope = resolveScopeResolution().scope;
    const organizationId = parsed.organizationId || currentScope.organization_id;
    const readScope = {
      tier: parsed.tier || currentScope.tier,
      tenantSlug: parsed.tenantSlug || currentScope.tenant_slug,
    };
    writePreflightTarget =
      organizationId && (parsed.tier || readScope.tier)
        ? organizationOperationalStatePath(
            organizationId,
            (parsed.tier || readScope.tier) as 'personal' | 'confidential' | 'public',
            parsed.tenantSlug || readScope.tenantSlug || 'shared'
          )
        : undefined;
    if (readScope.tier !== 'public' && !readScope.tenantSlug) {
      throw new Error(
        `A tenant is required for ${readScope.tier} organization scope. Pass --tenant-slug or select one with pnpm scope use.`
      );
    }
    {
      const handler = ORGANIZATION_COMMAND_HANDLERS[parsed.command];
      if (handler) {
        handler({ parsed, organizationId, readScope, activePrint });
        return;
      }
    }

    throw new Error(`Unknown command '${parsed.command}'.\n${usage()}`);
  } finally {
    activePrint = previousPrint;
  }
}

export const runOrganizationOperatingModel = defineScript({
  name: 'organization:operating-model',
  flags: [],
  run: ({ argv, print }) => runOrganizationOperatingModelCli(argv, print),
});

if (
  isDirectScript(import.meta.url, 'organization_operating_model.ts') ||
  isDirectScript(import.meta.url, 'organization_operating_model.js')
)
  void runOrganizationOperatingModel();
