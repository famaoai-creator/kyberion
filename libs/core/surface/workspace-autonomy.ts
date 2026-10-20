/** Workspace controls narrow existing dot ownership; they never confer tool authority. */
import { listDotCharters, type DotCharter } from '../dot/dot-charter.js';
import {
  checkDotActivationReadiness,
  transitionDotCharterStatus,
  type DotLifecycleDeps,
} from '../dot/dot-lifecycle.js';
import { evaluateDotBudget } from '../dot/dot-budget.js';
import type { SurfaceViewerScope } from './surface-viewer-scope-contract.js';
import { SurfaceViewerScopeError } from './surface-viewer-scope-contract.js';
import type { ResolvedWorkspaceSelection } from './workspace-scope.js';
import type { WorkspaceDotSummary, WorkspaceOverview } from './workspace.js';
import { dotAdmissionScopeHash } from '../dot/dot-admission-identity.js';

export function workspaceOwnsDot(
  selection: ResolvedWorkspaceSelection,
  charter: DotCharter
): boolean {
  // Org cadence supervises multiple operations. It must never appear to be a
  // single operation's stop switch without an explicit canonical binding.
  if (!selection.tenant_slug && !selection.project_id && !selection.organization_id) return false;
  return (
    charter.scope.tenant_slug === selection.tenant_slug &&
    charter.scope.organization_id === selection.organization_id &&
    charter.scope.project_id === selection.project_id &&
    charter.work_binding?.operation_id === selection.operation_id &&
    (!selection.tier || charter.scope.tier === selection.tier)
  );
}

export function workspaceViewerCanReadDot(
  viewer: SurfaceViewerScope,
  charter: DotCharter
): boolean {
  const permits = (allowed: string[] | 'all', id: string | undefined) =>
    allowed === 'all' || Boolean(id && allowed.includes(id));
  return (
    permits(viewer.tenantSlugs, charter.scope.tenant_slug) &&
    permits(viewer.organizationIds, charter.scope.organization_id) &&
    permits(viewer.projectIds, charter.scope.project_id) &&
    viewer.tierAccess.includes(charter.scope.tier)
  );
}

export interface WorkspaceAutonomyDeps extends DotLifecycleDeps {
  charters?: () => DotCharter[];
  readiness?: typeof checkDotActivationReadiness;
  budget?: typeof evaluateDotBudget;
  transition?: typeof transitionDotCharterStatus;
}

export function readWorkspaceAutonomy(
  selection: ResolvedWorkspaceSelection,
  viewer: SurfaceViewerScope,
  deps: WorkspaceAutonomyDeps = {}
): WorkspaceOverview['autonomy'] {
  const blockedReasons: string[] = [];
  if (!selection.tenant_slug && !selection.project_id && !selection.organization_id)
    blockedReasons.push(
      'Select a tenant, organization or project to inspect its autonomous loops.'
    );
  const charters = (
    deps.charters?.() ?? listDotCharters(deps.rootDir).map((source) => source.charter)
  ).filter(
    (charter) => workspaceOwnsDot(selection, charter) && workspaceViewerCanReadDot(viewer, charter)
  );
  const dots: WorkspaceDotSummary[] = charters.map((charter) => {
    const readiness = (deps.readiness ?? checkDotActivationReadiness)(charter, deps);
    // A project-limited viewer cannot inspect aggregate sibling spending.
    const canReadBudget =
      ['public', 'confidential', 'personal'].every((tier) =>
        viewer.tierAccess.includes(tier as 'public' | 'confidential' | 'personal')
      ) &&
      viewer.projectIds === 'all' &&
      (Boolean(charter.scope.organization_id) || viewer.organizationIds === 'all');
    const evaluation = canReadBudget ? (deps.budget ?? evaluateDotBudget)(charter, deps) : null;
    return {
      id: charter.dot_id,
      name: charter.title,
      status: charter.status,
      goal: charter.goal.statement,
      // Full collision diagnostics can name another tenant's dot. The canonical
      // operator CLI retains them; this scoped projection exposes only a code.
      readiness: readiness.ready
        ? { ready: true, errors: [] }
        : {
            ready: false,
            errors: [
              'DOT_ACTIVATION_BLOCKED: inspect governed dot validation with an authorized operator.',
            ],
          },
      budget: evaluation
        ? {
            throttle: evaluation.throttle,
            tokens: evaluation.usage.tokens,
            costUsd: evaluation.usage.cost_usd,
            ...(evaluation.usage.cost_status ? { costStatus: evaluation.usage.cost_status } : {}),
            scope: charter.scope.organization_id
              ? 'organization'
              : charter.scope.tenant_slug
                ? 'tenant'
                : 'system',
          }
        : null,
    };
  });
  if (!dots.length && !blockedReasons.length)
    blockedReasons.push(
      'No exact-scope dot is configured. Create a scoped draft with the governed dot facade (operations require work_binding.operation_id); activate only after readiness checks.'
    );
  return { dots, pauseMeaning: 'future_wakeups_only', blockedReasons };
}

export function controlWorkspaceAutonomy(
  selection: ResolvedWorkspaceSelection,
  viewer: SurfaceViewerScope,
  input: { dot_id: string; action: 'pause' | 'resume' | 'activate' },
  deps: WorkspaceAutonomyDeps = {}
): DotCharter {
  if (viewer.role !== 'localadmin')
    throw new SurfaceViewerScopeError(403, 'Autonomy control requires an authorized operator.');
  const charter = (
    deps.charters?.() ?? listDotCharters(deps.rootDir).map((source) => source.charter)
  ).find(
    (candidate) =>
      candidate.dot_id === input.dot_id &&
      workspaceOwnsDot(selection, candidate) &&
      workspaceViewerCanReadDot(viewer, candidate)
  );
  if (!charter)
    throw new SurfaceViewerScopeError(403, 'Dot is unavailable in the selected workplace.');
  if (
    (input.action === 'pause' && charter.status !== 'active') ||
    (input.action === 'resume' && charter.status !== 'paused') ||
    (input.action === 'activate' && charter.status !== 'draft')
  )
    throw new Error('Autonomy changed; refresh the workplace before retrying.');
  return (deps.transition ?? transitionDotCharterStatus)(
    charter.dot_id,
    input.action === 'pause' ? 'paused' : 'active',
    {
      ...deps,
      expectedScope: charter.scope,
      expectedStatus: charter.status,
      expectedAdmissionScopeHash: dotAdmissionScopeHash(charter),
    }
  );
}
