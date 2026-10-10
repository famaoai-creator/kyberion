import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import * as io from '../secure-io.js';
import { readTextFile } from '../foundation/text.js';
import {
  createManagedOrganization,
  updateManagedOrganizationMetadata,
} from './organization-management.js';
import * as persistence from './organization-operating-model-persistence.js';

const scope = {
  organizationId: 'org-management-facade-test',
  tenantSlug: 'tenant-management-facade-test',
  tier: 'confidential' as const,
};
const workspace = pathResolver.organizationWorkspaceDir(
  scope.organizationId,
  scope.tier,
  scope.tenantSlug
);
const statePath = persistence.organizationOperationalStatePath(
  scope.organizationId,
  scope.tier,
  scope.tenantSlug
);
const purposePath = persistence.organizationPurposePath(
  scope.organizationId,
  scope.tier,
  scope.tenantSlug
);
beforeEach(() => {
  vi.stubEnv('KYBERION_SUDO', 'true');
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('KYBERION_TENANT', scope.tenantSlug);
  io.safeRmSync(workspace, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  io.safeRmSync(workspace, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe('governed organization facade', () => {
  it('creates state and purpose and refuses to overwrite either on repeat', () => {
    const result = createManagedOrganization({
      ...scope,
      name: 'Operations',
      purpose: 'Reliable delivery',
    });
    expect(result.saved_paths).toEqual([statePath, purposePath]);
    const bytes = readTextFile(statePath);
    expect(() => createManagedOrganization({ ...scope, name: 'Overwrite' })).toThrow(
      'already exists'
    );
    expect(readTextFile(statePath)).toBe(bytes);
  });
  it('refuses an orphan purpose without creating a state', () => {
    io.safeWriteFile(purposePath, 'orphan');
    expect(() => createManagedOrganization({ ...scope, name: 'Overwrite' })).toThrow(
      'already exists'
    );
    expect(io.safeExistsSync(statePath)).toBe(false);
    expect(readTextFile(purposePath)).toBe('orphan');
  });
  it('rolls back newly created state if purpose creation fails', () => {
    const actual = io.safeCreateExclusiveFileSync;
    vi.spyOn(io, 'safeCreateExclusiveFileSync').mockImplementation((file, data) => {
      if (file === purposePath) throw new Error('injected purpose failure');
      return actual(file, data);
    });
    expect(() =>
      createManagedOrganization({ ...scope, name: 'Operations', purpose: 'Reliable delivery' })
    ).toThrow('injected');
    expect(io.safeExistsSync(statePath)).toBe(false);
    expect(io.safeExistsSync(purposePath)).toBe(false);
  });
  it('edits metadata without replacing objectives, governance or lifecycle', () => {
    const created = createManagedOrganization({
      ...scope,
      name: 'Operations',
      purpose: 'Old purpose',
      principles: ['Care'],
    });
    persistence.saveOrganizationOperationalState({
      ...created.state,
      status: 'paused',
      active_project_ids: ['PRJ-EXISTING'],
    });
    persistence.saveOrganizationPurpose({
      ...created.purpose!,
      approval_state: 'approved',
      objectives: [{ objective_id: 'quality', title: 'Quality', status: 'active' }],
    });
    const next = updateManagedOrganizationMetadata(scope, {
      name: 'Renamed',
      purpose: 'New purpose',
    });
    expect(next.state).toMatchObject({
      name: 'Renamed',
      status: 'paused',
      active_project_ids: ['PRJ-EXISTING'],
    });
    expect(next.purpose).toMatchObject({
      name: 'Renamed',
      purpose: 'New purpose',
      approval_state: 'draft',
      principles: ['Care'],
      objectives: [{ objective_id: 'quality', title: 'Quality', status: 'active' }],
    });
  });
  it.each(['approved', 'pending_approval', 'superseded'] as const)(
    'invalidates %s approval only when purpose text changes',
    (approval_state) => {
      const created = createManagedOrganization({
        ...scope,
        name: 'Operations',
        purpose: 'Keep purpose',
      });
      persistence.saveOrganizationPurpose({ ...created.purpose!, approval_state });
      expect(
        updateManagedOrganizationMetadata(scope, { name: 'Renamed', purpose: 'Keep purpose' })
          .purpose?.approval_state
      ).toBe(approval_state);
      expect(
        updateManagedOrganizationMetadata(scope, { purpose: 'Changed purpose' }).purpose
          ?.approval_state
      ).toBe('draft');
    }
  );
  it('restores original bytes after a second-record failure', () => {
    createManagedOrganization({ ...scope, name: 'Operations', purpose: 'Old purpose' });
    const before = [readTextFile(statePath), readTextFile(purposePath)];
    vi.spyOn(persistence, 'saveOrganizationPurpose').mockImplementationOnce(() => {
      throw new Error('injected save failure');
    });
    expect(() => updateManagedOrganizationMetadata(scope, { name: 'Renamed' })).toThrow('injected');
    expect([readTextFile(statePath), readTextFile(purposePath)]).toEqual(before);
  });
  it('rejects unsupported lifecycle keys at runtime', () => {
    expect(() => updateManagedOrganizationMetadata(scope, { status: 'archived' } as never)).toThrow(
      'Only organization'
    );
  });
});
