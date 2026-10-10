import { describe, expect, it } from 'vitest';
import { checkAuthorizationShape, validate } from './surface-management-validation.js';
import {
  SurfaceManagementError,
  type SurfaceManagementAuthorization,
  type SurfaceManagementCommand,
} from './surface-management-contract.js';

const auth: SurfaceManagementAuthorization = {
  actorId: 'user:fixture-owner',
  memberId: 'fixture-owner',
  tenantSlug: 'fixture-tenant',
  allowedOrganizationIds: 'all',
  allowedProjectIds: ['PRJ-FIXTURE'],
};
const commands: SurfaceManagementCommand[] = [
  {
    operation: 'organization.create',
    requestId: 'fixture-0001',
    name: 'Fixture organization',
    purpose: 'Fixture purpose',
  },
  {
    operation: 'organization.update',
    requestId: 'fixture-0002',
    organizationId: 'org-fixture',
    expectedVersion: 'a'.repeat(64),
    purpose: 'Updated fixture purpose',
  },
  {
    operation: 'project.create',
    requestId: 'fixture-0003',
    organizationId: 'org-fixture',
    name: 'Fixture project',
    summary: 'Fixture summary',
  },
  {
    operation: 'project.update',
    requestId: 'fixture-0004',
    organizationId: 'org-fixture',
    projectId: 'PRJ-FIXTURE',
    expectedVersion: 'b'.repeat(64),
    name: 'Renamed fixture project',
  },
];
describe('management domain validation', () => {
  it.each(commands)('accepts the existing $operation command contract', (command) => {
    expect(() => validate(command)).not.toThrow();
  });
  it('preserves strict metadata-only fields and canonical entity identifiers', () => {
    const invalid = [
      { ...commands[0], role: 'sovereign' },
      { ...commands[0], name: '   ' },
      { ...commands[0], requestId: 'short' },
      { ...commands[2], organizationId: '../foreign' },
      { ...commands[3], projectId: ' PRJ-FIXTURE ' },
      { ...commands[3], expectedVersion: 'stale' },
      {
        operation: 'project.update',
        requestId: 'fixture-0005',
        organizationId: 'org-fixture',
        projectId: 'PRJ-FIXTURE',
        expectedVersion: 'b'.repeat(64),
      },
    ];
    for (const command of invalid)
      expect(() => validate(command as SurfaceManagementCommand)).toThrow(SurfaceManagementError);
  });
  it('preserves identity, grant-shape and credential expiry checks', () => {
    expect(() => checkAuthorizationShape(auth)).not.toThrow();
    expect(() =>
      checkAuthorizationShape({ ...auth, expiresAt: new Date(Date.now() + 60000).toISOString() })
    ).not.toThrow();
    for (const patch of [
      { actorId: 'user:other-fixture' },
      { tenantSlug: '../foreign' },
      { expiresAt: 'not-a-date' },
      { expiresAt: '2000-01-01T00:00:00Z' },
      { allowedOrganizationIds: [42] },
    ])
      expect(() =>
        checkAuthorizationShape({ ...auth, ...patch } as SurfaceManagementAuthorization)
      ).toThrow(SurfaceManagementError);
  });
});
