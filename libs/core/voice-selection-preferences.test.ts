import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

const profileRoot = vi.hoisted(() => ({ value: '' }));

vi.mock('./profile-root.js', () => ({
  resolveActiveProfileRoot: () => profileRoot.value,
}));

import { loadVoiceSelectionPreferences } from './voice-selection-preferences.js';

describe('voice-selection-preferences persistence boundary', () => {
  it('routes STT availability environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/voice-selection-preferences.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/process\.env\.(VOICE_HUB_STT|WHISPERKIT|MLX_AUDIO)/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  beforeEach(() => {
    profileRoot.value = pathResolver.sharedTmp(`voice-selection-test-${process.pid}`);
    safeRmSync(profileRoot.value, { recursive: true, force: true });
  });

  it('loads a schema-valid selection through the catalog', () => {
    const filePath = path.join(profileRoot.value, 'onboarding', 'voice-selection.json');
    safeMkdir(path.dirname(filePath), { recursive: true });
    safeWriteFile(
      filePath,
      JSON.stringify({
        version: '1.0.0',
        tts_engine_id: 'local_say',
        stt_backend: 'mlx_whisper',
        updated_at: '2026-09-03T00:00:00.000Z',
      })
    );

    expect(loadVoiceSelectionPreferences()).toMatchObject({
      version: '1.0.0',
      tts_engine_id: 'local_say',
      stt_backend: 'mlx_whisper',
    });
  });

  it('falls back when persisted state is schema-invalid or not a regular file', () => {
    const filePath = path.join(profileRoot.value, 'onboarding', 'voice-selection.json');
    safeMkdir(path.dirname(filePath), { recursive: true });
    safeWriteFile(
      filePath,
      JSON.stringify({
        version: '1.0.0',
        tts_engine_id: 'local_say',
        stt_backend: 'auto',
        unexpected: true,
      })
    );
    expect(loadVoiceSelectionPreferences()).toBeNull();

    safeRmSync(filePath, { force: true });
    safeMkdir(filePath, { recursive: true });
    expect(loadVoiceSelectionPreferences()).toBeNull();
    safeRmSync(profileRoot.value, { recursive: true, force: true });
  });
});
