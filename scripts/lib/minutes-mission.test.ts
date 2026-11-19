import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultMeetingMissionId,
  MEETING_MISSION_TYPE,
  resolveMeetingMission,
} from './minutes-mission.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveMeetingMission', () => {
  const now = new Date(2026, 10, 18, 9, 5);

  it('uses an explicitly passed mission unchanged and never creates or retypes it', async () => {
    const start = vi.fn(async () => undefined);
    const resolved = await resolveMeetingMission({ missionId: 'msn-dev-1', start });
    expect(resolved).toEqual({ missionId: 'MSN-DEV-1', created: false });
    expect(start).not.toHaveBeenCalled();
  });

  it('creates a meeting_facilitation mission in the tenant tier when --mission is omitted', async () => {
    const start = vi.fn(async () => undefined);
    const resolved = await resolveMeetingMission({
      tenantSlug: 'acme',
      title: '定例',
      now,
      start,
      exists: () => false,
    });
    expect(resolved).toMatchObject({
      missionId: 'MSN-MEETING-20261118-0905',
      created: true,
      tier: 'confidential',
      tenantSlug: 'acme',
    });
    expect(start).toHaveBeenCalledTimes(1);
    const args = start.mock.calls[0] as unknown[];
    expect(args[0]).toBe('MSN-MEETING-20261118-0905');
    expect(args[1]).toBe('confidential');
    expect(args[4]).toBe(MEETING_MISSION_TYPE);
    expect(args[7]).toBe('acme');
    expect((args[8] as { intentGoal: string }).intentGoal).toContain('定例');
  });

  it('falls back to the personal tier without a tenant and skips taken ids', async () => {
    vi.stubEnv('KYBERION_TENANT', '');
    const start = vi.fn(async () => undefined);
    const taken = new Set([defaultMeetingMissionId(now)]);
    const resolved = await resolveMeetingMission({
      now,
      start,
      exists: (id) => taken.has(id),
    });
    expect(resolved.missionId).toBe('MSN-MEETING-20261118-0905-2');
    expect(resolved.tier).toBe('personal');
    expect((start.mock.calls[0] as unknown[])[1]).toBe('personal');
  });
});
