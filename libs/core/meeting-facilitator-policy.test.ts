import { describe, expect, it } from 'vitest';
import { loadMeetingFacilitatorPolicy } from './meeting-facilitator-policy.js';

describe('loadMeetingFacilitatorPolicy', () => {
  it('falls back to documented defaults when env is empty', () => {
    const policy = loadMeetingFacilitatorPolicy({});
    expect(policy.sudo_override).toBe(false);
    expect(policy.reminder_cc_after_n).toBe(3);
    expect(policy.speaker_fairness_total_threshold).toBeCloseTo(0.6);
    expect(policy.speaker_fairness_must_threshold).toBeCloseTo(0.7);
    expect([...policy.restricted_approved_item_ids]).toEqual([]);
    expect(policy.restricted_actions_policy_path).toContain(
      'restricted-action-kinds-policy.json',
    );
  });

  it('parses the comma-separated approved-item-ids list', () => {
    const policy = loadMeetingFacilitatorPolicy({
      KYBERION_RESTRICTED_APPROVED_ITEMS: 'AI-FOO-1, AI-BAR-2 ,,AI-BAZ-3',
    });
    expect([...policy.restricted_approved_item_ids].sort()).toEqual([
      'AI-BAR-2',
      'AI-BAZ-3',
      'AI-FOO-1',
    ]);
  });

  it('honors KYBERION_SUDO=true', () => {
    const yes = loadMeetingFacilitatorPolicy({ KYBERION_SUDO: 'true' });
    const no = loadMeetingFacilitatorPolicy({ KYBERION_SUDO: 'false' });
    const other = loadMeetingFacilitatorPolicy({ KYBERION_SUDO: 'YES' });
    expect(yes.sudo_override).toBe(true);
    expect(no.sudo_override).toBe(false);
    expect(other.sudo_override).toBe(false);
  });

  it('parses numeric overrides and falls back when invalid', () => {
    const ok = loadMeetingFacilitatorPolicy({
      KYBERION_REMINDER_CC_AFTER_N: '5',
      KYBERION_SPEAKER_FAIRNESS_TOTAL_THRESHOLD: '0.5',
      KYBERION_SPEAKER_FAIRNESS_MUST_THRESHOLD: '0.8',
    });
    expect(ok.reminder_cc_after_n).toBe(5);
    expect(ok.speaker_fairness_total_threshold).toBeCloseTo(0.5);
    expect(ok.speaker_fairness_must_threshold).toBeCloseTo(0.8);

    const bad = loadMeetingFacilitatorPolicy({
      KYBERION_REMINDER_CC_AFTER_N: 'not-a-number',
      KYBERION_SPEAKER_FAIRNESS_TOTAL_THRESHOLD: '',
    });
    expect(bad.reminder_cc_after_n).toBe(3);
    expect(bad.speaker_fairness_total_threshold).toBeCloseTo(0.6);
  });

  it('uses an explicit policy path override when provided', () => {
    const policy = loadMeetingFacilitatorPolicy({
      KYBERION_RESTRICTED_ACTIONS_POLICY: 'tenants/acme/restricted.json',
    });
    expect(policy.restricted_actions_policy_path).toBe('tenants/acme/restricted.json');
  });
});
