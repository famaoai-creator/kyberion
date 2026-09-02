import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadState: vi.fn(),
}));

vi.mock('@agent/core/mission-state', () => ({
  loadState: mocks.loadState,
}));

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

  it('uses schema-validated mission state before the legacy path fallback', () => {
    mocks.loadState.mockReturnValue({ tier: 'confidential' });

    expect(
      resolveOutcomePreviewTier('MSN-CONFIDENTIAL', ['active/projects/public/report.md'])
    ).toBe('confidential');
  });
});
