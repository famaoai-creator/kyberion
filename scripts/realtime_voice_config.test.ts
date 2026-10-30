import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageFloor } from '@agent/core/storage-layout';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core/secure-io';
import { resetVoiceProfileRegistryCache } from '@agent/core/voice/voice-profile-registry';
import {
  getRealtimeVoiceConversationPreferencesPath,
  loadRealtimeVoiceConversationPreferences,
  saveRealtimeVoiceConversationPreferences,
} from '@agent/core/voice/realtime-voice-preferences';
import { main } from './realtime_voice_config.js';
import { parseScriptFlags } from './lib/harness.js';

const profileRoot = vi.hoisted(() => ({ value: '' }));
vi.mock('@agent/core/profile-root', () => ({
  resolveActiveProfileRoot: () => profileRoot.value,
}));

beforeEach(() => {
  profileRoot.value = resolveStorageFloor(
    'scratch',
    { kind: 'system' },
    'realtime-voice-config-tests',
    String(process.pid)
  );
  safeRmSync(profileRoot.value, { recursive: true, force: true });
  vi.stubEnv(
    'KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH',
    path.join(profileRoot.value, 'missing-personal-overlay.json')
  );
  resetVoiceProfileRegistryCache();
});

afterEach(() => {
  safeRmSync(profileRoot.value, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetVoiceProfileRegistryCache();
});

describe('realtime voice configuration CLI', () => {
  it('saves option-looking argv values and displays every streaming field in ordinary output', () => {
    const print = vi.fn();
    main(
      [
        'set',
        '--stt-command',
        'python',
        '--stt-args=stt.py,--foo',
        '--tts-command',
        'python',
        '--tts-args=tts.py,--stream-framed',
        '--tts-play-command',
        'ffplay,-nodisp,-autoexit',
        '--tts-sample-rate',
        '24000',
      ],
      print
    );
    const preferences = loadRealtimeVoiceConversationPreferences();
    expect(preferences).toMatchObject({
      streaming_stt_args: 'stt.py,--foo',
      streaming_tts_args: 'tts.py,--stream-framed',
      streaming_tts_sample_rate: 24000,
    });
    main(['set', '--stt-args=--foo,--bar', '--tts-args=--stream-framed'], print);
    main(['show'], print);
    const output = print.mock.calls.at(-1)?.[0] as string;
    for (const line of [
      'streaming_stt_command=python',
      'streaming_stt_args=--foo,--bar',
      'streaming_tts_command=python',
      'streaming_tts_args=--stream-framed',
      'streaming_tts_play_command=ffplay,-nodisp,-autoexit',
      'streaming_tts_sample_rate=24000',
    ]) {
      expect(output).toContain(line);
    }
  });

  it('keeps equal-form shared-flag names as literal engine arguments and still writes', () => {
    const argv = ['set', '--stt-args=--dry-run', '--tts-args=--json'];
    expect(parseScriptFlags(argv)).toMatchObject({ dryRun: false, json: false, positional: argv });
    const print = vi.fn();
    main(['set', '--stt-args=--dry-run', '--tts-args=--json'], print);
    expect(loadRealtimeVoiceConversationPreferences()).toMatchObject({
      streaming_stt_args: '--dry-run',
      streaming_tts_args: '--json',
    });
    expect(typeof print.mock.calls.at(-1)?.[0]).toBe('string');
    print.mockClear();
    main(['set', '--stt-args=--json', '--tts-args=--dry-run'], print);
    expect(loadRealtimeVoiceConversationPreferences()).toMatchObject({
      streaming_stt_args: '--json',
      streaming_tts_args: '--dry-run',
    });
    expect(typeof print.mock.calls.at(-1)?.[0]).toBe('string');
  });

  it.each(['--stt-command', '--tts-command'])(
    'rejects embedded whitespace for %s in set and dry-run',
    (flag) => {
      for (const command of ['python worker.py', 'path' + String.fromCharCode(9) + 'python']) {
        expect(() => main(['set', flag, command])).toThrow('embedded whitespace');
        expect(() => main(['set', flag, command, '--dry-run'])).toThrow('embedded whitespace');
        expect(loadRealtimeVoiceConversationPreferences()).toBeNull();
      }
    }
  );

  it('unsets selected streaming defaults while preserving the rest of the profile', () => {
    saveRealtimeVoiceConversationPreferences({
      assistant_name: 'Aoi',
      reasoning_model: 'example-model',
      streaming_stt_command: 'python',
      streaming_tts_command: 'python',
      streaming_tts_args: 'tts.py',
      streaming_tts_sample_rate: 24000,
    });
    main(['unset', 'stt-command', 'tts-args', 'tts-sample-rate']);
    const preferences = loadRealtimeVoiceConversationPreferences();
    expect(preferences).toMatchObject({
      assistant_name: 'Aoi',
      reasoning_model: 'example-model',
      streaming_tts_command: 'python',
    });
    expect(preferences).not.toHaveProperty('streaming_stt_command');
    expect(preferences).not.toHaveProperty('streaming_tts_args');
    expect(preferences).not.toHaveProperty('streaming_tts_sample_rate');
  });

  it('honors direct --dry-run and validates the proposed state without creating a preferences file', () => {
    const file = getRealtimeVoiceConversationPreferencesPath();
    const print = vi.fn();
    main(['set', '--stt-command', 'python', '--dry-run'], print);
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({
        dry_run: true,
        proposed: expect.objectContaining({ streaming_stt_command: 'python' }),
      })
    );
    expect(safeExistsSync(file)).toBe(false);
    expect(() => main(['set', '--stt-command', '  ', '--dry-run'])).toThrow();
    expect(safeExistsSync(file)).toBe(false);
  });

  it('previews unsets and inherited dry-run without modifying an existing profile', () => {
    saveRealtimeVoiceConversationPreferences({
      streaming_tts_command: 'python',
      streaming_tts_args: 'tts.py',
    });
    const file = getRealtimeVoiceConversationPreferencesPath();
    const before = String(safeReadFile(file));
    const print = vi.fn();
    main(['unset', 'tts-command', '--dry-run', '--json'], print);
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({
        dry_run: true,
        cleared: ['streaming_tts_command'],
      })
    );
    main(['set', '--tts-command', 'other'], print, { dryRun: true });
    expect(String(safeReadFile(file))).toBe(before);
  });

  it.each([
    ['set', '--stt-command', ''],
    ['set', '--tts-command', '  '],
    ['set', '--tts-play-command', ',--flag'],
    ['set', '--stt-args=--bad' + String.fromCharCode(10) + 'argument'],
    ['set', '--tts-sample-rate', '22050'],
    ['show', '--stt-command', 'python'],
    ['reset', '--tts-command', 'python'],
    ['unset'],
    ['unset', 'assistant-name'],
    ['set'],
  ])('rejects malformed or misplaced options: %j', (...args) => {
    expect(() => main(args)).toThrow();
    expect(loadRealtimeVoiceConversationPreferences()).toBeNull();
  });

  it('shows unset defaults and makes reset/help non-mutating when requested', () => {
    const print = vi.fn();
    main(['show'], print);
    expect(print.mock.calls[0]?.[0]).toContain('streaming_tts_command=(not configured)');
    main(['reset', '--dry-run'], print);
    main(['set', '--help'], print);
    expect(print.mock.calls.at(-1)?.[0]).toContain('unset <streaming-option>');
    expect(loadRealtimeVoiceConversationPreferences()).toBeNull();
  });
});
