import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAdapterDefaultPreferences } from './adapter-default-preferences.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync } from './secure-io.js';

const PROFILE_ROOT = pathResolver.sharedTmp('adapter-default-selection-tests/profile');

vi.mock('./profile-root.js', () => ({
  resolveActiveProfileRoot: () => PROFILE_ROOT,
}));

beforeEach(() => {
  safeRmSync(pathResolver.sharedTmp('adapter-default-selection-tests'), {
    recursive: true,
    force: true,
  });
});

afterEach(() => {
  resetAdapterDefaultPreferences();
  safeRmSync(pathResolver.sharedTmp('adapter-default-selection-tests'), {
    recursive: true,
    force: true,
  });
  vi.restoreAllMocks();
});

describe('adapter default selection', () => {
  it('exposes candidates from the governed runtime registries', async () => {
    const { getAdapterDefaultSelectionSnapshot } = await import('./adapter-default-selection.js');
    const snapshot = getAdapterDefaultSelectionSnapshot();

    expect(snapshot.categories.map((category) => category.key)).toEqual([
      'media.image',
      'media.video',
      'media.music',
      'service.runtime',
      'tool.runtime',
      'voice.vad',
    ]);
    expect(
      snapshot.categories.find((category) => category.key === 'media.image')?.candidates
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'media-generation.comfyui',
          adapter_id: 'media.service_preset',
        }),
      ])
    );
    expect(safeExistsSync(PROFILE_ROOT)).toBe(false);
  });

  it('applies persisted defaults to each resolver without caller-specific branches', async () => {
    const { initializeAdapterDefaultPreferences, saveAdapterDefaultPreferences } =
      await import('./adapter-default-selection.js');
    saveAdapterDefaultPreferences({
      'media.image': 'media-generation.comfyui',
      'media.video': 'video.hyperframes_cli',
      'media.music': 'media-generation.comfyui.music',
      'service.runtime': 'comfyui',
      'tool.runtime': 'playwright',
      'voice.vad': 'energy',
    });
    resetAdapterDefaultPreferences();
    initializeAdapterDefaultPreferences();

    const { resolveImageBackend, resolveMusicBackend, resolveVideoBackend } =
      await import('./media-backend-registry.js');
    const { getServiceRuntimeRecord } = await import('./service-runtime-registry.js');
    const { getToolRuntimeRecord } = await import('./tool-runtime-registry.js');
    const { resolveVadBackend } = await import('./vad-registry.js');

    expect(resolveImageBackend().backend_id).toBe('media-generation.comfyui');
    expect(resolveVideoBackend().backend_id).toBe('video.hyperframes_cli');
    expect(resolveMusicBackend().backend_id).toBe('media-generation.comfyui.music');
    expect(getServiceRuntimeRecord()?.service_id).toBe('comfyui');
    expect(getToolRuntimeRecord().tool_id).toBe('playwright');
    expect(resolveVadBackend().backend.backend_id).toBe('energy');
  });
});
