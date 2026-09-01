import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath } from './secure-io.js';

export interface VoiceTtsLanguageConfig {
  voice: string;
  rate: number;
  requestIdToken?: string;
  urlToken?: string;
}

interface VoiceTtsConfigRegistry {
  defaultLanguage?: string;
  languages?: Record<string, VoiceTtsLanguageConfig>;
}

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge('product/presence/voice-hub-tts.json');

const FALLBACK_REGISTRY: {
  defaultLanguage: string;
  languages: Record<string, VoiceTtsLanguageConfig>;
} = {
  defaultLanguage: 'en',
  languages: {
    en: {
      voice: 'default',
      rate: 180,
    },
  },
};

const voiceTtsConfigCatalog = defineCatalog<VoiceTtsConfigRegistry>({
  id: 'voice-tts-config',
  path: getRegistryPath,
  schema: pathResolver.knowledge('product/schemas/voice-tts-config.schema.json'),
  fallback: () => FALLBACK_REGISTRY,
  fallbackOnInvalid: true,
  onFallback: (error) => {
    if (!String(error).includes('missing')) {
      logger.warn(`[VOICE_TTS_CONFIG] Failed to load registry: ${String(error)}`);
    }
  },
});

let cachedRegistryPath: string | null = null;
let cachedDefaultLanguage: string | null = null;
let cachedLanguages: Record<string, VoiceTtsLanguageConfig> | null = null;

function getRegistryPath(): string {
  const overridePath = getRegisteredEnvText('KYBERION_VOICE_HUB_TTS_CONFIG_PATH')?.trim();
  return assertSafeRepositoryPath(overridePath || DEFAULT_REGISTRY_PATH, {
    allowMissingLeaf: true,
  });
}

function loadRegistry(): {
  defaultLanguage: string;
  languages: Record<string, VoiceTtsLanguageConfig>;
} {
  let registryPath: string;
  try {
    registryPath = getRegistryPath();
  } catch (error) {
    logger.warn(
      `[VOICE_TTS_CONFIG] Unsafe registry path; using fallback: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return FALLBACK_REGISTRY;
  }
  if (cachedRegistryPath === registryPath && cachedDefaultLanguage && cachedLanguages) {
    return {
      defaultLanguage: cachedDefaultLanguage,
      languages: cachedLanguages,
    };
  }

  const parsed = voiceTtsConfigCatalog.load();
  const languages = {
    ...FALLBACK_REGISTRY.languages,
    ...(parsed.languages || {}),
  };
  const firstLanguage = Object.keys(languages)[0];
  const defaultLanguage =
    typeof parsed.defaultLanguage === 'string' && parsed.defaultLanguage in languages
      ? parsed.defaultLanguage
      : firstLanguage || FALLBACK_REGISTRY.defaultLanguage;
  cachedRegistryPath = registryPath;
  cachedDefaultLanguage = defaultLanguage;
  cachedLanguages = languages;
  return {
    defaultLanguage,
    languages,
  };
}

export function _resetVoiceTtsConfigCacheForTests(): void {
  cachedRegistryPath = null;
  cachedDefaultLanguage = null;
  cachedLanguages = null;
  voiceTtsConfigCatalog.reset();
}

export function getVoiceTtsLanguageConfig(language?: string): VoiceTtsLanguageConfig {
  const registry = loadRegistry();
  const normalizedLanguage =
    typeof language === 'string' && language.trim().length > 0
      ? language.trim().toLowerCase()
      : registry.defaultLanguage;
  return registry.languages[normalizedLanguage] || registry.languages[registry.defaultLanguage];
}
