import type { BookingPreferenceProfile } from './src/types/booking-preference-profile.js';

export type BookingCategory =
  | 'hotel'
  | 'restaurant'
  | 'flight'
  | 'rail'
  | 'activity'
  | 'package'
  | 'shopping'
  | 'medical'
  | 'subscription'
  | 'home_service'
  | 'family'
  | 'gifts';

export interface BookingPreflightQuestionSet {
  label: string;
  categories?: BookingCategory[];
  questions: [string, ...string[]];
  notes?: string;
}

export function selectBookingPreflightQuestionSet(
  profile: BookingPreferenceProfile,
  category?: BookingCategory | string | null
): BookingPreflightQuestionSet | undefined {
  const normalizedCategory = category ? String(category) : '';
  const sets = profile.site_selection_policy?.preflight_question_sets || [];
  return sets.find(
    (set) =>
      Array.isArray(set.categories) &&
      set.categories.includes(normalizedCategory as BookingCategory)
  );
}

export function getBookingPreflightQuestions(
  profile: BookingPreferenceProfile,
  category?: BookingCategory | string | null
): string[] {
  return selectBookingPreflightQuestionSet(profile, category)?.questions || [];
}
