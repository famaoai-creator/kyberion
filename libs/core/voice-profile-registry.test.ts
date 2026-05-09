import { afterEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';

const mocks = vi.hoisted(() => ({
  customerRoot: vi.fn(() => null as string | null),
}));

vi.mock('./customer-resolver.js', () => ({
  customerRoot: mocks.customerRoot,
}));

import {
  getVoiceProfileRecord,
  getVoiceProfileRegistry,
  listVoiceProfiles,
  resetVoiceProfileRegistryCache,
} from './voice-profile-registry.js';

describe('voice profile registry', () => {
  const tmpDir = pathResolver.sharedTmp('voice-profile-registry-tests');
  const overridePath = `${tmpDir}/voice-profile-registry.json`;
  const customerOverlayPath = `${tmpDir}/voice-profile-registry.customer.json`;
  const overlayPath = `${tmpDir}/voice-profile-registry.personal.json`;

  afterEach(() => {
    delete process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH;
    delete process.env.KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH;
    mocks.customerRoot.mockReturnValue(null);
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

  it('keeps explicit registry overrides isolated from the personal overlay', () => {
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
        ],
      }),
    );
    safeWriteFile(
      overlayPath,
      JSON.stringify({
        version: 'test',
        default_profile_id: 'me-ja',
        profiles: [
          {
            profile_id: 'me-ja',
            display_name: 'Personal Japanese',
            tier: 'personal',
            languages: ['ja'],
            sample_refs: ['active/shared/tmp/sample-01.wav'],
            default_engine_id: 'open_voice_clone',
            status: 'active',
          },
        ],
      }),
    );
    process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH = overridePath;
    process.env.KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH = overlayPath;

    const registry = getVoiceProfileRegistry();
    expect(registry.default_profile_id).toBe('ja-default');
    expect(registry.profiles).toHaveLength(1);
  });

  it('prefers the customer overlay when one is active', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      customerOverlayPath,
      JSON.stringify({
        version: 'test',
        default_profile_id: 'customer-ja',
        profiles: [
          {
            profile_id: 'customer-ja',
            display_name: 'Customer Japanese',
            tier: 'personal',
            languages: ['ja'],
            sample_refs: ['active/shared/tmp/customer-sample.wav'],
            default_engine_id: 'open_voice_clone',
            status: 'active',
          },
        ],
      }),
    );
    safeWriteFile(
      overlayPath,
      JSON.stringify({
        version: 'test',
        default_profile_id: 'me-ja',
        profiles: [
          {
            profile_id: 'me-ja',
            display_name: 'Personal Japanese',
            tier: 'personal',
            languages: ['ja'],
            sample_refs: ['active/shared/tmp/sample-01.wav'],
            default_engine_id: 'open_voice_clone',
            status: 'active',
          },
        ],
      }),
    );
    mocks.customerRoot.mockReturnValue(customerOverlayPath);
    process.env.KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH = overlayPath;

    const registry = getVoiceProfileRegistry();
    expect(registry.default_profile_id).toBe('customer-ja');
    expect(getVoiceProfileRecord().profile_id).toBe('customer-ja');
    expect(registry.profiles.some((profile) => profile.profile_id === 'customer-ja')).toBe(true);
    expect(registry.profiles.some((profile) => profile.profile_id === 'me-ja')).toBe(true);
  });

  it('merges the personal overlay when using the default public registry', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overlayPath,
      JSON.stringify({
        version: 'test',
        default_profile_id: 'me-ja',
        profiles: [
          {
            profile_id: 'me-ja',
            display_name: 'Personal Japanese',
            tier: 'personal',
            languages: ['ja'],
            sample_refs: ['active/shared/tmp/sample-01.wav'],
            default_engine_id: 'open_voice_clone',
            status: 'active',
          },
        ],
      }),
    );
    process.env.KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH = overlayPath;

    const registry = getVoiceProfileRegistry();
    expect(registry.default_profile_id).toBe('me-ja');
    expect(getVoiceProfileRecord().profile_id).toBe('me-ja');
    expect(registry.profiles.some((profile) => profile.profile_id === 'me-ja')).toBe(true);
  });
});
