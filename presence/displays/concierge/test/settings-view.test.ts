import { describe, expect, it } from 'vitest';
import {
  SETUP_CHECKLIST_ANCHORS,
  SETUP_CHECKLIST_ORDER,
} from '@agent/core/surface/setup-checklist-model';
import { frontDeskText } from '../src/lib/i18n';
import {
  CHECKLIST_SECTION,
  SETTINGS_CARDS,
  SETTINGS_SECTION_ELEMENT_ID,
  SETTINGS_SECTION_ORDER,
  filterSettingsCards,
  orderSectionsForFirstRun,
  settingsCategoryOf,
  type SettingsReadinessItem,
} from '../src/lib/settings-view';

const ok = (id: string): SettingsReadinessItem => ({ id, status: 'ok' });
const incomplete = (id: string): SettingsReadinessItem => ({ id, status: 'incomplete' });
const error = (id: string): SettingsReadinessItem => ({ id, status: 'error' });

describe('settings IA catalog', () => {
  it('has the nine categories of the IA contract, in order, with はじめに first', () => {
    expect(SETTINGS_SECTION_ORDER).toEqual([
      'start',
      'workspace',
      'agents',
      'notifications',
      'connections',
      'data',
      'budget',
      'display',
      'advanced',
    ]);
    expect(frontDeskText('ia_settings_cat_start', 'ja')).toBe('はじめに');
  });

  it('gives every card a unique, stable id and keeps the legacy anchors', () => {
    const ids = SETTINGS_CARDS.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const legacy of [
      'setup-profile',
      'settings-display',
      'settings-members',
      'setup-services',
      'setup-media',
      'setup-notifications',
      'settings-recording',
      'settings-authority',
      'setup-plugins',
      'settings-advanced',
    ])
      expect(ids).toContain(legacy);
    expect(settingsCategoryOf('setup-governance')).toBe('advanced');
    expect(settingsCategoryOf('settings-charter')).toBe('agents');
    expect(settingsCategoryOf(SETTINGS_SECTION_ELEMENT_ID.budget)).toBe('budget');
    expect(settingsCategoryOf('nope')).toBeNull();
  });

  it('puts the reasoning model in exactly one card, under エージェントと自律度', () => {
    const reasoning = SETTINGS_CARDS.filter((card) => card.id === 'settings-reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].category).toBe('agents');
  });

  it('points every checklist step at a card that exists', () => {
    for (const step of SETUP_CHECKLIST_ORDER) {
      expect(SETTINGS_CARDS.map((card) => card.id)).toContain(SETUP_CHECKLIST_ANCHORS[step]);
    }
    expect(CHECKLIST_SECTION.reasoning).toBe('agents');
    expect(CHECKLIST_SECTION.identity).toBe('workspace');
    expect(CHECKLIST_SECTION.trial_mission).toBe('start');
  });

  it('filters cards by translated label, description and category', () => {
    const ja = (key: Parameters<typeof frontDeskText>[0]) => frontDeskText(key, 'ja');
    expect(filterSettingsCards('', ja)).toHaveLength(SETTINGS_CARDS.length);
    expect(filterSettingsCards('モデル', ja).map((card) => card.id)).toContain(
      'settings-reasoning'
    );
    expect(filterSettingsCards('ＳＳＯ', ja).map((card) => card.id)).toContain('settings-sso');
    expect(filterSettingsCards('通知', ja).map((card) => card.id)).toContain('setup-notifications');
    expect(filterSettingsCards('zzzz-no-match', ja)).toEqual([]);
    const en = (key: Parameters<typeof frontDeskText>[0]) => frontDeskText(key, 'en');
    expect(filterSettingsCards('budget', en).map((card) => card.id)).toContain('settings-budget');
  });
});

describe('orderSectionsForFirstRun', () => {
  it('returns the canonical order when everything is done or nothing is known', () => {
    expect(orderSectionsForFirstRun([])).toEqual([...SETTINGS_SECTION_ORDER]);
    expect(orderSectionsForFirstRun([ok('identity'), ok('profile')])).toEqual([
      ...SETTINGS_SECTION_ORDER,
    ]);
  });

  it('visits the categories of unfinished steps first, in the checklist order', () => {
    const order = orderSectionsForFirstRun([
      ok('identity'),
      incomplete('reasoning'),
      ok('autonomy'),
      incomplete('notifications'),
      incomplete('budget'),
      error('avatar'),
    ]);
    expect(order.slice(0, 3)).toEqual(['agents', 'notifications', 'budget']);
    expect(order).toHaveLength(SETTINGS_SECTION_ORDER.length);
    expect(new Set(order).size).toBe(order.length);
  });

  it('deduplicates categories shared by several items and ignores unknown ids', () => {
    const order = orderSectionsForFirstRun([
      incomplete('avatar'),
      incomplete('voice'),
      incomplete('unknown-thing'),
    ]);
    expect(order[0]).toBe('agents');
    expect(order.filter((id) => id === 'agents')).toHaveLength(1);
  });
});
