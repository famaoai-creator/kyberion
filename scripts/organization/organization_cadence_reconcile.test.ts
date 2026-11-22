import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  findDotCharter,
  listDotCharters,
  validateDotCharter,
  type DotCharter,
} from '@agent/core/dot/dot-charter';
import { createDraftDotCharter, transitionDotCharterStatus } from '@agent/core/dot/dot-lifecycle';
import {
  organizationOperationalStatePath,
  loadOrganizationOperationalState,
} from '@agent/core/organization/organization-operating-model-persistence';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { runDotOrgCadenceForCharter } from '../dot/dot_org_cadence_step.js';
import {
  managedOrganizationCadenceId,
  reconcileOrganizationCadence,
} from './organization_cadence_reconcile.js';

const org = {
  tier: 'confidential',
  tenant_slug: 'acme',
  organization_id: 'operations',
  status: 'active',
  name: 'Operations',
  updated_at: '2026-11-22T00:00:00.000Z',
} as const;

function fixture() {
  const charters: DotCharter[] = [];
  const create = vi.fn((input: unknown) => {
    const charter = validateDotCharter(input);
    charters.push(charter);
    return charter;
  });
  const activate = vi.fn((id: string) => {
    const charter = charters.find((candidate) => candidate.dot_id === id)!;
    charter.status = 'active';
    return charter;
  });
  const load = vi.fn(() => ({ ...org, status: 'active' as 'active' | 'paused' }));
  const deps = { list: () => charters, create, activate, load, halted: () => false };
  return { charters, deps };
}

describe('organization cadence enrollment', () => {
  it('persists one charter and holds its next tick while the organization is paused', async () => {
    const rootDir = pathResolver.sharedTmp('organization-cadence-enrollment-' + randomUUID());
    try {
      safeWriteFile(
        rootDir + '/knowledge/personal/tenants/acme.json',
        JSON.stringify({
          tenant_slug: 'acme',
          display_name: 'Acme',
          status: 'active',
          assigned_role: 'owner',
        })
      );
      safeWriteFile(
        organizationOperationalStatePath(org.organization_id, org.tier, org.tenant_slug, rootDir),
        JSON.stringify(org)
      );
      const deps = {
        list: () => listDotCharters(rootDir).map(({ charter }) => charter),
        load: (id: string, scope: Parameters<typeof loadOrganizationOperationalState>[1]) =>
          loadOrganizationOperationalState(id, { ...scope, rootDir }),
        create: (input: unknown) => createDraftDotCharter(input, { rootDir }),
        activate: (...[id, target, options]: Parameters<typeof transitionDotCharterStatus>) =>
          transitionDotCharterStatus(id, target, {
            ...options,
            rootDir,
            hasRole: (role) => role === 'organization_operator',
          }),
        halted: () => false,
      };
      const id = managedOrganizationCadenceId(org);
      expect(reconcileOrganizationCadence(org, deps)).toEqual({ status: 'active', dot_id: id });
      const loaded = findDotCharter(id, rootDir)!;
      expect(loaded.charter.status).toBe('active');
      expect(reconcileOrganizationCadence(org, deps)).toEqual({ status: 'active', dot_id: id });
      safeWriteFile(
        organizationOperationalStatePath(org.organization_id, org.tier, org.tenant_slug, rootDir),
        JSON.stringify({ ...org, status: 'paused' })
      );
      const tick = vi.fn();
      expect(
        await runDotOrgCadenceForCharter(loaded.charter, new Date(org.updated_at), [loaded], {
          rootDir,
          tick,
          runAs: (_charter, run) => run(),
          budgetHard: () => false,
        })
      ).toEqual([]);
      expect(tick).not.toHaveBeenCalled();
      expect(findDotCharter(id, rootDir)?.charter.status).toBe('active');
    } finally {
      safeRmSync(rootDir, { recursive: true, force: true });
    }
  });
  it('enrolls exactly one scope-bound charter without autonomous model wakes', () => {
    const f = fixture();
    const id = managedOrganizationCadenceId(org);
    expect(reconcileOrganizationCadence(org, f.deps)).toEqual({ status: 'active', dot_id: id });
    expect(reconcileOrganizationCadence(org, f.deps)).toEqual({ status: 'active', dot_id: id });
    expect(f.deps.create).toHaveBeenCalledOnce();
    expect(f.deps.activate).toHaveBeenCalledOnce();
    expect(f.charters[0]).toMatchObject({
      scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'operations' },
      authority: { authority_role: 'organization_operator', allowed_execution_shapes: [] },
    });
    expect(managedOrganizationCadenceId({ ...org, tenant_slug: 'other' })).not.toBe(id);
  });

  it('resumes a persisted draft after an interrupted activation', () => {
    const f = fixture();
    f.deps.activate.mockImplementationOnce(() => {
      throw new Error('interrupted');
    });
    expect(reconcileOrganizationCadence(org, f.deps).status).toBe('needs_attention');
    expect(f.charters[0]?.status).toBe('draft');
    expect(reconcileOrganizationCadence(org, f.deps).status).toBe('active');
    expect(f.deps.create).toHaveBeenCalledOnce();
  });

  it('honors the operations halt and the operator’s explicit charter pause', () => {
    const f = fixture();
    expect(reconcileOrganizationCadence(org, { ...f.deps, halted: () => true })).toEqual({
      status: 'halted',
    });
    expect(f.deps.create).not.toHaveBeenCalled();
    reconcileOrganizationCadence(org, f.deps);
    f.charters[0].status = 'paused';
    expect(reconcileOrganizationCadence(org, f.deps)).toEqual({
      status: 'paused',
      dot_id: managedOrganizationCadenceId(org),
    });
    expect(f.deps.activate).toHaveBeenCalledOnce();
  });

  it('respects an existing manual cadence and a paused organization', () => {
    const f = fixture();
    reconcileOrganizationCadence(org, f.deps);
    f.charters[0].dot_id = 'manual-operations';
    expect(reconcileOrganizationCadence(org, f.deps)).toEqual({
      status: 'managed_elsewhere',
      dot_id: 'manual-operations',
    });
    f.deps.load.mockReturnValue({ ...org, status: 'paused' });
    expect(reconcileOrganizationCadence(org, f.deps)).toEqual({ status: 'awaiting_organization' });
    expect(f.deps.create).toHaveBeenCalledOnce();
  });
});
