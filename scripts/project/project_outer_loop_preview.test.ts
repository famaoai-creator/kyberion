import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ProjectManagementView } from '@agent/core/project/project-management';
import { projectRecordPath } from '@agent/core/project/project-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { previewProjectOuterLoop } from './project_outer_loop_preview.js';

const scope = { tier: 'confidential', tenant_slug: 'acme', project_id: 'PRJ-LOOP' } as const;

function fixture(status: ProjectManagementView['project']['status'] = 'active') {
  const project = { ...scope, status, name: 'Loop', summary: 'Improve operations' };
  const context = { tenant_slug: scope.tenant_slug, project_id: scope.project_id };
  const view = vi.fn(
    () =>
      ({
        project,
        missions: [],
        archived_missions: [],
        work_items: [
          { item_id: 'WI-1', status: 'blocked', context },
          { item_id: 'WI-2', status: 'review', context },
          { item_id: 'WI-OTHER', status: 'blocked', context: { ...context, tenant_slug: 'other' } },
          {
            item_id: 'WI-ORG',
            status: 'blocked',
            context: { ...context, organization_id: 'other' },
          },
          {
            item_id: 'WI-MISSION',
            status: 'blocked',
            context: { ...context, mission_id: 'hidden' },
          },
          { item_id: 'WI-LEGACY', status: 'review', project_id: scope.project_id },
        ],
      }) as unknown as ProjectManagementView
  );
  return {
    view,
    project: () => project,
    selectedScope: scope,
    now: new Date('2026-11-22T00:00:00Z'),
  };
}

describe('project Outer Loop preview', () => {
  it('adds a candidate for a failing scheduled dependency and keeps admission held', () => {
    const deps = fixture();
    const ref = 'knowledge/confidential/acme/pipelines/check.json';
    const schedules = vi.fn(() => [
      {
        schedule_id: 'check',
        pipeline_ref: ref,
        relationship: 'scheduled_dependency' as const,
        registration: 'enabled',
        execution_eligibility: 'chronos_policy_unobserved',
        last_result: 'failed' as const,
        timing_due: false,
        potentially_due: false,
        status: 'failing',
        last_run_at: null,
      },
    ]);
    const report = previewProjectOuterLoop(scope.project_id, {
      ...deps,
      project: () => ({ ...deps.project(), pipeline_refs: [ref] }),
      schedules,
    });
    expect(schedules).toHaveBeenCalledWith(
      expect.objectContaining(scope),
      [ref],
      expect.anything()
    );
    expect(report.admission.status).toBe('held');
    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        rule_id: 'failing_pipeline_schedules',
        evidence_refs: ['schedule:check'],
      })
    );
  });
  it('reads a real standalone Project record in an isolated workspace', () => {
    const rootDir = pathResolver.sharedTmp('project-loop-preview-' + randomUUID());
    const project = {
      project_id: 'PRJ-PREVIEW',
      tier: 'public',
      status: 'active',
      name: 'Preview',
      summary: 'Project without an organization.',
    } as const;
    try {
      safeWriteFile(projectRecordPath(project.project_id, rootDir), JSON.stringify(project));
      expect(
        previewProjectOuterLoop(project.project_id, {
          rootDir,
          selectedScope: { tier: 'public', project_id: project.project_id },
        })
      ).toMatchObject({ status: 'observation_only', policy_scope: 'unbound', candidates: [] });
    } finally {
      safeRmSync(rootDir, { recursive: true, force: true });
    }
  });
  it('observes an organization-less project and keeps admission held', () => {
    expect(previewProjectOuterLoop(scope.project_id, fixture())).toMatchObject({
      scope,
      status: 'observation_only',
      policy_scope: 'tenant',
      admission: { status: 'held' },
      candidates: [
        { rule_id: 'blocked_work', count: 1, evidence_refs: ['workitem:WI-1'] },
        { rule_id: 'waiting_review', count: 1, evidence_refs: ['workitem:WI-2'] },
      ],
    });
  });

  it('refuses a foreign selection before collecting any work', () => {
    const deps = fixture();
    expect(() =>
      previewProjectOuterLoop(scope.project_id, {
        ...deps,
        selectedScope: { ...scope, tenant_slug: 'other' },
      })
    ).toThrow('matching');
    expect(deps.view).not.toHaveBeenCalled();
  });

  it('waits when a project is paused', () => {
    expect(previewProjectOuterLoop(scope.project_id, fixture('paused'))).toMatchObject({
      status: 'awaiting_active_project',
      candidates: [],
    });
  });
});
