import { describe, expect, it } from 'vitest';
import {
  nextOrganizationOperationDue,
  organizationOperationDueProjection,
} from './organization-operation-runtime.js';
import type { OrganizationOperationRecord } from './organization-operating-model.js';

const operation = {
  trigger: { kind: 'schedule', expression: '0 9 * * 1', timezone: 'Asia/Tokyo' },
  updated_at: '2026-09-21T00:00:00.000Z',
} as OrganizationOperationRecord;

describe('organization operation due projection', () => {
  it('finds the next zoned cron occurrence and marks a missed run overdue', () => {
    expect(nextOrganizationOperationDue(operation)).toBe('2026-09-28T00:00:00.000Z');
    expect(
      organizationOperationDueProjection(operation, null, new Date('2026-09-28T00:02:00.000Z'))
    ).toEqual({
      due_status: 'overdue',
      next_due_at: '2026-09-28T00:00:00.000Z',
    });
  });

  it('advances from the last completed run', () => {
    expect(nextOrganizationOperationDue(operation, '2026-09-28T00:02:00.000Z')).toBe(
      '2026-10-05T00:00:00.000Z'
    );
  });

  it('keeps leap-day schedules visible across multiple years', () => {
    expect(
      nextOrganizationOperationDue({
        ...operation,
        trigger: { kind: 'schedule', expression: '0 0 29 2 *', timezone: 'UTC' },
        updated_at: '2026-03-01T00:00:00.000Z',
      })
    ).toBe('2028-02-29T00:00:00.000Z');
  });

  it('rejects impossible calendar combinations without scanning every hour', () => {
    expect(
      nextOrganizationOperationDue({
        ...operation,
        trigger: { kind: 'schedule', expression: '0 0 31 2 *', timezone: 'UTC' },
      })
    ).toBeUndefined();
  });

  it('keeps malformed stored schedules from breaking the organization view', () => {
    expect(
      nextOrganizationOperationDue({
        ...operation,
        trigger: { kind: 'schedule', expression: '0 0 31 2' },
      })
    ).toBeUndefined();
    expect(
      nextOrganizationOperationDue({
        ...operation,
        trigger: { kind: 'schedule', expression: '0 9 * * 1', timezone: 'Not/AZone' },
      })
    ).toBeUndefined();
  });
});
