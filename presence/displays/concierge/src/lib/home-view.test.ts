import { describe, expect, it } from 'vitest';
import {
  barPercent,
  inboxHref,
  loadFailureFromStatus,
  settingsHref,
  windowDelta,
  workHref,
} from './home-view';

describe('home view helpers', () => {
  it('tells a busy server (429) apart from a broken one', () => {
    expect(loadFailureFromStatus(429)).toBe('busy');
    expect(loadFailureFromStatus(401)).toBe('signin');
    expect(loadFailureFromStatus(403)).toBe('forbidden');
    expect(loadFailureFromStatus(404)).toBe('failed');
    expect(loadFailureFromStatus(503)).toBe('failed');
  });

  it('says "nothing to compare" instead of a zero delta', () => {
    expect(windowDelta(null, 0.2, 'pt')).toBeNull();
    expect(windowDelta(0.25, 0.1, 'pt')).toEqual({ direction: 'up', text: '+15 pt' });
    expect(windowDelta(3, 7.5, 'h')).toEqual({ direction: 'down', text: '−4.5 h' });
    expect(windowDelta(2, 2, 'h')).toEqual({ direction: 'flat', text: '±0 h' });
  });

  it('builds the drill-down links', () => {
    expect(inboxHref()).toBe('/inbox');
    expect(inboxHref({ reason: 'review' })).toBe('/inbox?reason=review');
    expect(inboxHref({ overdue: true })).toBe('/inbox?overdue=1');
    expect(workHref('paused')).toBe('/work?tab=missions&state=paused');
    expect(settingsHref('#settings-invites')).toBe('/settings#settings-invites');
    expect(settingsHref('javascript:alert(1)')).toBe('/settings');
  });

  it('keeps a non-zero bar visible and a zero bar empty', () => {
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(1, 1000)).toBe(2);
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(3, 0)).toBe(0);
  });
});
