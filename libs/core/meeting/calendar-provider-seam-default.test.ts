import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeCalendarProviderId,
  resolveCalendarProvider,
  resolveDefaultCalendarProviderId,
} from './calendar-provider-bridge.js';

afterEach(() => vi.unstubAllEnvs());

describe('calendar-provider saved seam default', () => {
  it('keeps google-workspace with no saved default', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', '');
    expect(resolveDefaultCalendarProviderId()).toBe('google-workspace');
    expect(resolveCalendarProvider().provider_id).toBe('google-workspace');
  });

  it('uses the saved default when no provider is named', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'calendar-provider=m365');
    expect(resolveCalendarProvider().provider_id).toBe('m365');
    expect(normalizeCalendarProviderId(undefined)).toBe('m365');
  });

  it('an explicit provider still wins', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'calendar-provider=m365');
    expect(resolveCalendarProvider('google-workspace').provider_id).toBe('google-workspace');
  });

  it('an unregistered saved default falls back to the policy default', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'calendar-provider=no-such-calendar');
    expect(resolveCalendarProvider().provider_id).toBe('google-workspace');
  });
});
