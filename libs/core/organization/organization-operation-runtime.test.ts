import { describe, expect, it } from 'vitest';
import {
  nextOrganizationOperationDue,
  organizationOperationDeadlineProjection,
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

describe('organization operation deadline projection', () => {
  const monthly = {
    operation_id: 'monthly',
    trigger: { kind: 'schedule', expression: '0 9 1 * *', timezone: 'Asia/Tokyo' },
    deadline: { kind: 'business_day_of_month', business_day: 2, time: '17:00' },
    updated_at: '2026-09-01T00:00:00.000Z',
  } as OrganizationOperationRecord;
  const run = (
    completedAt: string,
    status: 'succeeded' | 'failed' = 'succeeded',
    id = 'monthly'
  ) => ({
    operation_id: id,
    status,
    completed_at: completedAt,
  });

  it('places the deadline on the second business day of the month at 17:00 local', () => {
    expect(
      organizationOperationDeadlineProjection(monthly, [], new Date('2026-10-01T01:00:00.000Z'))
    ).toEqual({
      period_start: '2026-09-30T15:00:00.000Z',
      deadline_at: '2026-10-02T08:00:00.000Z',
      status: 'upcoming',
    });
  });

  it('clamps a business day beyond the month to its last business day', () => {
    // Feb 2027 has 18 bank business days; the 20th clamps to Fri Feb 26.
    const late = {
      ...monthly,
      deadline: { kind: 'business_day_of_month', business_day: 20, time: '17:00' },
    } as OrganizationOperationRecord;
    expect(
      organizationOperationDeadlineProjection(late, [], new Date('2027-02-10T00:00:00.000Z'))
    ).toMatchObject({ deadline_at: '2027-02-26T08:00:00.000Z', status: 'upcoming' });
    expect(
      organizationOperationDeadlineProjection(late, [], new Date('2027-02-27T00:00:00.000Z'))
        ?.status
    ).toBe('missed');
  });

  it('marks the period missed after the deadline without a successful run', () => {
    expect(
      organizationOperationDeadlineProjection(
        monthly,
        [run('2026-09-02T05:00:00.000Z')],
        new Date('2026-10-02T09:00:00.000Z')
      )?.status
    ).toBe('missed');
  });

  it('marks the period met once a successful run lands inside it before the deadline', () => {
    expect(
      organizationOperationDeadlineProjection(
        monthly,
        [run('2026-10-01T03:00:00.000Z'), run('2026-10-02T09:30:00.000Z', 'failed')],
        new Date('2026-10-02T10:00:00.000Z')
      )?.status
    ).toBe('met');
  });

  it('keeps a late completion missed and flags it, ignoring other operations and failures', () => {
    expect(
      organizationOperationDeadlineProjection(
        monthly,
        [
          run('2026-10-01T03:00:00.000Z', 'failed'),
          run('2026-10-01T03:00:00.000Z', 'succeeded', 'other-operation'),
          run('2026-10-02T09:30:00.000Z'),
        ],
        new Date('2026-10-02T10:00:00.000Z')
      )
    ).toMatchObject({ status: 'missed', completed_late: true });
  });

  it('does not report a period whose deadline passed before the deadline took effect', () => {
    const registered = {
      ...monthly,
      updated_at: '2026-09-24T00:00:00.000Z',
    } as OrganizationOperationRecord;
    expect(
      organizationOperationDeadlineProjection(registered, [], new Date('2026-09-24T06:00:00.000Z'))
        ?.status
    ).toBe('untracked');
    expect(
      organizationOperationDeadlineProjection(registered, [], new Date('2026-10-02T09:00:00.000Z'))
        ?.status
    ).toBe('missed');
  });

  it('judges untracked from deadline_effective_from, not a later unrelated edit', () => {
    const edited = {
      ...monthly,
      deadline: { ...monthly.deadline!, deadline_effective_from: '2026-09-01T00:00:00.000Z' },
      updated_at: '2026-10-05T00:00:00.000Z',
    } as OrganizationOperationRecord;
    expect(
      organizationOperationDeadlineProjection(edited, [], new Date('2026-10-05T06:00:00.000Z'))
        ?.status
    ).toBe('missed');
    const newlyEffective = {
      ...edited,
      deadline: { ...edited.deadline!, deadline_effective_from: '2026-10-05T00:00:00.000Z' },
    } as OrganizationOperationRecord;
    expect(
      organizationOperationDeadlineProjection(
        newlyEffective,
        [],
        new Date('2026-10-05T06:00:00.000Z')
      )?.status
    ).toBe('untracked');
  });

  it('has no projection without a deadline', () => {
    expect(organizationOperationDeadlineProjection(operation, [])).toBeUndefined();
  });
});
