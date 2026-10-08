import { describe, expect, it } from 'vitest';
import { surfaceCaptureHeaders } from './capture_surface_screenshots.js';

describe('surface capture peer provenance', () => {
  it('uses the real local Concierge transport without a spoofed IP header', () => {
    const headers = surfaceCaptureHeaders('concierge', 'en');
    expect(headers).toEqual({ 'accept-language': 'en-US,en;q=0.9' });
    expect(headers).not.toHaveProperty('x-real-ip');
    expect(headers).not.toHaveProperty('x-forwarded-for');
  });

  it('preserves the legacy capture contract for other surfaces', () => {
    expect(surfaceCaptureHeaders('chronos-mirror-v2', 'en')).toEqual({
      'x-real-ip': '127.0.0.1',
      'accept-language': 'en-US,en;q=0.9',
    });
  });
});
