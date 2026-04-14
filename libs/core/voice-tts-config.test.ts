import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { getVoiceTtsLanguageConfig, resetVoiceTtsConfigCache } from './voice-tts-config.js';

describe('voice tts config registry', () => {
  const tmpDir = pathResolver.sharedTmp('voice-tts-config-tests');
  const overridePath = `${tmpDir}/voice-hub-tts.json`;

  afterEach(() => {
    delete process.env.KYBERION_VOICE_HUB_TTS_CONFIG_PATH;
    resetVoiceTtsConfigCache();
    safeRmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads the governed japanese profile from the default registry', () => {
    const registry = JSON.parse(
      safeReadFile(pathResolver.knowledge('public/presence/voice-hub-tts.json'), { encoding: 'utf8' }) as string,
    ) as {
      languages?: Record<string, { voice: string; rate: number }>;
    };
    const expected = registry.languages?.ja;
    const config = getVoiceTtsLanguageConfig('ja');

    expect(config.voice).toBe(expected?.voice);
    expect(config.rate).toBe(expected?.rate);
  });

  it('allows overriding the registry path externally', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        defaultLanguage: 'ja',
        languages: {
          ja: {
            voice: 'Kyoko',
            rate: 170,
            requestIdToken: '受付番号',
            urlToken: 'リンク',
          },
        },
      }, null, 2),
    );
    process.env.KYBERION_VOICE_HUB_TTS_CONFIG_PATH = overridePath;
    resetVoiceTtsConfigCache();

    const config = getVoiceTtsLanguageConfig('ja');

    expect(config.voice).toBe('Kyoko');
    expect(config.rate).toBe(170);
    expect(config.requestIdToken).toBe('受付番号');
    expect(config.urlToken).toBe('リンク');
  });
});
