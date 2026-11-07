import { afterEach, describe, expect, it } from 'vitest';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { currentResourceAccessScope } from '../foundation/resource-access-scope.js';
import { conciergeManagementGrantKind } from '../foundation/concierge-management-capability.js';
import {
  withConciergeManagementAccess,
  withConciergeManagementAccessAsync,
} from './concierge-management-access.js';

const saved = process.env.SYSTEM_ROLE;
afterEach(() => {
  if (saved === undefined) delete process.env.SYSTEM_ROLE;
  else process.env.SYSTEM_ROLE = saved;
});
const reader = {
  tenantSlug: 'acme',
  reads: ['knowledge/personal/tenants/acme.json'],
  writes: [],
  mkdir: [],
};
const writer = {
  tenantSlug: 'acme',
  organizationId: 'org-a',
  reads: [],
  writes: ['active/organizations/confidential/acme/org-a/organization.json'],
  mkdir: ['active/organizations/confidential/acme/org-a'],
};

describe('Concierge management access facade (G2)', () => {
  it('opens the exact ceiling, the bound assumption and the grant together', async () => {
    withConciergeManagementAccess(reader, () => {
      expect(conciergeManagementGrantKind()).toBe('reader');
      expect(currentResourceAccessScope()).toMatchObject({
        tenantSlug: 'acme',
        readExact: reader.reads,
        writeExact: [],
        allowProductKnowledgeRead: true,
      });
      expect(currentExecutionScope()).toMatchObject({ tenantSlug: 'acme', tenantBound: true });
    });
    await withConciergeManagementAccessAsync(writer, async () => {
      await Promise.resolve();
      expect(conciergeManagementGrantKind()).toBe('writer');
      expect(currentExecutionScope()?.organizationId).toBe('org-a');
    });
    expect(conciergeManagementGrantKind()).toBeUndefined();
  });

  it('issues only where the Concierge may (RA-02 on the issuance right)', async () => {
    process.env.SYSTEM_ROLE = 'slack_bridge';
    expect(() => withConciergeManagementAccess(reader, () => undefined)).toThrow(
      'ROLE_ASSUMPTION_DENIED'
    );
    await expect(withConciergeManagementAccessAsync(writer, () => undefined)).rejects.toThrow(
      'ROLE_ASSUMPTION_DENIED'
    );
    process.env.SYSTEM_ROLE = 'concierge';
    expect(withConciergeManagementAccess(reader, () => conciergeManagementGrantKind())).toBe(
      'reader'
    );
  });
});
