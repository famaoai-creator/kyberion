import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTION_ORDER } from '../../lib/settings-view';
import { resolveSettingsTarget } from './settings-navigation';
import { createSettingsMenu } from './settings-menu';

describe('settings menu integration', () => {
  it.each(['en', 'ja'] as const)(
    'keeps every %s destination localized, in body order and resolvable by history navigation',
    (locale) => {
      const groups = createSettingsMenu(locale, {});
      const items = groups.flatMap((group) => group.items);
      expect(items.map((item) => item.id)).toEqual(SETTINGS_SECTION_ORDER);
      for (const item of items) {
        expect(resolveSettingsTarget(item.href)?.section).toBe(item.id);
        expect(item.label).not.toContain('settings_');
        expect(item.description).not.toContain('settings_');
        expect(item.description).toBeTruthy();
      }
    }
  );

  it('marks the sections with pending drafts without replacing their destination or name', () => {
    const clean = createSettingsMenu('ja', {}).flatMap((group) => group.items);
    const dirty = createSettingsMenu('ja', { profile: true, notifications: true }).flatMap(
      (group) => group.items
    );
    expect(dirty.filter((item) => item.badge).map((item) => item.id)).toEqual([
      'profile',
      'notifications',
    ]);
    expect(dirty.map(({ id, label, href }) => ({ id, label, href }))).toEqual(
      clean.map(({ id, label, href }) => ({ id, label, href }))
    );
  });
});
