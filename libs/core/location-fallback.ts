import { secureFetch } from './network.js';
import { getSurfaceQueryProviderConfig } from './surface/surface-query.js';
import { currentScope } from './scope-context.js';

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

const DEFAULT_LOCATION_RESPONSE_FIELDS = {
  city: ['city'],
  region: ['region', 'region_code'],
  country: ['country_name', 'country'],
  latitude: ['latitude'],
  longitude: ['longitude'],
} as const;

function readMappedValue(
  data: LocationSummaryData,
  paths: string[] | undefined,
  fallback: readonly string[]
): unknown {
  for (const fieldPath of paths?.length ? paths : fallback) {
    let value: unknown = data;
    for (const segment of fieldPath.split('.')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, segment)) {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[segment];
    }
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeLocationData(
  data: LocationSummaryData,
  fields:
    | {
        city?: string[];
        region?: string[];
        country?: string[];
        latitude?: string[];
        longitude?: string[];
      }
    | undefined
): LocationSummaryData {
  const city = readMappedValue(data, fields?.city, DEFAULT_LOCATION_RESPONSE_FIELDS.city);
  const region = readMappedValue(data, fields?.region, DEFAULT_LOCATION_RESPONSE_FIELDS.region);
  const country = readMappedValue(data, fields?.country, DEFAULT_LOCATION_RESPONSE_FIELDS.country);
  const latitude = readMappedValue(
    data,
    fields?.latitude,
    DEFAULT_LOCATION_RESPONSE_FIELDS.latitude
  );
  const longitude = readMappedValue(
    data,
    fields?.longitude,
    DEFAULT_LOCATION_RESPONSE_FIELDS.longitude
  );
  return {
    ...(typeof city === 'string' ? { city } : {}),
    ...(typeof region === 'string' ? { region } : {}),
    ...(typeof country === 'string' ? { country } : {}),
    ...(typeof latitude === 'number' ? { latitude } : {}),
    ...(typeof longitude === 'number' ? { longitude } : {}),
  };
}

export async function resolveFallbackLocationSummary(
  fetchLocation: FetchLocationProvider = secureFetch as FetchLocationProvider
): Promise<string> {
  const providerConfig = getSurfaceQueryProviderConfig({ scope: currentScope() });
  const providers = providerConfig.location?.providers || [];

  for (const provider of providers) {
    try {
      const url = String(provider.url || '').trim();
      if (!url) continue;
      const response = await fetchLocation({ method: 'GET', url });
      const data = normalizeLocationData(response, provider.response_fields);
      const parts = compactStrings([data.city, data.region, data.country]);
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
  const providerConfig = getSurfaceQueryProviderConfig({ scope: currentScope() });
  const providers = providerConfig.location?.providers || [];

  for (const provider of providers) {
    try {
      const url = String(provider.url || '').trim();
      if (!url) continue;
      const response = await fetchLocation({ method: 'GET', url });
      const data = normalizeLocationData(response, provider.response_fields);
      const resolved = {
        latitude: data.latitude,
        longitude: data.longitude,
        label: data.city
          ? compactStrings([data.city, data.region, data.country]).join(', ')
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
