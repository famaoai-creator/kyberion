import { logger } from './core.js';
import type { NarratedVideoPreferenceProfile } from './src/types/narrated-video-preference-profile.js';

export type NarratedVideoPurpose =
  | 'tutorial'
  | 'announcement'
  | 'product_demo'
  | 'marketing'
  | 'onboarding'
  | 'default';

export interface NarratedVideoBriefQuestionSet {
  label: string;
  video_purposes?: NarratedVideoPurpose[];
  questions: string[];
  notes?: string;
}

export interface NarratedVideoThemeSet {
  label: string;
  video_purposes?: NarratedVideoPurpose[];
  theme_hint: string;
  visual_traits?: string[];
  notes?: string;
}

export function selectNarratedVideoBriefQuestionSet(
  profile: NarratedVideoPreferenceProfile,
  purpose?: NarratedVideoPurpose | string | null
): NarratedVideoBriefQuestionSet | undefined {
  const normalizedPurpose = purpose ? String(purpose) : '';
  return profile.brief_question_sets.find(
    (set) =>
      !set.video_purposes?.length ||
      set.video_purposes.includes(normalizedPurpose as NarratedVideoPurpose)
  );
}

export function getNarratedVideoBriefQuestions(
  profile: NarratedVideoPreferenceProfile,
  purpose?: NarratedVideoPurpose | string | null,
  maxQuestions?: number
): { questions: string[]; omitted_count: number } {
  const questions = selectNarratedVideoBriefQuestionSet(profile, purpose)?.questions || [];
  const limit = Math.max(1, (maxQuestions ?? questions.length) || 1);
  const selected = questions.slice(0, limit);
  const omittedCount = Math.max(0, questions.length - selected.length);
  if (omittedCount > 0) {
    logger.info?.(
      `[narrated-video-preference-profile] omitted ${omittedCount} brief question(s) for purpose=${purpose || 'default'}`
    );
  }
  return { questions: selected, omitted_count: omittedCount };
}

export function selectNarratedVideoThemeSet(
  profile: NarratedVideoPreferenceProfile,
  purpose?: NarratedVideoPurpose | string | null
): NarratedVideoThemeSet | undefined {
  const normalizedPurpose = purpose ? String(purpose) : '';
  return profile.theme_sets.find(
    (set) =>
      !set.video_purposes?.length ||
      set.video_purposes.includes(normalizedPurpose as NarratedVideoPurpose)
  );
}

export function getNarratedVideoThemeHint(
  profile: NarratedVideoPreferenceProfile,
  purpose?: NarratedVideoPurpose | string | null
): string | undefined {
  return (
    selectNarratedVideoThemeSet(profile, purpose)?.theme_hint || profile.theme_sets[0]?.theme_hint
  );
}

export function getNarratedVideoPublishPolicy(
  profile: NarratedVideoPreferenceProfile
): NarratedVideoPreferenceProfile['publish_policy'] {
  return profile.publish_policy;
}
