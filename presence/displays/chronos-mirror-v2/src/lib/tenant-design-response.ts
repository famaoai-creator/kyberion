import { isRecord } from '@agent/core/foundation/primitives';

export type TenantDesignResponse = {
  source: string;
  brand_name: string | null;
  css_vars: Record<string, string>;
};

export function parseTenantDesignResponse(value: unknown): TenantDesignResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.source !== 'string' ||
    !value.source.trim() ||
    (value.brand_name !== null && typeof value.brand_name !== 'string') ||
    !isRecord(value.css_vars)
  )
    return undefined;
  const css_vars: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.css_vars)) {
    if (!key.startsWith('--') || key.length < 3 || typeof entry !== 'string') return undefined;
    css_vars[key] = entry;
  }
  return { source: value.source, brand_name: value.brand_name, css_vars };
}
