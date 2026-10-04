import { describe, expect, it } from 'vitest';
import {
  rollUpObjectiveProgress,
  type KrMeasurementRow,
} from './organization-objective-progress.js';
import {
  buildOrganizationKeyResultAddition,
  buildOrganizationKeyResultRemoval,
} from './organization-operating-model-operations.js';
import { saveOrganizationPurpose } from './organization-operating-model-persistence.js';
import { safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import type { OrganizationPurposeRecord } from './organization-operating-model.js';

const purpose: OrganizationPurposeRecord = {
  version: '1.0.0',
  organization_id: 'org-kr',
  name: 'KR Org',
  purpose: 'Measure things.',
  tier: 'public',
  owner_role: 'owner',
  approval_state: 'approved',
  updated_at: '2026-10-04T00:00:00.000Z',
  objectives: [
    {
      objective_id: 'o1',
      title: 'Reliable',
      key_results: [
        {
          kr_id: 'a',
          title: 'A',
          metric: { source: 'org_metric', metric: 'open_incidents' },
          target: 0,
          direction: 'decrease',
          weight: 3,
        },
        {
          kr_id: 'b',
          title: 'B',
          metric: { source: 'org_metric', metric: 'pending_decisions' },
          target: 0,
          direction: 'decrease',
        },
      ],
    },
    { objective_id: 'o2', title: 'No KRs' },
  ],
};
const scope = { organizationId: 'org-kr', tier: 'public' as const };
const row = (
  kr_id: string,
  progress: number,
  measured_at: string,
  extra: Partial<KrMeasurementRow> = {}
): KrMeasurementRow => ({
  scope: 'org',
  organization_id: 'org-kr',
  objective_id: 'o1',
  kr_id,
  value: 1,
  progress,
  measured_at,
  ...extra,
});

describe('rollUpObjectiveProgress', () => {
  it('weights KR progress using the latest measurement per KR', () => {
    const result = rollUpObjectiveProgress(scope, {
      loadPurpose: () => purpose,
      readMeasurements: () => [
        row('a', 0, '2026-10-01T00:00:00Z'),
        row('a', 1, '2026-10-03T00:00:00Z'),
        row('b', 0.5, '2026-10-02T00:00:00Z'),
        row('b', 0, '2026-10-02T00:00:00Z', { scope: 'dot', dot_id: 'x' }),
      ],
    });
    const o1 = result.objectives.find((o) => o.objective_id === 'o1')!;
    expect(o1.progress).toBeCloseTo((3 * 1 + 1 * 0.5) / 4);
    expect(o1.unmeasured_krs).toEqual([]);
  });

  it('leaves progress undefined and lists unmeasured KRs', () => {
    const result = rollUpObjectiveProgress(scope, {
      loadPurpose: () => purpose,
      readMeasurements: () => [row('a', 1, '2026-10-03T00:00:00Z')],
    });
    const o1 = result.objectives[0];
    expect(o1.progress).toBeUndefined();
    expect(o1.unmeasured_krs).toEqual(['b']);
    expect(result.objectives[1].progress).toBeUndefined();
    expect(result.objectives[1].unmeasured_krs).toEqual([]);
  });
});

describe('organization key result operations', () => {
  const rootDir = pathResolver.sharedTmp('organization-kr-ops-test');
  it('adds, rejects duplicates, validates, and removes key results', () => {
    safeRmSync(rootDir, { recursive: true, force: true });
    try {
      saveOrganizationPurpose(
        { ...purpose, objectives: [{ objective_id: 'o1', title: 'Reliable' }] },
        { rootDir }
      );
      const kr = {
        kr_id: 'uptime',
        title: 'Uptime',
        metric: { source: 'org_metric' as const, metric: 'unhealthy_services' as const },
        target: 0,
        direction: 'decrease' as const,
      };
      const base = {
        organizationId: 'org-kr',
        tier: 'public' as const,
        objectiveId: 'o1',
        rootDir,
      };
      const added = buildOrganizationKeyResultAddition({ ...base, keyResult: kr });
      expect(added.objectives?.[0].key_results).toEqual([kr]);
      saveOrganizationPurpose(added, { rootDir });
      expect(() => buildOrganizationKeyResultAddition({ ...base, keyResult: kr })).toThrow(
        /already exists/
      );
      expect(() =>
        buildOrganizationKeyResultAddition({ ...base, objectiveId: 'nope', keyResult: kr })
      ).toThrow(/not found/);
      expect(() =>
        buildOrganizationKeyResultAddition({
          ...base,
          keyResult: { ...kr, kr_id: 'bad', direction: 'sideways' as never },
        })
      ).toThrow(/Invalid organization purpose/);
      const removed = buildOrganizationKeyResultRemoval({ ...base, krId: 'uptime' });
      expect(removed.objectives?.[0].key_results).toBeUndefined();
      expect(() => buildOrganizationKeyResultRemoval({ ...base, krId: 'uptime2' })).toThrow(
        /not found/
      );
    } finally {
      safeRmSync(rootDir, { recursive: true, force: true });
    }
  });
});
