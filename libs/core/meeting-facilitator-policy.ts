/**
 * Meeting-facilitator policy: a single typed config object that
 * collects every policy lever the meeting flow exposes (approval-gate
 * IDs, sudo override, speaker-fairness thresholds, reminder CC nag
 * threshold, restricted-action policy path).
 *
 * Why: the original implementation spread these across `process.env`
 * reads in three different files. Centralising them in one struct
 * with one loader makes the policy auditable, overridable per
 * deployment, and testable without env-variable manipulation.
 *
 * Source of truth in this round is still the environment, but ops
 * accept a `MeetingFacilitatorPolicy` argument so a future tenant-
 * scoped JSON file can plug in here without churning callers.
 */

const DEFAULT_RESTRICTED_POLICY_PATH =
  'knowledge/public/governance/restricted-action-kinds-policy.json';

export interface MeetingFacilitatorPolicy {
  /**
   * Item ids the operator has explicitly approved for restricted-action
   * self-execution. Sourced from `KYBERION_RESTRICTED_APPROVED_ITEMS`
   * (comma-separated) by default.
   */
  restricted_approved_item_ids: ReadonlySet<string>;
  /** When true, the approval gate is skipped (incident-response mode). */
  sudo_override: boolean;
  /**
   * After how many primary reminders the manager handle gets CC'd by
   * default. Sourced from `KYBERION_REMINDER_CC_AFTER_N` (default 3).
   * Priority=must and restricted items always CC regardless of count.
   */
  reminder_cc_after_n: number;
  /**
   * Speaker-fairness audit raises a warn flag when one speaker accounts
   * for more than this share of total items. Sourced from
   * `KYBERION_SPEAKER_FAIRNESS_TOTAL_THRESHOLD` (default 0.6).
   */
  speaker_fairness_total_threshold: number;
  /**
   * As above, but for `must`-priority items. Sourced from
   * `KYBERION_SPEAKER_FAIRNESS_MUST_THRESHOLD` (default 0.7).
   */
  speaker_fairness_must_threshold: number;
  /**
   * Path to the restricted-action policy file. Sourced from
   * `KYBERION_RESTRICTED_ACTIONS_POLICY` and falls back to the
   * canonical public-tier policy.
   */
  restricted_actions_policy_path: string;
}

function parseNumber(input: string | undefined, fallback: number): number {
  if (input === undefined || input === '') return fallback;
  const n = Number(input);
  return Number.isFinite(n) ? n : fallback;
}

function parseIdList(input: string | undefined): ReadonlySet<string> {
  return new Set(
    (input ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function loadMeetingFacilitatorPolicy(
  env: NodeJS.ProcessEnv = process.env,
): MeetingFacilitatorPolicy {
  return {
    restricted_approved_item_ids: parseIdList(env.KYBERION_RESTRICTED_APPROVED_ITEMS),
    sudo_override: env.KYBERION_SUDO === 'true',
    reminder_cc_after_n: parseNumber(env.KYBERION_REMINDER_CC_AFTER_N, 3),
    speaker_fairness_total_threshold: parseNumber(
      env.KYBERION_SPEAKER_FAIRNESS_TOTAL_THRESHOLD,
      0.6,
    ),
    speaker_fairness_must_threshold: parseNumber(
      env.KYBERION_SPEAKER_FAIRNESS_MUST_THRESHOLD,
      0.7,
    ),
    restricted_actions_policy_path:
      env.KYBERION_RESTRICTED_ACTIONS_POLICY ?? DEFAULT_RESTRICTED_POLICY_PATH,
  };
}
