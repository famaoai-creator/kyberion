import type { PresentationPreferenceProfile } from './src/types/presentation-preference-profile.js';

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
  deckPurpose?: PresentationDeckPurpose | string | null
): string[] {
  return selectPresentationBriefQuestionSet(profile, deckPurpose)?.questions || [];
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
