import { describe, expect, it, vi } from 'vitest';
import {
  getGrantCapabilityPolicy,
  getGrantReadinessProfile,
  listGrantReadinessProfiles,
} from './grant-capability-policy.js';
import { evaluateGrantReadiness } from './grant-readiness.js';

const grantedProbe = () =>
  ({ available: true, microphone: 'granted', host_app: 'Terminal' }) as never;

describe('grant readiness profiles (PG-06)', () => {
  it('every profile names only declared capabilities', () => {
    const profiles = listGrantReadinessProfiles();
    expect(profiles).toEqual(['meeting.in_room', 'meeting.online', 'voice.realtime']);
    for (const name of profiles) {
      for (const requirement of getGrantReadinessProfile(name)?.requirements ?? []) {
        expect(
          getGrantCapabilityPolicy(requirement.capability),
          requirement.capability
        ).not.toBeNull();
      }
    }
  });

  it('an unknown profile throws and own-key lookup ignores prototype names', () => {
    expect(() => evaluateGrantReadiness({ profile: 'meeting.nope', context: {} })).toThrow(
      /unknown profile meeting\.nope/
    );
    expect(getGrantReadinessProfile('toString')).toBeNull();
  });

  it('evaluates recording through the consent gate read-only and the microphone through the probe', () => {
    const meetingConsent = vi.fn(() => ({ allowed: true, grant_id: 'grant-1' }));
    const report = evaluateGrantReadiness(
      {
        profile: 'meeting.in_room',
        context: { tenant_slug: 'acme', meeting: { series_id: 'series-1' } },
      },
      { meetingConsent, probe: grantedProbe }
    );
    expect(meetingConsent).toHaveBeenCalledWith({
      tenant_slug: 'acme',
      purpose: 'recording',
      meeting: { series_id: 'series-1' },
      record_binding: false,
    });
    expect(report).toMatchObject({ ready: true, missing: [] });
    expect(report.items).toEqual([
      { capability: 'os.microphone', required: true, allowed: true, source: 'os' },
      {
        capability: 'meeting.recording',
        required: true,
        allowed: true,
        source: 'standing',
        grant_id: 'grant-1',
      },
    ]);
  });

  it('lists what is missing with remedies; an optional capability never blocks', () => {
    const meetingConsent = vi.fn((input: { purpose: string }) =>
      input.purpose === 'recording'
        ? { allowed: false, reason: 'no grant', remedy: 'pnpm kyberion grants grant …' }
        : { allowed: false, reason: 'voice-consent.json missing' }
    );
    const report = evaluateGrantReadiness(
      { profile: 'meeting.online', context: { mission_id: 'MSN-X' } },
      { meetingConsent }
    );
    expect(report.ready).toBe(false);
    expect(report.missing).toEqual(['meeting.recording']);
    expect(report.items).toEqual([
      {
        capability: 'meeting.recording',
        required: true,
        allowed: false,
        reason: 'no grant',
        remedy: 'pnpm kyberion grants grant …',
      },
      {
        capability: 'meeting.voice',
        required: false,
        note: 'only when the agent speaks in the meeting',
        allowed: false,
        reason: 'voice-consent.json missing',
        remedy: 'pnpm meeting:consent grant --mission MSN-X',
      },
    ]);
  });

  it('a throwing gate becomes a denied item instead of an exception', () => {
    const report = evaluateGrantReadiness(
      { profile: 'meeting.online', context: {} },
      {
        meetingConsent: () => {
          throw new Error('store unreadable');
        },
      }
    );
    expect(report.items[0]).toMatchObject({
      capability: 'meeting.recording',
      allowed: false,
      reason: 'consent check failed: store unreadable',
    });
  });
});
