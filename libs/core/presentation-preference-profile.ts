import { logger } from './core.js';
import type { PresentationPreferenceProfile } from './src/types/presentation-preference-profile.js';
import type { PresentationSlidePatternSelectionPolicy } from './presentation-slide-pattern.js';

export type PresentationDeckPurpose =
  | 'proposal'
  | 'internal_share'
  | 'briefing'
  | 'marketing'
  | 'training'
  | 'comparison';

export interface PresentationBriefQuestionSet {
  label: string;
  deck_purposes?: PresentationDeckPurpose[];
  questions: [string, ...string[]];
  notes?: string;
}

export interface PresentationThemeSet {
  label: string;
  deck_purposes?: PresentationDeckPurpose[];
  theme_hint: string;
  design_traits?: string[];
  notes?: string;
}

export function selectPresentationBriefQuestionSet(
  profile: PresentationPreferenceProfile,
  deckPurpose?: PresentationDeckPurpose | string | null
): PresentationBriefQuestionSet | undefined {
  const normalizedPurpose = deckPurpose ? String(deckPurpose) : '';
  return profile.brief_question_sets.find(
    (set) =>
      !set.deck_purposes?.length ||
      set.deck_purposes.includes(normalizedPurpose as PresentationDeckPurpose)
  );
}

export function getPresentationBriefQuestions(
  profile: PresentationPreferenceProfile,
  deckPurpose?: PresentationDeckPurpose | string | null,
  maxQuestions = 2
): { questions: string[]; omitted_count: number } {
  const questions = selectPresentationBriefQuestionSet(profile, deckPurpose)?.questions || [];
  const limit = Math.max(1, maxQuestions);
  const selected = questions.slice(0, limit);
  const omittedCount = Math.max(0, questions.length - selected.length);
  if (omittedCount > 0) {
    logger.info(
      `[presentation-preference-profile] omitted ${omittedCount} brief question(s) for deckPurpose=${deckPurpose || 'default'}`
    );
  }
  return { questions: selected, omitted_count: omittedCount };
}

export function selectPresentationThemeSet(
  profile: PresentationPreferenceProfile,
  deckPurpose?: PresentationDeckPurpose | string | null
): PresentationThemeSet | undefined {
  const normalizedPurpose = deckPurpose ? String(deckPurpose) : '';
  return profile.theme_sets.find(
    (set) =>
      !set.deck_purposes?.length ||
      set.deck_purposes.includes(normalizedPurpose as PresentationDeckPurpose)
  );
}

export function getPresentationThemeHint(
  profile: PresentationPreferenceProfile,
  deckPurpose?: PresentationDeckPurpose | string | null
): string | undefined {
  return (
    selectPresentationThemeSet(profile, deckPurpose)?.theme_hint ||
    profile.theme_selection_policy?.default_theme_hint
  );
}

export function getPresentationSlidePatternSelectionPolicy(
  profile: PresentationPreferenceProfile
): PresentationSlidePatternSelectionPolicy | undefined {
  return profile.slide_pattern_selection_policy;
}

export function getPresentationSlidePatternPackId(
  profile: PresentationPreferenceProfile
): string | undefined {
  return profile.slide_pattern_selection_policy?.pack_id;
}

export function getPresentationDefaultSlidePatternId(
  profile: PresentationPreferenceProfile
): string | undefined {
  return profile.slide_pattern_selection_policy?.default_pattern_id;
}
