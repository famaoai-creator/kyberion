import { describe, expect, it } from 'vitest';
import {
  assertProvenanceShareAllowed,
  combineProvenanceTaint,
  projectProvenanceTaint,
} from './provenance-taint.js';

const observations = [
  {
    id: 'obs-public',
    missionId: 'mission-1',
    service: 'calendar',
    resourceRef: 'calendar:public',
    tier: 'public' as const,
    tenantSlug: 'tenant-a',
    purpose: 'schedule',
    summary: 'public event',
    observedAt: '2026-08-09T00:00:00.000Z',
  },
  {
    id: 'obs-personal',
    missionId: 'mission-1',
    taskId: 'task-1',
    service: 'gmail',
    resourceRef: 'gmail:message:1',
    tier: 'personal' as const,
    tenantSlug: 'tenant-a',
    purpose: 'inbox triage',
    summary: 'private message',
    observedAt: '2026-08-09T00:01:00.000Z',
  },
];

describe('provenance taint', () => {
  it('derives the highest tier, tenant set, and external lock from observations', () => {
    expect(projectProvenanceTaint('mission-1', observations)).toEqual({
      missionId: 'mission-1',
      highestTier: 'personal',
      tenants: ['tenant-a'],
      prohibitExternal: true,
      observationIds: ['obs-public', 'obs-personal'],
    });
  });

  it('combines declared resource taint without weakening provenance', () => {
    const provenance = projectProvenanceTaint('mission-1', observations);
    expect(combineProvenanceTaint('public', provenance)).toBe('personal');
    expect(combineProvenanceTaint('personal', provenance)).toBe('personal');
  });

  it('allows same-tenant internal sharing only at the provenance floor', () => {
    const provenance = projectProvenanceTaint('mission-1', observations);
    expect(() =>
      assertProvenanceShareAllowed({
        provenance,
        audienceFloor: 'personal',
        targetTenant: 'tenant-a',
        external: false,
      })
    ).not.toThrow();
    expect(() =>
      assertProvenanceShareAllowed({
        provenance,
        audienceFloor: 'confidential',
        targetTenant: 'tenant-a',
        external: false,
      })
    ).toThrow('broader than provenance taint');
  });

  it('denies external share and tenant mismatch', () => {
    const provenance = projectProvenanceTaint('mission-1', observations);
    expect(() =>
      assertProvenanceShareAllowed({
        provenance,
        audienceFloor: 'personal',
        targetTenant: 'tenant-a',
        external: true,
      })
    ).toThrow('external sharing');
    expect(() =>
      assertProvenanceShareAllowed({
        provenance,
        audienceFloor: 'personal',
        targetTenant: 'tenant-b',
        external: false,
      })
    ).toThrow('outside provenance scope');
  });
});
