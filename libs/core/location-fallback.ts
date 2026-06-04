import { secureFetch } from './network.js';
import { getSurfaceQueryProviderConfig } from './surface-query.js';

type LocationSummaryData = {
  city?: string;
  region?: string;
  region_code?: string;
  country?: string;
  country_name?: string;
  latitude?: number;
  longitude?: number;
};

type FetchLocationProvider = (options: {
  method: 'GET';
  url: string;
}) => Promise<LocationSummaryData>;

function compactStrings(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

export async function resolveFallbackLocationSummary(
  fetchLocation: FetchLocationProvider = secureFetch as FetchLocationProvider
): Promise<string> {
  const providerConfig = getSurfaceQueryProviderConfig();
  const providers = providerConfig.location?.providers || [];

  for (const provider of providers) {
    try {
      const url = String(provider.url || '').trim();
      if (!url) continue;
      const data = await fetchLocation({ method: 'GET', url });
      const parts =
        provider.provider === 'ipwho'
          ? compactStrings([data?.city, data?.region, data?.country || data?.country_name])
          : compactStrings([data?.city, data?.region || data?.region_code, data?.country_name || data?.country]);
      if (parts.length > 0) return parts.join(', ');
    } catch {
      // Try the next location provider.
    }
  }

  return 'unknown location';
}

export async function resolveFallbackLocationCoordinates(
  fetchLocation: FetchLocationProvider = secureFetch as FetchLocationProvider
): Promise<{ latitude?: number; longitude?: number; label: string }> {
  const providerConfig = getSurfaceQueryProviderConfig();
  const providers = providerConfig.location?.providers || [];

  for (const provider of providers) {
    try {
      const url = String(provider.url || '').trim();
      if (!url) continue;
      const data = await fetchLocation({ method: 'GET', url });
      const resolved =
        provider.provider === 'ipwho'
          ? {
              latitude: data?.latitude,
              longitude: data?.longitude,
              label: data?.city
                ? compactStrings([data.city, data.region, data.country]).join(', ')
                : 'current location',
            }
          : {
              latitude: data?.latitude,
              longitude: data?.longitude,
              label: data?.city
                ? compactStrings([data.city, data.region, data.country_name]).join(', ')
                : 'current location',
            };
      if (resolved.latitude !== undefined && resolved.longitude !== undefined) {
        return resolved;
      }
    } catch {
      // Try the next location provider.
    }
  }

  return { label: 'current location' };
}
