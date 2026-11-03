// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadMissionIntelligenceSelectedMissionId,
  saveMissionIntelligenceSelectedMissionId,
} from './MissionIntelligenceViewHelpers';

describe('mission intelligence selection', () => {
  afterEach(() => window.history.replaceState(null, '', '/ops'));

  it('keeps the focused mission in the URL and never in browser storage', () => {
    window.history.replaceState(null, '', '/ops?section=missions');
    saveMissionIntelligenceSelectedMissionId('MSN-A-1');
    expect(window.location.search).toBe('?section=missions&mission=MSN-A-1');
    expect(loadMissionIntelligenceSelectedMissionId()).toBe('MSN-A-1');
    expect(window.localStorage.length).toBe(0);
    saveMissionIntelligenceSelectedMissionId(null);
    expect(window.location.search).toBe('?section=missions');
  });

  it('ignores a malformed mission id from the URL', () => {
    window.history.replaceState(null, '', '/ops?mission=%3Cscript%3E');
    expect(loadMissionIntelligenceSelectedMissionId()).toBeNull();
  });
});
