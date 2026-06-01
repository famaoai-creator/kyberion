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

export async function resolveFallbackLocationSummary(
  fetchLocation: FetchLocationProvider = secureFetch as FetchLocationProvider
): Promise<string> {
  const providerConfig = getSurfaceQueryProviderConfig();
  const providers = providerConfig.location?.providers || [];

  for (const provider of providers) {
    try {
      const data = await fetchLocation({ method: 'GET', url: provider.url });
      const parts =
        provider.provider === 'ipwho'
          ? [data?.city, data?.region, data?.country || data?.country_name].filter(Boolean)
          : [data?.city, data?.region || data?.region_code, data?.country_name || data?.country].filter(
              Boolean
            );
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
      const data = await fetchLocation({ method: 'GET', url: provider.url });
      const resolved =
        provider.provider === 'ipwho'
          ? {
              latitude: data?.latitude,
              longitude: data?.longitude,
              label: data?.city
                ? [data.city, data.region, data.country].filter(Boolean).join(', ')
                : 'current location',
            }
          : {
              latitude: data?.latitude,
              longitude: data?.longitude,
              label: data?.city
                ? [data.city, data.region, data.country_name].filter(Boolean).join(', ')
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
