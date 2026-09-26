import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOrganizationOperationRecord } from './organization-operating-model-management.js';
import { saveOrganizationOperation } from './organization-operating-model-operations.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';
import type { BuildOrganizationOperationInput } from './organization-operating-model-operations.js';

describe('operation deadline_effective_from', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = pathResolver.sharedTmp(
      `organization-deadline-effective-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
  });

  afterEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  function input(
    businessDay: number,
    overrides: Partial<BuildOrganizationOperationInput> = {}
  ): BuildOrganizationOperationInput {
    return {
      organizationId: 'org-deadline',
      operationId: 'monthly-close',
      name: 'Monthly close',
      operationType: 'scheduled',
      ownerRole: 'organization_owner',
      tier: 'public',
      triggerKind: 'schedule',
      triggerExpression: '0 9 1 * *',
      triggerTimezone: 'Asia/Tokyo',
      deadline: { kind: 'business_day_of_month', business_day: businessDay, time: '17:00' },
      executionKind: 'mission',
      rootDir,
      ...overrides,
    };
  }

  it('stamps a new deadline, carries it across unrelated edits, and resets it on change', () => {
    const first = buildOrganizationOperationRecord(input(2), '2026-09-01T00:00:00.000Z');
    expect(first.deadline?.deadline_effective_from).toBe('2026-09-01T00:00:00.000Z');
    saveOrganizationOperation(first, { rootDir });

    const renamed = buildOrganizationOperationRecord(
      input(2, { name: 'Monthly close (renamed)' }),
      '2026-10-05T00:00:00.000Z'
    );
    expect(renamed.updated_at).toBe('2026-10-05T00:00:00.000Z');
    expect(renamed.deadline?.deadline_effective_from).toBe('2026-09-01T00:00:00.000Z');

    const moved = buildOrganizationOperationRecord(input(3), '2026-10-06T00:00:00.000Z');
    expect(moved.deadline?.deadline_effective_from).toBe('2026-10-06T00:00:00.000Z');
  });

  it('carries a legacy record forward from its previous updated_at', () => {
    const legacy = buildOrganizationOperationRecord(input(2), '2026-08-01T00:00:00.000Z');
    delete legacy.deadline!.deadline_effective_from;
    saveOrganizationOperation(legacy, { rootDir });
    const edited = buildOrganizationOperationRecord(
      input(2, { purpose: 'Close the books' }),
      '2026-10-05T00:00:00.000Z'
    );
    expect(edited.deadline?.deadline_effective_from).toBe('2026-08-01T00:00:00.000Z');
  });
});
