import { describe, expect, it } from 'vitest';
import {
  formatObjectiveProgress,
  measureOrganizationObjectives,
  recordOrganizationObjectiveKr,
} from './organization_objective_measure.js';

describe('organization objective kr measure', () => {
  it('formats objective progress with each key result', () => {
    expect(
      formatObjectiveProgress({
        organization_id: 'acme',
        objectives: [
          {
            objective_id: 'obj-a',
            title: 'Halve activation time',
            progress: 0.5,
            key_results: [
              { kr_id: 'kr-1', weight: 1, progress: 1 },
              { kr_id: 'kr-2', weight: 1, progress: 0 },
            ],
            unmeasured_krs: [],
          },
          {
            objective_id: 'obj-b',
            title: 'Unmeasured goal',
            key_results: [{ kr_id: 'kr-3', weight: 1 }],
            unmeasured_krs: ['kr-3'],
          },
          {
            objective_id: 'obj-c',
            title: 'No key results yet',
            key_results: [],
            unmeasured_krs: [],
          },
        ],
      })
    ).toEqual([
      'Objective: Halve activation time — 50% (kr-1 100%, kr-2 0%)',
      'Objective: Unmeasured goal — unmeasured (kr-3 unmeasured)',
      'Objective: No key results yet — unmeasured (no key results)',
    ]);
  });

  it('requires exactly one of --dry-run and --apply and a tenant for confidential scope', async () => {
    const print = () => undefined;
    await expect(
      measureOrganizationObjectives(['--organization-id', 'acme', '--tier', 'public'], print)
    ).rejects.toThrow('--dry-run|--apply');
    await expect(
      measureOrganizationObjectives(
        ['--organization-id', 'acme', '--tier', 'confidential', '--apply'],
        print
      )
    ).rejects.toThrow('A tenant is required');
  });

  it('records a key result value only with a finite --value and an explicit mode', () => {
    const lines: unknown[] = [];
    const print = (value: unknown) => lines.push(value);
    const scope = ['--organization-id', 'acme', '--tier', 'public'];
    const kr = ['--objective-id', 'obj-a', '--kr-id', 'kr-1'];
    expect(() =>
      recordOrganizationObjectiveKr([...scope, ...kr, '--value', 'ten', '--apply'], print)
    ).toThrow('kr record');
    expect(() => recordOrganizationObjectiveKr([...scope, ...kr, '--value', '3'], print)).toThrow(
      '--dry-run|--apply'
    );
    recordOrganizationObjectiveKr([...scope, ...kr, '--value', '-2', '--dry-run'], print);
    expect(lines).toEqual(['Would record obj-a/kr-1 = -2']);
    const calls: unknown[] = [];
    recordOrganizationObjectiveKr([...scope, ...kr, '--value', '3', '--apply'], print, {
      record: (recordScope, input) => {
        calls.push([recordScope, input]);
        return {
          scope: 'org',
          organization_id: 'acme',
          objective_id: 'obj-a',
          kr_id: 'kr-1',
          value: 3,
          progress: 0.5,
          measured_at: '2026-10-05T00:00:00.000Z',
        };
      },
    });
    expect(calls).toEqual([
      [
        { organizationId: 'acme', tier: 'public' },
        { objectiveId: 'obj-a', krId: 'kr-1', value: 3 },
      ],
    ]);
    expect(lines[1]).toBe('Recorded obj-a/kr-1 = 3 (50% of target).');
  });
});
