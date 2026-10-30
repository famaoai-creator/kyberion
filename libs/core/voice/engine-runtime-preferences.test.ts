import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import * as secureIo from '../secure-io.js';
import * as tierGuard from '../tier-guard.js';
import { getFoundationIo } from '../foundation/io.js';
import { resolveStorageFloor } from '../storage-layout.js';
import * as profileResolver from '../profile-root.js';
import * as customerResolver from '../customer-resolver.js';

const profileRoot = vi.hoisted(() => ({ value: '', fixtureRoot: '' }));
vi.mock('../profile-root.js', () => ({
  resolveActiveProfileRoot: () => profileRoot.value,
}));

import {
  getEngineRuntimePreferences,
  engineRuntimePreferencesReadiness,
  getEngineRuntimePreferencesPath,
  resetEngineRuntimePreferences,
  type EngineRuntimePreferencesPatch,
  loadEngineRuntimePreferences,
  previewEngineRuntimePreferences,
  resetEngineRuntimePreferencesCache,
  saveEngineRuntimePreferences,
} from './engine-runtime-preferences.js';
import { resolveFfmpegBin, resolvePython3Bin } from '../tool/tool-binary-resolvers.js';

function writePreferences(value: unknown): void {
  const file = path.join(profileRoot.value, 'onboarding', 'engine-runtime.json');
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(value));
}

describe('engine-runtime preferences', () => {
  beforeEach(() => {
    profileRoot.fixtureRoot = resolveStorageFloor(
      'scratch',
      { kind: 'system' },
      'engine-runtime-preferences-tests',
      String(process.pid)
    );
    profileRoot.value = profileRoot.fixtureRoot;
    safeRmSync(profileRoot.value, { recursive: true, force: true });
    resetEngineRuntimePreferencesCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    safeRmSync(profileRoot.fixtureRoot, { recursive: true, force: true });
  });

  it('returns empty defaults when no file exists', () => {
    expect(getEngineRuntimePreferences()).toEqual({ version: '1.0.0' });
    expect(loadEngineRuntimePreferences()).toBeNull();
  });

  it('observes a file created after a missing read and external edits without invalidation', () => {
    expect(loadEngineRuntimePreferences()).toBeNull();
    writePreferences({ version: '1.0.0', ffmpeg_bin: '/first/ffmpeg' });
    expect(loadEngineRuntimePreferences()?.ffmpeg_bin).toBe('/first/ffmpeg');
    writePreferences({ version: '1.0.0', ffmpeg_bin: '/other/ffmpeg' });
    expect(loadEngineRuntimePreferences()?.ffmpeg_bin).toBe('/other/ffmpeg');
  });

  it('does not share a cached value or missing state between profiles', () => {
    saveEngineRuntimePreferences({ ffmpeg_bin: '/profile-a/ffmpeg' });
    profileRoot.value = path.join(profileRoot.fixtureRoot, 'profile-b');
    expect(loadEngineRuntimePreferences()).toBeNull();
    saveEngineRuntimePreferences({ python_bin: '/profile-b/python' });
    expect(loadEngineRuntimePreferences()).not.toHaveProperty('ffmpeg_bin');
    profileRoot.value = profileRoot.fixtureRoot;
    expect(loadEngineRuntimePreferences()?.ffmpeg_bin).toBe('/profile-a/ffmpeg');
    expect(loadEngineRuntimePreferences()).not.toHaveProperty('python_bin');
  });

  it('returns immutable snapshots without sharing caller mutations across reads', () => {
    saveEngineRuntimePreferences({ ffmpeg_bin: '/original/ffmpeg' });
    const snapshot = loadEngineRuntimePreferences()!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Reflect.set(snapshot, 'ffmpeg_bin', '/mutated/ffmpeg')).toBe(false);
    expect(loadEngineRuntimePreferences()).not.toBe(snapshot);
    expect(loadEngineRuntimePreferences()?.ffmpeg_bin).toBe('/original/ffmpeg');
  });

  it('reauthorizes content reads even after a successful profile read', () => {
    saveEngineRuntimePreferences({ ffmpeg_bin: '/authorized/ffmpeg' });
    expect(loadEngineRuntimePreferences()?.ffmpeg_bin).toBe('/authorized/ffmpeg');
    const io = getFoundationIo();
    const load = io.loadJson.bind(io);
    const target = getEngineRuntimePreferencesPath();
    vi.spyOn(io, 'loadJson').mockImplementation((file, options) => {
      if (file === target)
        throw new Error('[TEST_READ_DENIED] Current caller may not read profile contents');
      return load(file, options);
    });
    expect(() => loadEngineRuntimePreferences()).toThrow('[TEST_READ_DENIED]');
  });

  it('treats only generic default-personal tier denial as optional unavailability without probing', () => {
    profileRoot.value = pathResolver.knowledge('personal');
    const denied = vi.spyOn(tierGuard, 'inspectReadPermission').mockReturnValue({
      allowed: false,
      reason: 'personal tier unavailable',
      denialKind: 'tier_restriction',
    });
    const exists = vi.spyOn(secureIo, 'safeExistsSync');
    const boundary = vi.spyOn(secureIo, 'assertSafeRepositoryPath');
    const stat = vi.spyOn(secureIo, 'safeLstat');
    expect(engineRuntimePreferencesReadiness()).toEqual({
      status: 'unavailable',
      reason: 'personal_profile_not_authorized',
    });
    expect(exists).not.toHaveBeenCalledWith(
      path.join(profileRoot.value, 'onboarding', 'engine-runtime.json')
    );
    expect(() => loadEngineRuntimePreferences()).toThrow(
      '[ENGINE_RUNTIME_PREFERENCES_UNAVAILABLE]'
    );
    expect(() => previewEngineRuntimePreferences({})).toThrow(
      '[ENGINE_RUNTIME_PREFERENCES_UNAVAILABLE]'
    );
    expect(() => saveEngineRuntimePreferences({})).toThrow(
      '[ENGINE_RUNTIME_PREFERENCES_UNAVAILABLE]'
    );
    expect(() => resetEngineRuntimePreferences()).toThrow(
      '[ENGINE_RUNTIME_PREFERENCES_READ_DENIED]'
    );
    const privatePath = path.join(profileRoot.value, 'onboarding', 'engine-runtime.json');
    expect(boundary.mock.calls.some(([file]) => file === privatePath)).toBe(false);
    expect(stat).not.toHaveBeenCalledWith(privatePath);
    denied.mockReturnValue({ allowed: false, reason: 'role denied' });
    expect(() => engineRuntimePreferencesReadiness()).toThrow(
      '[ENGINE_RUNTIME_PREFERENCES_READ_DENIED]'
    );
    denied.mockReturnValue({
      allowed: false,
      reason: 'personal tier unavailable',
      denialKind: 'tier_restriction',
    });
    profileRoot.value = path.join(profileRoot.fixtureRoot, 'customer-profile');
    expect(() => engineRuntimePreferencesReadiness()).toThrow(
      '[ENGINE_RUNTIME_PREFERENCES_READ_DENIED]'
    );
    expect(exists).not.toHaveBeenCalledWith(
      path.join(profileRoot.value, 'onboarding', 'engine-runtime.json')
    );
  });

  it('authorizes customer targets before guarded customer/symlink probes and preserves denials', async () => {
    const actual = await vi.importActual<typeof import('../profile-root.js')>('../profile-root.js');
    vi.spyOn(profileResolver, 'resolveActiveProfileRoot').mockImplementation(
      actual.resolveActiveProfileRoot
    );
    vi.stubEnv('KYBERION_CUSTOMER', 'engine-runtime-guard-test');
    const customerGuard = vi.spyOn(customerResolver, 'customerRoot').mockImplementation(() => {
      throw new Error('[RESOURCE_PATH_SYMLINK] Customer metadata was probed');
    });
    const inspect = vi
      .spyOn(tierGuard, 'inspectReadPermission')
      .mockReturnValue({ allowed: false, reason: 'role denied customer profile' });
    expect(() => engineRuntimePreferencesReadiness()).toThrow('role denied customer profile');
    expect(() => resetEngineRuntimePreferences()).toThrow('role denied customer profile');
    expect(customerGuard).not.toHaveBeenCalled();
    inspect.mockReturnValue({
      allowed: false,
      reason: '[RESOURCE_SCOPE_DENIED] customer target denied',
    });
    expect(() => engineRuntimePreferencesReadiness()).toThrow('[RESOURCE_SCOPE_DENIED]');
    expect(customerGuard).not.toHaveBeenCalled();
    const target = path.join(
      pathResolver.rootDir(),
      'customer',
      'engine-runtime-guard-test',
      'onboarding',
      'engine-runtime.json'
    );
    const assertPath = secureIo.assertSafeRepositoryPath;
    vi.spyOn(secureIo, 'assertSafeRepositoryPath').mockImplementation((file, options) => {
      if (file === target)
        throw new Error('[RESOURCE_PATH_SYMLINK] Authorized target is a symlink');
      return assertPath(file, options);
    });
    inspect.mockReturnValue({ allowed: true });
    expect(() => engineRuntimePreferencesReadiness()).toThrow('[RESOURCE_PATH_SYMLINK]');
    expect(customerGuard).not.toHaveBeenCalled();
    // Public path lookup retains the historical guarded-customer behavior.
    expect(() => getEngineRuntimePreferencesPath()).toThrow('Customer metadata was probed');
    expect(customerGuard).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed customer selection before target permission inspection', async () => {
    const actual = await vi.importActual<typeof import('../profile-root.js')>('../profile-root.js');
    vi.spyOn(profileResolver, 'resolveActiveProfileRoot').mockImplementation(
      actual.resolveActiveProfileRoot
    );
    vi.stubEnv('KYBERION_CUSTOMER', '../invalid');
    const inspect = vi.spyOn(tierGuard, 'inspectReadPermission');
    expect(() => engineRuntimePreferencesReadiness()).toThrow('Invalid KYBERION_CUSTOMER');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('rejects an out-of-repository logical profile before inspecting or probing it', () => {
    profileRoot.value = path.resolve(pathResolver.rootDir(), '..', 'outside-engine-profile');
    const inspect = vi.spyOn(tierGuard, 'inspectReadPermission');
    const boundary = vi.spyOn(secureIo, 'assertSafeRepositoryPath');
    expect(() => engineRuntimePreferencesReadiness()).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(inspect).not.toHaveBeenCalled();
    const target = path.join(profileRoot.value, 'onboarding', 'engine-runtime.json');
    expect(boundary.mock.calls.some(([file]) => file === target)).toBe(false);
  });

  it('preserves scope failures instead of mapping them to unavailable', () => {
    vi.stubEnv('KYBERION_TENANT', 'INVALID/TENANT');
    const inspect = vi.spyOn(tierGuard, 'inspectReadPermission');
    expect(() => engineRuntimePreferencesReadiness()).toThrow('[CREDENTIAL_SCOPE_DENIED]');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('normalizes padded binary paths for previews, saves and external profile reads', () => {
    expect(previewEngineRuntimePreferences({ ffmpeg_bin: ' /usr/bin/ffmpeg ' }).ffmpeg_bin).toBe(
      '/usr/bin/ffmpeg'
    );
    const saved = saveEngineRuntimePreferences({ python_bin: ' /usr/bin/python3 ' });
    expect(saved.python_bin).toBe('/usr/bin/python3');
    expect(JSON.parse(String(safeReadFile(getEngineRuntimePreferencesPath()))).python_bin).toBe(
      '/usr/bin/python3'
    );
    writePreferences({ version: '1.0.0', ffprobe_bin: ' /usr/bin/ffprobe ' });
    expect(loadEngineRuntimePreferences()?.ffprobe_bin).toBe('/usr/bin/ffprobe');
  });

  it('accepts only pipe/pane backends and resets even malformed previous settings through validation', () => {
    for (const backend of ['pipe', 'pane'] as const)
      expect(
        previewEngineRuntimePreferences({ agent_runtime_backend: backend }).agent_runtime_backend
      ).toBe(backend);
    expect(() =>
      previewEngineRuntimePreferences({
        agent_runtime_backend: 'other',
      } as unknown as EngineRuntimePreferencesPatch)
    ).toThrow();
    writePreferences({ version: '1.0.0', agent_runtime_backend: 'other' });
    expect(() => loadEngineRuntimePreferences()).toThrow();
    const reset = resetEngineRuntimePreferences();
    expect(Object.isFrozen(reset)).toBe(true);
    expect(reset).not.toHaveProperty('agent_runtime_backend');
    expect(loadEngineRuntimePreferences()).toEqual(reset);
  });

  it('saves and reloads an ffmpeg_bin preference', () => {
    saveEngineRuntimePreferences({ ffmpeg_bin: '/opt/bin/ffmpeg' });
    expect(loadEngineRuntimePreferences()?.ffmpeg_bin).toBe('/opt/bin/ffmpeg');
  });

  it('rejects a non-absolute ffmpeg_bin', () => {
    expect(() => previewEngineRuntimePreferences({ ffmpeg_bin: 'ffmpeg' })).toThrow(
      'absolute path'
    );
  });

  it('rejects values containing line breaks', () => {
    expect(() => previewEngineRuntimePreferences({ audio_record_command: 'rec\nrunme' })).toThrow(
      'line breaks'
    );
  });

  it('preview removes an option set to undefined without writing', () => {
    saveEngineRuntimePreferences({ python_bin: '/usr/bin/python3' });
    const proposed = previewEngineRuntimePreferences({ python_bin: undefined });
    expect(proposed).not.toHaveProperty('python_bin');
    expect(loadEngineRuntimePreferences()?.python_bin).toBe('/usr/bin/python3');
  });

  it('resolves ffmpeg_bin from the preference when env is unset', () => {
    writePreferences({ version: '1.0.0', ffmpeg_bin: '/opt/bin/ffmpeg' });
    expect(resolveFfmpegBin()).toBe('/opt/bin/ffmpeg');
  });

  it('env overrides the preference for binaries', () => {
    writePreferences({ version: '1.0.0', python_bin: '/prefs/python3' });
    const previous = process.env.KYBERION_PYTHON_BIN;
    process.env.KYBERION_PYTHON_BIN = '/env/python3';
    try {
      expect(resolvePython3Bin()).toBe('/env/python3');
    } finally {
      if (previous === undefined) delete process.env.KYBERION_PYTHON_BIN;
      else process.env.KYBERION_PYTHON_BIN = previous;
    }
  });

  it('resolves streaming bridge ids from the preference when env is unset', async () => {
    writePreferences({ version: '1.0.0', streaming_stt_bridge: 'managed_mlx_whisper' });
    const { getStreamingSttBridge } = await import('./streaming-stt-bridge.js');
    const { getStreamingTtsBridge } = await import('./streaming-tts-bridge.js');
    expect(() => getStreamingSttBridge('nonexistent')).toThrow('unknown bridge id');
    expect(getStreamingTtsBridge().constructor.name).toContain('Stub');
  });

  it('agent runtime launch mode falls back to the saved preference', async () => {
    writePreferences({ version: '1.0.0', agent_runtime_backend: 'pane' });
    const { resolveAgentRuntimeLaunchMode } = await import('../agent/agent-pane-runtime-bridge.js');
    expect(resolveAgentRuntimeLaunchMode()).toBe('pane');
    expect(resolveAgentRuntimeLaunchMode({ env: { KYBERION_AGENT_RUNTIME_BACKEND: 'pipe' } })).toBe(
      'pipe'
    );
  });
});
