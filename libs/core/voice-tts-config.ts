import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';

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

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge('public/presence/voice-hub-tts.json');

const FALLBACK_REGISTRY: { defaultLanguage: string; languages: Record<string, VoiceTtsLanguageConfig> } = {
  defaultLanguage: 'ja',
  languages: {
    ja: {
      voice: 'Eddy (日本語（日本）)',
      rate: 185,
      requestIdToken: 'リクエストID',
      urlToken: 'URL',
    },
    en: {
      voice: 'Samantha',
      rate: 195,
      requestIdToken: 'request id',
      urlToken: 'link',
    },
  },
};

let cachedRegistryPath: string | null = null;
let cachedDefaultLanguage: string | null = null;
let cachedLanguages: Record<string, VoiceTtsLanguageConfig> | null = null;

function getRegistryPath(): string {
  const overridePath = process.env.KYBERION_VOICE_HUB_TTS_CONFIG_PATH?.trim();
  return overridePath || DEFAULT_REGISTRY_PATH;
}

function loadRegistry(): { defaultLanguage: string; languages: Record<string, VoiceTtsLanguageConfig> } {
  const registryPath = getRegistryPath();
  if (cachedRegistryPath === registryPath && cachedDefaultLanguage && cachedLanguages) {
    return {
      defaultLanguage: cachedDefaultLanguage,
      languages: cachedLanguages,
    };
  }

  if (!safeExistsSync(registryPath)) {
    cachedRegistryPath = registryPath;
    cachedDefaultLanguage = FALLBACK_REGISTRY.defaultLanguage;
    cachedLanguages = FALLBACK_REGISTRY.languages;
    return FALLBACK_REGISTRY;
  }

  try {
    const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
    const parsed = safeJsonParse<VoiceTtsConfigRegistry>(raw, 'voice tts config registry');
    const languages = {
      ...FALLBACK_REGISTRY.languages,
      ...(parsed.languages || {}),
    };
    const defaultLanguage =
      typeof parsed.defaultLanguage === 'string' && parsed.defaultLanguage in languages
        ? parsed.defaultLanguage
        : FALLBACK_REGISTRY.defaultLanguage;
    cachedRegistryPath = registryPath;
    cachedDefaultLanguage = defaultLanguage;
    cachedLanguages = languages;
    return {
      defaultLanguage,
      languages,
    };
  } catch (error: any) {
    logger.warn(`[VOICE_TTS_CONFIG] Failed to load registry at ${registryPath}: ${error.message}`);
    cachedRegistryPath = registryPath;
    cachedDefaultLanguage = FALLBACK_REGISTRY.defaultLanguage;
    cachedLanguages = FALLBACK_REGISTRY.languages;
    return FALLBACK_REGISTRY;
  }
}

export function resetVoiceTtsConfigCache(): void {
  cachedRegistryPath = null;
  cachedDefaultLanguage = null;
  cachedLanguages = null;
}

export function getVoiceTtsLanguageConfig(language?: string): VoiceTtsLanguageConfig {
  const registry = loadRegistry();
  const normalizedLanguage =
    typeof language === 'string' && language.trim().length > 0
      ? language.trim().toLowerCase()
      : registry.defaultLanguage;
  return registry.languages[normalizedLanguage] || registry.languages[registry.defaultLanguage];
}
