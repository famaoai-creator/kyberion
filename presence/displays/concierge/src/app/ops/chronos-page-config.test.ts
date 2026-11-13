import { describe, expect, it } from 'vitest';

import {
  CHRONOS_NAV_GROUPS,
  CONSOLE_SECTIONS,
  OPS_DEFAULT_SECTION,
  OPS_MOVED_SECTIONS,
  chronosNavGroupFor,
  resolveConsoleSectionParam,
} from './chronos-page-config';

describe('MSN-SHELL-IA /ops sections (operations only)', () => {
  it('renders only the four operations sections; everything else moved out', () => {
    expect(CHRONOS_NAV_GROUPS.map((group) => group.id)).toEqual(['operate']);
    expect(CHRONOS_NAV_GROUPS[0].sections).toEqual([
      'operations',
      'surface-control',
      'diagnostics',
      'discussion',
    ]);
    for (const id of CHRONOS_NAV_GROUPS[0].sections) {
      expect(CONSOLE_SECTIONS.some((section) => section.id === id)).toBe(true);
      expect(OPS_MOVED_SECTIONS.has(id)).toBe(false);
    }
    expect(OPS_DEFAULT_SECTION).toBe('operations');
  });

  it('resolves only sections /ops still renders', () => {
    expect(resolveConsoleSectionParam('diagnostics')).toBe('diagnostics');
    expect(resolveConsoleSectionParam('surface')).toBe('surface');
    for (const moved of [
      'home',
      'missions',
      'deliverables',
      'approvals',
      'governance',
      'knowledge',
    ]) {
      expect(resolveConsoleSectionParam(moved)).toBeNull();
      expect(OPS_MOVED_SECTIONS.has(moved)).toBe(true);
    }
    expect(resolveConsoleSectionParam('nope')).toBeNull();
    expect(resolveConsoleSectionParam(null)).toBeNull();
    expect(chronosNavGroupFor('diagnostics')).toBe('operate');
  });
});
