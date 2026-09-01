import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditChain } from './audit-chain.js';
import { buildOrganizationOperationRecord } from './organization-operating-model-management.js';
import {
  removeOrganizationEntity,
  retireOrganizationEntity,
} from './organization-operating-model.js';
import {
  loadOrganizationOperationalState,
  saveOrganizationOperationalState,
  transitionOrganizationLifecycle,
} from './organization-operating-model-persistence.js';
import { saveOrganizationOperation } from './organization-operating-model-operations.js';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';

const organizationId = 'ORG-EG-LIFECYCLE-TEST';
const tenantSlug = 'tenant-acme';
const tier = 'confidential' as const;

describe('organization lifecycle governance', () => {
  const originalEnv = { ...process.env };
  const workspace = pathResolver.organizationWorkspaceDir(organizationId, tier, tenantSlug);

  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign';
    process.env.KYBERION_SUDO = 'true';
    safeRmSync(workspace, { recursive: true, force: true });
  });

  afterEach(() => {
    safeRmSync(workspace, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('transitions pause/resume/archive and records each lifecycle verb', () => {
    const record = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as any);
    try {
      saveOrganizationOperationalState({
        organization_id: organizationId,
        name: 'EG lifecycle organization',
        tier,
        tenant_slug: tenantSlug,
        status: 'active',
        active_project_ids: [],
        updated_at: new Date().toISOString(),
      });

      expect(
        transitionOrganizationLifecycle({ organizationId, tier, tenantSlug, verb: 'pause' }).status
      ).toBe('paused');
      expect(
        transitionOrganizationLifecycle({ organizationId, tier, tenantSlug, verb: 'resume' }).status
      ).toBe('active');
      expect(
        transitionOrganizationLifecycle({
          organizationId,
          tier,
          tenantSlug,
          verb: 'archive',
          reason: 'EG acceptance fixture',
        }).status
      ).toBe('archived');

      expect(loadOrganizationOperationalState(organizationId, { tier, tenantSlug })?.status).toBe(
        'archived'
      );
      expect(record.mock.calls.map(([entry]) => entry.action)).toEqual(
        expect.arrayContaining([
          'organization.pause',
          'organization.resume',
          'organization.archive',
        ])
      );
    } finally {
      record.mockRestore();
    }
  });

  it('retires and explicitly removes an operation with audit records', () => {
    const record = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as any);
    try {
      const operation = buildOrganizationOperationRecord({
        organizationId,
        operationId: 'op-eg-lifecycle',
        name: 'EG lifecycle operation',
        operationType: 'scheduled',
        ownerRole: 'organization_owner',
        tier,
        tenantSlug,
      });
      saveOrganizationOperation(operation);

      expect(
        retireOrganizationEntity({
          organizationId,
          tier,
          tenantSlug,
          kind: 'operation',
          recordId: operation.operation_id,
          reason: 'EG acceptance fixture',
        })
      ).toMatchObject({ status: 'retired' });
      expect(
        removeOrganizationEntity({
          organizationId,
          tier,
          tenantSlug,
          kind: 'operation',
          recordId: operation.operation_id,
          reason: 'EG acceptance fixture',
        })
      ).toEqual({ status: 'removed', kind: 'operation', record_id: operation.operation_id });
      expect(record.mock.calls.map(([entry]) => entry.action)).toEqual(
        expect.arrayContaining(['organization.operation.retire', 'organization.operation.remove'])
      );
    } finally {
      record.mockRestore();
    }
  });
});
