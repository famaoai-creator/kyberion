import { describe, expect, it, vi } from 'vitest';
import {
  resolveFallbackLocationCoordinates,
  resolveFallbackLocationSummary,
} from './location-fallback.js';

describe('location-fallback', () => {
  it('falls back from ipapi to ipwho for location summaries', async () => {
    const fetchLocation = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipapi blocked'))
      .mockResolvedValueOnce({
        city: 'Tokyo',
        region: 'Tokyo',
        country: 'Japan',
        latitude: 35.6762,
        longitude: 139.6503,
      });

    await expect(resolveFallbackLocationSummary(fetchLocation)).resolves.toBe(
      'Tokyo, Tokyo, Japan'
    );
    expect(fetchLocation).toHaveBeenNthCalledWith(1, {
      method: 'GET',
      url: 'https://ipapi.co/json/',
    });
    expect(fetchLocation).toHaveBeenNthCalledWith(2, {
      method: 'GET',
      url: 'https://ipwho.is/',
    });
  });

  it('falls back from ipapi to ipwho for coordinates', async () => {
    const fetchLocation = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipapi blocked'))
      .mockResolvedValueOnce({
        city: 'Tokyo',
        region: 'Tokyo',
        country: 'Japan',
        latitude: 35.6762,
        longitude: 139.6503,
      });

    await expect(resolveFallbackLocationCoordinates(fetchLocation)).resolves.toEqual({
      latitude: 35.6762,
      longitude: 139.6503,
      label: 'Tokyo, Tokyo, Japan',
    });
  });

  it('returns an unknown location sentinel when both providers fail', async () => {
    const fetchLocation = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipapi blocked'))
      .mockRejectedValueOnce(new Error('ipwho blocked'));

    await expect(resolveFallbackLocationSummary(fetchLocation)).resolves.toBe('unknown location');
    await expect(resolveFallbackLocationCoordinates(fetchLocation)).resolves.toEqual({
      label: 'current location',
    });
  });
});
