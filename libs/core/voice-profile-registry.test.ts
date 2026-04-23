import { afterEach, describe, expect, it } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';
import {
  getVoiceProfileRecord,
  getVoiceProfileRegistry,
  listVoiceProfiles,
  resetVoiceProfileRegistryCache,
} from './voice-profile-registry.js';

describe('voice profile registry', () => {
  const tmpDir = pathResolver.sharedTmp('voice-profile-registry-tests');
  const overridePath = `${tmpDir}/voice-profile-registry.json`;

  afterEach(() => {
    delete process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH;
    resetVoiceProfileRegistryCache();
  });

  it('loads profiles from override registry files', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        version: 'test',
        default_profile_id: 'ja-default',
        profiles: [
          {
            profile_id: 'ja-default',
            display_name: 'Japanese Default',
            tier: 'public',
            languages: ['ja'],
            default_engine_id: 'local_say',
            status: 'active',
          },
          {
            profile_id: 'shadow-en',
            display_name: 'Shadow English',
            tier: 'confidential',
            languages: ['en'],
            default_engine_id: 'open_voice_clone',
            status: 'shadow',
          },
        ],
      }),
    );
    process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH = overridePath;

    const registry = getVoiceProfileRegistry();
    expect(registry.default_profile_id).toBe('ja-default');
    expect(getVoiceProfileRecord().profile_id).toBe('ja-default');
    expect(listVoiceProfiles('shadow')).toHaveLength(1);
  });
});
