import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core/secure-io';
import { resolveStorageFloor } from '@agent/core/storage-layout';

const profile = vi.hoisted(() => ({ value: '', resolve: vi.fn<() => string>() }));
vi.mock('@agent/core/profile-root', () => ({ resolveActiveProfileRoot: profile.resolve }));
import {
  getEngineRuntimePreferences,
  getEngineRuntimePreferencesPath,
  saveEngineRuntimePreferences,
} from '@agent/core/voice/engine-runtime-preferences';
import { runEngineRuntimeConfig } from './engine_runtime_config.js';

beforeEach(() => {
  profile.value = resolveStorageFloor(
    'scratch',
    { kind: 'tier', tier: 'public' },
    'vitest-engine-cli-' + process.pid
  );
  safeRmSync(profile.value, { recursive: true, force: true });
  profile.resolve.mockReset().mockImplementation(() => profile.value);
});
afterEach(() => {
  safeRmSync(profile.value, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function output() {
  const values: unknown[] = [];
  return {
    values,
    print: (value: unknown) => {
      values.push(value);
    },
  };
}

describe('engine runtime configuration CLI', () => {
  it('prints help without resolving private profile state', async () => {
    const out = output();
    await runEngineRuntimeConfig(['--help'], out.print);
    expect(out.values[0]).toContain('--agent-runtime-backend');
    expect(profile.resolve).not.toHaveBeenCalled();
  });
  it('shows every setting in readable output', async () => {
    const out = output();
    await runEngineRuntimeConfig(['show'], out.print);
    for (const key of [
      'ffmpeg_bin',
      'ffprobe_bin',
      'python_bin',
      'audio_record_command',
      'audio_playback_backend',
      'fluid_audio_stt_command',
      'streaming_stt_bridge',
      'streaming_tts_bridge',
      'agent_runtime_backend',
      'agent_pane_runtime_provider',
    ]) {
      expect(out.values[0]).toContain(key + '=');
    }
  });
  it('normalizes saved paths and accepts a declared launch mode', async () => {
    const out = output();
    await runEngineRuntimeConfig(
      ['set', '--ffmpeg-bin', ' /opt/bin/ffmpeg ', '--agent-runtime-backend', 'pane', '--json'],
      out.print
    );
    expect(out.values[0]).toMatchObject({
      ffmpeg_bin: '/opt/bin/ffmpeg',
      agent_runtime_backend: 'pane',
    });
    expect(getEngineRuntimePreferences()).toMatchObject({
      ffmpeg_bin: '/opt/bin/ffmpeg',
      agent_runtime_backend: 'pane',
    });
  });
  it('rejects invalid launch modes before any profile read or write', async () => {
    await expect(
      runEngineRuntimeConfig(['set', '--agent-runtime-backend', 'pan'], () => {})
    ).rejects.toThrow('pipe or pane');
    expect(profile.resolve).not.toHaveBeenCalled();
  });
  it('runs the same semantic validation in dry-run without creating a file', async () => {
    const out = output();
    await runEngineRuntimeConfig(
      ['set', '--ffmpeg-bin', '/opt/bin/ffmpeg', '--dry-run'],
      out.print
    );
    expect(out.values[0]).toMatchObject({
      dry_run: true,
      proposed: { ffmpeg_bin: '/opt/bin/ffmpeg' },
    });
    expect(safeExistsSync(getEngineRuntimePreferencesPath())).toBe(false);
    await expect(
      runEngineRuntimeConfig(['set', '--ffmpeg-bin', 'relative', '--dry-run'], out.print)
    ).rejects.toThrow('absolute');
    expect(safeExistsSync(getEngineRuntimePreferencesPath())).toBe(false);
  });
  it('previews and then clears only the selected fields', async () => {
    saveEngineRuntimePreferences({
      ffmpeg_bin: '/opt/bin/ffmpeg',
      python_bin: '/opt/bin/python3',
      agent_runtime_backend: 'pane',
    });
    const file = getEngineRuntimePreferencesPath();
    const before = safeReadFile(file, { encoding: 'utf8' });
    const out = output();
    await runEngineRuntimeConfig(['unset', 'ffmpeg-bin', '--dry-run'], out.print);
    expect(out.values[0]).toMatchObject({ cleared: ['ffmpeg_bin'] });
    expect((out.values[0] as { proposed: object }).proposed).not.toHaveProperty('ffmpeg_bin');
    expect(safeReadFile(file, { encoding: 'utf8' })).toBe(before);
    await runEngineRuntimeConfig(['unset', 'ffmpeg-bin'], out.print);
    expect(getEngineRuntimePreferences()).not.toHaveProperty('ffmpeg_bin');
    expect(getEngineRuntimePreferences()).toMatchObject({
      python_bin: '/opt/bin/python3',
      agent_runtime_backend: 'pane',
    });
  });
  it('preserves literal flag values without turning them into shared flags', async () => {
    const out = output();
    await runEngineRuntimeConfig(['set', '--audio-record-command=--dry-run'], out.print);
    expect(getEngineRuntimePreferences().audio_record_command).toBe('--dry-run');
    expect(typeof out.values[0]).toBe('string');
    await runEngineRuntimeConfig(['set', '--fluid-stt-command=--json'], out.print);
    expect(getEngineRuntimePreferences().fluid_audio_stt_command).toBe('--json');
    expect(typeof out.values[1]).toBe('string');
  });
  it('keeps reset dry-run unchanged and restores empty defaults on reset', async () => {
    saveEngineRuntimePreferences({ python_bin: '/opt/bin/python3' });
    const file = getEngineRuntimePreferencesPath();
    const before = safeReadFile(file, { encoding: 'utf8' });
    await runEngineRuntimeConfig(['reset', '--dry-run'], () => {});
    expect(safeReadFile(file, { encoding: 'utf8' })).toBe(before);
    await runEngineRuntimeConfig(['reset'], () => {});
    expect(getEngineRuntimePreferences()).not.toHaveProperty('python_bin');
  });
  it('rejects unknown options and invalid command shapes without profile effects', async () => {
    for (const argv of [
      ['set', '--unknown', 'value'],
      ['show', '--python-bin', '/opt/python'],
      ['reset', '--python-bin', '/opt/python'],
    ]) {
      await expect(runEngineRuntimeConfig(argv, () => {})).rejects.toThrow();
    }
    expect(profile.resolve).not.toHaveBeenCalled();
    expect(safeExistsSync(path.join(profile.value, 'onboarding', 'engine-runtime.json'))).toBe(
      false
    );
  });
});
