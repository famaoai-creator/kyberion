import { afterEach, describe, expect, it } from 'vitest';
import { currentExecutionScope } from '@agent/core/foundation';
import type { ProjectRecord } from '@agent/core/project/project-registry';
import { readProjectManagementForViewer } from './project-management-data';

const ORIGINAL_PERSONA = process.env.KYBERION_BASE_ROLE;

afterEach(() => {
  if (ORIGINAL_PERSONA === undefined) delete process.env.KYBERION_BASE_ROLE;
  else process.env.KYBERION_BASE_ROLE = ORIGINAL_PERSONA;
});

function project(id: string, tenant: string): ProjectRecord {
  return { project_id: id, tenant_slug: tenant, tier: 'confidential' } as unknown as ProjectRecord;
}

describe('readProjectManagementForViewer', () => {
  it('reads each view outside the worker project fence, bound to the project tenant', () => {
    // The server process runs as a worker; the ambient context would trip
    // assertWorkerProjectScope ([PROJECT_SCOPE_MISSING]) on every project.
    process.env.KYBERION_BASE_ROLE = 'worker';
    const seen: Array<{ id: string; role?: string; tenant?: string; worker: boolean }> = [];
    const views = readProjectManagementForViewer(
      [project('PRJ-A', 'acme'), project('PRJ-B', 'globex')],
      ((id: string) => {
        const scope = currentExecutionScope();
        seen.push({
          id,
          role: scope?.assumedRole,
          tenant: scope?.tenantSlug,
          // assertWorkerProjectScope keys off the bound persona (scopedPersona).
          worker: scope?.assumedBaseRole === 'worker',
        });
        return {
          project: { project_id: id, name: id },
          lineage: { tracks: [], tasks: [], missions: [] },
        };
      }) as never
    );
    expect(views.map((view) => view.project.project_id)).toEqual(['PRJ-A', 'PRJ-B']);
    expect(seen).toEqual([
      { id: 'PRJ-A', role: 'sovereign_concierge', tenant: 'acme', worker: false },
      { id: 'PRJ-B', role: 'sovereign_concierge', tenant: 'globex', worker: false },
    ]);
  });
});
