import { getProjectManagementView } from '@agent/core/project/project-management';
import { loadProjectRecord } from '@agent/core/project/project-registry';
import { resolveScopeContext } from '@agent/core/scope-context';
import { observePipelineScheduleDependencies } from '@agent/core/organization/continuous-operations-sources';

type ProjectView = ReturnType<typeof getProjectManagementView>;

const rules = [
  {
    id: 'blocked_work',
    title: 'Review blocked work',
    matches: (item: ProjectView['work_items'][number]) => item.status === 'blocked',
  },
  {
    id: 'waiting_review',
    title: 'Review the review queue',
    matches: (item: ProjectView['work_items'][number]) => item.status === 'review',
  },
] as const;

/** Read-only project adapter. Uses the managed project view's access checks and scoped records. */
export function previewProjectOuterLoop(
  projectId: string,
  deps: {
    view?: typeof getProjectManagementView;
    project?: typeof loadProjectRecord;
    schedules?: typeof observePipelineScheduleDependencies;
    rootDir?: string;
    selectedScope?: ReturnType<typeof resolveScopeContext>;
    now?: Date;
  } = {}
) {
  const selected = deps.selectedScope ?? resolveScopeContext();
  const project = (deps.project ?? loadProjectRecord)(projectId, { rootDir: deps.rootDir });
  const scopeMatches = (record: ProjectView['project']) =>
    record.project_id === projectId &&
    selected.tier === record.tier &&
    selected.tenant_slug === record.tenant_slug &&
    selected.organization_id === record.organization_id &&
    (!selected.project_id || selected.project_id === record.project_id);
  if (!project || !scopeMatches(project))
    throw new Error(
      'Select the matching project tier, tenant and organization with pnpm scope use.'
    );
  const view = (deps.view ?? getProjectManagementView)(projectId, deps.rootDir);
  if (!scopeMatches(view.project))
    throw new Error('Project scope changed while collecting observations.');
  if (view.project.status !== project.status)
    throw new Error('Project status changed while collecting observations.');

  const missionIds = new Set(
    [...view.missions, ...view.archived_missions].map((mission) => mission.mission_id)
  );
  const items = view.work_items.filter(
    ({ context }) =>
      context?.project_id === project.project_id &&
      context.tenant_slug === project.tenant_slug &&
      context.organization_id === project.organization_id &&
      (!context.mission_id || missionIds.has(context.mission_id))
  );
  const enabled = project.status === 'active';
  const now = deps.now ?? new Date();
  const observedAt = now.toISOString();
  const scheduleObservation = (() => {
    if (!enabled) return { status: 'held', rows: [] } as const;
    try {
      return {
        status: 'available',
        rows: (deps.schedules ?? observePipelineScheduleDependencies)(
          project,
          project.pipeline_refs ?? [],
          {
            rootDir: deps.rootDir,
            now,
          }
        ),
      } as const;
    } catch {
      return { status: 'unavailable', rows: [] } as const;
    }
  })();
  const failing = scheduleObservation.rows.filter(({ status }) => status === 'failing');
  return {
    scope: {
      project_id: project.project_id,
      tier: project.tier,
      ...(project.tenant_slug ? { tenant_slug: project.tenant_slug } : {}),
      ...(project.organization_id ? { organization_id: project.organization_id } : {}),
    },
    status: enabled ? 'observation_only' : 'awaiting_active_project',
    admission: {
      status: 'held',
      reason: 'project_outer_loop_execution_policy_required',
      required: [
        'project_responsibility_binding',
        'applicable_budget',
        'operation_approval_policy',
      ],
    },
    policy_scope: project.organization_id
      ? 'organization'
      : project.tenant_slug
        ? 'tenant'
        : 'unbound',
    observed_at: observedAt,
    observed_work_items: items.length,
    schedule_observation: scheduleObservation,
    candidates: enabled
      ? [
          ...rules.flatMap(({ id, title, matches }) => {
            const matching = items.filter(matches);
            return matching.length
              ? [
                  {
                    rule_id: id,
                    title,
                    count: matching.length,
                    evidence_refs: matching
                      .map(({ item_id }) => item_id)
                      .sort()
                      .slice(0, 20)
                      .map((id) => `workitem:${id}`),
                  },
                ]
              : [];
          }),
          ...(failing.length
            ? [
                {
                  rule_id: 'failing_pipeline_schedules',
                  title: 'Investigate failing scheduled pipeline dependencies',
                  count: failing.length,
                  evidence_refs: failing
                    .slice(0, 20)
                    .map(({ schedule_id }) => `schedule:${schedule_id}`),
                },
              ]
            : []),
        ]
      : [],
  };
}
