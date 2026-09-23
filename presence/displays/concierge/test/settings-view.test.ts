import { describe, expect, it } from 'vitest';
import {
  orderSectionsForFirstRun,
  SETTINGS_CARD_SECTION_ORDER,
  SETTINGS_SECTION_ORDER,
  type SettingsReadinessItem,
} from '../src/lib/settings-view';

const ok = (id: string): SettingsReadinessItem => ({ id, status: 'ok' });
const incomplete = (id: string): SettingsReadinessItem => ({ id, status: 'incomplete' });
const error = (id: string): SettingsReadinessItem => ({ id, status: 'error' });

describe('orderSectionsForFirstRun', () => {
  it('lists 表示 (display) in the sub-nav right after profile but never as its own card', () => {
    expect(SETTINGS_SECTION_ORDER.indexOf('display')).toBe(
      SETTINGS_SECTION_ORDER.indexOf('profile') + 1
    );
    expect(SETTINGS_CARD_SECTION_ORDER).not.toContain('display');
    expect(orderSectionsForFirstRun([incomplete('voice')])).not.toContain('display');
  });

  it('returns the canonical order when every diagnostic is ok', () => {
    const readiness = [
      ok('profile'),
      ok('avatar'),
      ok('voice'),
      ok('services'),
      ok('notifications'),
      ok('reasoning'),
    ];
    expect(orderSectionsForFirstRun(readiness)).toEqual([...SETTINGS_CARD_SECTION_ORDER]);
  });

  it('returns the canonical order when there is no readiness data at all', () => {
    expect(orderSectionsForFirstRun([])).toEqual([...SETTINGS_CARD_SECTION_ORDER]);
  });

  it('sorts incomplete/error sections first, in canonical order, ahead of complete ones', () => {
    const readiness = [
      ok('profile'),
      ok('avatar'),
      incomplete('voice'),
      ok('services'),
      incomplete('notifications'),
      error('reasoning'),
    ];
    expect(orderSectionsForFirstRun(readiness)).toEqual([
      'voice',
      'notifications',
      'advanced',
      'profile',
      'members',
      'services',
      'recording',
      'plugins',
    ]);
  });

  it('deduplicates sections shared by multiple diagnostics (avatar + voice both map to voice)', () => {
    const readiness = [incomplete('avatar'), incomplete('voice')];
    const order = orderSectionsForFirstRun(readiness);
    expect(order.filter((id) => id === 'voice')).toHaveLength(1);
    expect(order[0]).toBe('voice');
  });

  it('ignores diagnostics that do not map to a settings section', () => {
    const readiness = [incomplete('unknown-thing')];
    expect(orderSectionsForFirstRun(readiness)).toEqual([...SETTINGS_CARD_SECTION_ORDER]);
  });

  it('never surfaces "members" ahead of others on its own — it has no diagnostic yet', () => {
    const readiness = [incomplete('profile')];
    const order = orderSectionsForFirstRun(readiness);
    expect(order[0]).toBe('profile');
    expect(order.indexOf('members')).toBeGreaterThan(order.indexOf('profile'));
  });

  it('never surfaces "recording" ahead of others on its own — it has no diagnostic yet', () => {
    const readiness = [incomplete('profile')];
    const order = orderSectionsForFirstRun(readiness);
    expect(order[0]).toBe('profile');
    expect(order.indexOf('recording')).toBeGreaterThan(order.indexOf('profile'));
  });
});
