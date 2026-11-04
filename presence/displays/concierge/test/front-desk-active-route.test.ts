import { describe, expect, it } from 'vitest';
import {
  currentItemId,
  needsYouBadgeText,
  needsYouBadgeTotal,
  railLabel,
} from '../src/app/front-desk-rail';

describe('front-desk rail current destination (MSN-SHELL-IA §1)', () => {
  it.each([
    ['/', 'home'],
    ['/inbox', 'inbox'],
    ['/work', 'work'],
    ['/org', 'org'],
    ['/library', 'library'],
    ['/ingest', 'library'],
    ['/management', 'org'],
    ['/ops', 'ops'],
    ['/ops/discussion', 'ops'],
    ['/settings', 'settings'],
    ['/setup', 'settings'],
    ['/setup/sso', 'settings'],
    ['/setup/first-run', null],
    ['/w', 'home'],
    ['/w/tenant/acme', 'org'],
    ['/w/organization', 'org'],
    ['/w/project/p-1', 'org'],
    ['/w/actor/m-1', 'org'],
    ['/w/mission/MSN-1', 'work'],
    ['/w/task/MSN-1%2Ft1', 'work'],
    ['/w/work_item', 'work'],
    ['/w/approval/a-1', 'inbox'],
    ['/wiki', null],
    ['/worker', null],
    ['/signin', null],
    ['/login', null],
    [null, null],
  ])('maps %s to %s', (pathname, expected) => {
    expect(currentItemId(pathname)).toBe(expected);
  });

  it('marks every /ops section as the operations destination', () => {
    for (const section of ['operations', 'diagnostics', 'surface-control', 'discussion', null]) {
      expect(currentItemId('/ops', section)).toBe('ops');
    }
  });
});

describe('needs-you rail badge', () => {
  it('reads total only from an ok summary payload', () => {
    expect(needsYouBadgeTotal({ ok: true, total: 4, overdue: 1 })).toBe(4);
    expect(needsYouBadgeTotal({ ok: true, total: 0 })).toBe(0);
    for (const bad of [
      null,
      undefined,
      'x',
      { ok: false, total: 3 },
      { ok: true },
      { ok: true, total: -1 },
      { ok: true, total: Number.NaN },
      { ok: true, total: '3' },
    ]) {
      expect(needsYouBadgeTotal(bad)).toBeNull();
    }
  });

  it('hides the badge at zero or on failure and caps long counts', () => {
    expect(needsYouBadgeText(null)).toBeUndefined();
    expect(needsYouBadgeText(0)).toBeUndefined();
    expect(needsYouBadgeText(7)).toBe('7');
    expect(needsYouBadgeText(120)).toBe('99+');
  });
});

describe('rail label fallback', () => {
  it('renders an unresolved server key from the bundled catalog and passes text through', () => {
    expect(railLabel('front_desk:ia_nav_home', 'ja')).toBe('ホーム');
    expect(railLabel('front_desk:ia_nav_settings', 'en')).toBe('Settings');
    expect(railLabel('仕事', 'ja')).toBe('仕事');
    expect(railLabel('front_desk:no_such_key_zz', 'ja')).toBe('');
  });
});
