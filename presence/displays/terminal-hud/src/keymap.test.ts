import { describe, expect, it } from 'vitest';
import {
  GLOBAL_HELP,
  PANELS,
  PANEL_LABEL_KEYS,
  isPanelId,
  nextPanel,
  panelForDigit,
} from './keymap.js';

describe('keymap', () => {
  it('maps digits 1..8 to panels in order', () => {
    expect(panelForDigit('1')).toBe('missions');
    expect(panelForDigit('8')).toBe('settings');
    expect(panelForDigit('9')).toBeUndefined();
    expect(panelForDigit('0')).toBeUndefined();
    expect(panelForDigit('x')).toBeUndefined();
  });

  it('cycles panels in both directions with wrap-around', () => {
    expect(nextPanel('missions', 1)).toBe('tasks');
    expect(nextPanel('settings', 1)).toBe('missions');
    expect(nextPanel('missions', -1)).toBe('settings');
  });

  it('recognizes valid panel ids', () => {
    for (const panel of PANELS) expect(isPanelId(panel)).toBe(true);
    expect(isPanelId('nope')).toBe(false);
  });

  it('has a vocabulary label key for every panel and help row', () => {
    for (const panel of PANELS) expect(PANEL_LABEL_KEYS[panel]).toMatch(/^tui:/);
    for (const row of GLOBAL_HELP) expect(row.labelKey).toMatch(/^tui:/);
  });
});
