import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAdapterDefaultPreferences } from './adapter-default-preferences.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { AdapterDefaultPreferences } from './adapter-default-preferences.js';

const PROFILE_ROOT = pathResolver.sharedTmp('adapter-default-selection-tests/profile');
const PORTABLE_EMAIL_BACKEND = process.platform === 'darwin' ? 'mac_mailapp' : 'smtp';

vi.mock('./profile-root.js', () => ({
  resolveActiveProfileRoot: () => PROFILE_ROOT,
}));

beforeEach(() => {
  safeRmSync(pathResolver.sharedTmp('adapter-default-selection-tests'), {
    recursive: true,
    force: true,
  });
  if (PORTABLE_EMAIL_BACKEND === 'smtp') {
    vi.stubEnv('KYBERION_SMTP_HOST', 'smtp.test.invalid');
    vi.stubEnv('KYBERION_SMTP_USER', 'test-user');
    vi.stubEnv('KYBERION_SMTP_PASS', 'test-pass');
  }
});

afterEach(() => {
  resetAdapterDefaultPreferences();
  safeRmSync(pathResolver.sharedTmp('adapter-default-selection-tests'), {
    recursive: true,
    force: true,
  });
  vi.unstubAllEnvs();
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
      'email.backend',
      'email.account',
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
    expect(
      snapshot.categories.find((category) => category.key === 'email.account')?.candidates
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'gmail', adapter_id: 'email.account.gmail' }),
        expect.objectContaining({ id: 'outlook', adapter_id: 'email.account.outlook' }),
        expect.objectContaining({ id: 'yahoo', status: 'needs_setup' }),
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
      'email.backend': PORTABLE_EMAIL_BACKEND,
      'email.account': 'gmail',
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

  it('fails closed when persisted defaults violate the preferences schema', async () => {
    const { getAdapterDefaultSelectionSnapshot } = await import('./adapter-default-selection.js');
    const preferencesPath = path.join(PROFILE_ROOT, 'onboarding', 'adapter-defaults.json');
    safeWriteFile(
      preferencesPath,
      JSON.stringify({ version: '1.0.0', defaults: { 'unknown.category': 'value' } }),
      { mkdir: true, encoding: 'utf8' }
    );

    expect(getAdapterDefaultSelectionSnapshot().preferences.defaults).toEqual({});

    safeRmSync(preferencesPath, { recursive: true, force: true });
    safeMkdir(preferencesPath, { recursive: true });
    expect(getAdapterDefaultSelectionSnapshot().preferences.defaults).toEqual({});
  });

  it('writes preferences through the schema-bound catalog', async () => {
    const { getAdapterDefaultSelectionSnapshot, writeAdapterDefaultPreferencesAtPath } =
      await import('./adapter-default-selection.js');
    const preferencesPath = path.join(PROFILE_ROOT, 'onboarding', 'adapter-defaults.json');
    expect(
      writeAdapterDefaultPreferencesAtPath(preferencesPath, {
        version: '1.0.0',
        defaults: { 'media.image': 'media-generation.comfyui' },
      })
    ).toBe(preferencesPath);
    expect(getAdapterDefaultSelectionSnapshot().preferences.defaults).toEqual({
      'media.image': 'media-generation.comfyui',
    });
  });

  it('rejects an invalid preference record before persisting it', async () => {
    const { writeAdapterDefaultPreferencesAtPath } = await import('./adapter-default-selection.js');
    const preferencesPath = path.join(PROFILE_ROOT, 'onboarding', 'invalid.json');

    expect(() =>
      writeAdapterDefaultPreferencesAtPath(preferencesPath, {
        version: '1.0.0',
        defaults: { 'unknown.category': 'value' },
      } as unknown as AdapterDefaultPreferences)
    ).toThrow(/Invalid catalog adapter-default-preferences/);
  });
});
