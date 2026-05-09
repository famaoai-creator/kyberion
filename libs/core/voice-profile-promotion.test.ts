import { afterEach, describe, expect, it } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { resetVoiceProfileRegistryCache } from './voice-profile-registry.js';
import { promoteVoiceProfileFromReceipt } from './voice-profile-promotion.js';

describe('voice profile promotion', () => {
  const tmpDir = pathResolver.sharedTmp('voice-profile-promotion-tests');
  const registryPath = `${tmpDir}/voice-profile-registry.json`;
  const registryDir = `${tmpDir}/voice-profiles`;
  const personalRegistryPath = `${tmpDir}/voice-profile-registry.personal.json`;
  const receiptPath = `${tmpDir}/receipt.json`;

  afterEach(() => {
    safeRmSync(tmpDir, { recursive: true, force: true });
    safeRmSync(pathResolver.sharedTmp('voice-profile-promotion'), { recursive: true, force: true });
    delete process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH;
    delete process.env.KYBERION_VOICE_PROFILE_REGISTRY_DIR;
    delete process.env.KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH;
    resetVoiceProfileRegistryCache();
  });

  it('promotes a validated receipt into the registry', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeMkdir(registryDir, { recursive: true });
    safeWriteFile(
      registryPath,
      JSON.stringify({
        version: 'test',
        default_profile_id: 'operator-ja-default',
        profiles: [
          {
            profile_id: 'operator-ja-default',
            display_name: 'Operator JA',
            tier: 'public',
            languages: ['ja'],
            default_engine_id: 'local_say',
            status: 'active',
          },
        ],
      }),
    );
    safeWriteFile(
      receiptPath,
      JSON.stringify({
        kind: 'voice_profile_registration_receipt',
        created_at: '2026-04-23T00:00:00.000Z',
        status: 'validated_pending_promotion',
        request_id: 'voice-reg-1',
        profile: {
          profile_id: 'me-ja-live',
          display_name: 'Me JA Live',
          tier: 'personal',
          languages: ['ja'],
          default_engine_id: 'open_voice_clone',
        },
        samples: [
          { sample_id: 's1', path: 'knowledge/personal/voice/me-ja-01.wav', language: 'ja' },
          { sample_id: 's2', path: 'knowledge/personal/voice/me-ja-02.wav', language: 'ja' },
          { sample_id: 's3', path: 'knowledge/personal/voice/me-ja-03.wav', language: 'ja' },
        ],
      }),
    );
    process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH = registryPath;
    process.env.KYBERION_VOICE_PROFILE_REGISTRY_DIR = registryDir;

    const result = promoteVoiceProfileFromReceipt({
      receiptPath,
      approvedBy: 'operator',
      setAsDefault: true,
    });

    expect(result.status).toBe('succeeded');
    expect(result.profile_id).toBe('me-ja-live');

    const registry = JSON.parse(safeReadFile(registryPath, { encoding: 'utf8' }) as string) as {
      default_profile_id: string;
      profiles: Array<{ profile_id: string; status: string; sample_refs?: string[] }>;
    };
    expect(registry.default_profile_id).toBe('me-ja-live');
    const promoted = registry.profiles.find((profile) => profile.profile_id === 'me-ja-live');
    expect(promoted?.status).toBe('active');
    expect(promoted?.sample_refs).toHaveLength(3);
  });

  it('rejects receipts that are not pending promotion', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      registryPath,
      JSON.stringify({
        version: 'test',
        default_profile_id: 'operator-ja-default',
        profiles: [],
      }),
    );
    safeWriteFile(
      receiptPath,
      JSON.stringify({
        kind: 'voice_profile_registration_receipt',
        created_at: '2026-04-23T00:00:00.000Z',
        status: 'promoted',
        request_id: 'voice-reg-2',
        profile: {
          profile_id: 'me-ja-live',
          display_name: 'Me JA Live',
          tier: 'personal',
          languages: ['ja'],
          default_engine_id: 'open_voice_clone',
        },
        samples: [],
      }),
    );
    process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH = registryPath;

    expect(() =>
      promoteVoiceProfileFromReceipt({
        receiptPath,
        approvedBy: 'operator',
      }),
    ).toThrow(/not pending promotion/u);
  });

  it('writes personal promotions to the personal overlay by default', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      receiptPath,
      JSON.stringify({
        kind: 'voice_profile_registration_receipt',
        created_at: '2026-04-23T00:00:00.000Z',
        status: 'validated_pending_promotion',
        request_id: 'voice-reg-3',
        profile: {
          profile_id: 'me-ja-overlay',
          display_name: 'Me JA Overlay',
          tier: 'personal',
          languages: ['ja'],
          default_engine_id: 'open_voice_clone',
        },
        samples: [
          { sample_id: 's1', path: 'knowledge/personal/voice/me-ja-overlay-01.wav', language: 'ja' },
        ],
      }),
    );
    process.env.KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH = personalRegistryPath;

    const result = promoteVoiceProfileFromReceipt({
      receiptPath,
      approvedBy: 'operator',
      setAsDefault: true,
    });

    expect(result.registry_path).toBe(personalRegistryPath);
    const registry = JSON.parse(safeReadFile(personalRegistryPath, { encoding: 'utf8' }) as string) as {
      default_profile_id: string;
      profiles: Array<{ profile_id: string }>;
    };
    expect(registry.default_profile_id).toBe('me-ja-overlay');
    expect(registry.profiles.some((profile) => profile.profile_id === 'me-ja-overlay')).toBe(true);
  });
});
