import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import { saveOrganizationPurpose } from '../organization/organization-operating-model.js';
import { buildManagedProjectRecord } from './project-management.js';
import { assertProjectObjectiveLinks } from './project-objective-links.js';

const rootDir = pathResolver.sharedTmp(`project-objective-links-test-${process.pid}`);

describe('project objective links', () => {
  afterEach(() => safeRmSync(rootDir, { recursive: true, force: true }));

  function seedPurpose(): void {
    saveOrganizationPurpose(
      {
        version: '1.0.0',
        organization_id: 'org-links',
        name: 'Links',
        purpose: 'Link projects to objectives.',
        tier: 'public',
        owner_role: 'operator',
        approval_state: 'draft',
        updated_at: '2026-10-05T00:00:00.000Z',
        objectives: [{ objective_id: 'obj-a', title: 'A', status: 'active' }],
      } as never,
      { rootDir }
    );
  }

  const record = (objectiveIds: string[], organizationId?: string) =>
    buildManagedProjectRecord({
      project_id: 'PRJ-LINKS',
      name: 'Links',
      summary: 'Objective link test',
      tier: 'public',
      ...(organizationId ? { organization_id: organizationId } : {}),
      objective_ids: objectiveIds,
    });

  it('keeps sorted unique objective ids on the record', () => {
    expect(record(['obj-b', 'obj-a', 'obj-a'], 'org-links').objective_ids).toEqual([
      'obj-a',
      'obj-b',
    ]);
    expect(record([], 'org-links').objective_ids).toBeUndefined();
  });

  it("accepts the organization's own objectives and rejects unknown ones", () => {
    seedPurpose();
    expect(() =>
      assertProjectObjectiveLinks(record(['obj-a'], 'org-links'), rootDir)
    ).not.toThrow();
    expect(() =>
      assertProjectObjectiveLinks(record(['obj-a', 'obj-x'], 'org-links'), rootDir)
    ).toThrow("Unknown objective(s) for organization 'org-links': obj-x");
  });

  it('requires an organization before linking objectives', () => {
    expect(() => assertProjectObjectiveLinks(record(['obj-a']), rootDir)).toThrow(
      'has no organization_id'
    );
  });
});
