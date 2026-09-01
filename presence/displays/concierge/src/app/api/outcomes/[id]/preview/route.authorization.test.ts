import { describe, expect, it } from 'vitest';
import { resolveOutcomePreviewTier } from './route';

describe('Concierge outcome preview tier resolution', () => {
  it('uses one canonical path tier for legacy entries', () => {
    expect(resolveOutcomePreviewTier(undefined, ['active/projects/public/report.md'])).toBe(
      'public'
    );
  });

  it('fails closed when artifact paths disagree or carry no tier', () => {
    expect(
      resolveOutcomePreviewTier(undefined, [
        'active/projects/public/report.md',
        'active/projects/confidential/notes.md',
      ])
    ).toBeUndefined();
    expect(resolveOutcomePreviewTier(undefined, ['active/projects/report.md'])).toBeUndefined();
    expect(
      resolveOutcomePreviewTier(undefined, ['active/shared/exports/public/report.md'])
    ).toBeUndefined();
  });
});
