import { sanitizeIdSegment } from '../foundation/text.js';

/** Normalize an intent overlay path segment without inventing a fallback. */
export function sanitizeIntentPathSegment(value: string): string {
  return sanitizeIdSegment(value);
}
