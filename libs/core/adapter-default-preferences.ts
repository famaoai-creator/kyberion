export const ADAPTER_DEFAULT_KEYS = [
  'media.image',
  'media.video',
  'media.music',
  'service.runtime',
  'tool.runtime',
  'voice.vad',
] as const;

export type AdapterDefaultKey = (typeof ADAPTER_DEFAULT_KEYS)[number];

export interface AdapterDefaultPreferences {
  version: '1.0.0';
  defaults: Partial<Record<AdapterDefaultKey, string>>;
  updated_at?: string;
}

const EMPTY_PREFERENCES: AdapterDefaultPreferences = {
  version: '1.0.0',
  defaults: {},
};

let activePreferences: AdapterDefaultPreferences = EMPTY_PREFERENCES;

export function loadAdapterDefaultPreferences(): AdapterDefaultPreferences {
  return {
    ...activePreferences,
    defaults: { ...activePreferences.defaults },
  };
}

export function setAdapterDefaultPreferences(
  preferences: AdapterDefaultPreferences
): AdapterDefaultPreferences {
  activePreferences = {
    version: '1.0.0',
    defaults: { ...preferences.defaults },
    updated_at: preferences.updated_at,
  };
  return loadAdapterDefaultPreferences();
}

export function resetAdapterDefaultPreferences(): void {
  activePreferences = { ...EMPTY_PREFERENCES, defaults: {} };
}

export function getAdapterDefault(key: AdapterDefaultKey): string | undefined {
  return activePreferences.defaults[key];
}
