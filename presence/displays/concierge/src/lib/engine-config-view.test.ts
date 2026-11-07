import { describe, expect, it } from 'vitest';
import {
  ENGINE_CONFIG_FIELDS,
  engineConfigChanges,
  engineConfigFailure,
  parseEngineConfig,
  type EngineConfigValues,
} from './engine-config-view';

const REVISION = 'a'.repeat(64);
const empty = Object.fromEntries(ENGINE_CONFIG_FIELDS.map((k) => [k, ''])) as EngineConfigValues;

describe('parseEngineConfig', () => {
  it('reads a contract response, defaulting unset fields to empty', () => {
    const parsed = parseEngineConfig({
      ok: true,
      preferences: { ffmpeg_bin: '/opt/ffmpeg', agent_runtime_backend: 'pane' },
      revision: REVISION,
      profile: { kind: 'personal', id: 'personal' },
    });
    expect(parsed?.values.ffmpeg_bin).toBe('/opt/ffmpeg');
    expect(parsed?.values.python_bin).toBe('');
    expect(parsed?.values.agent_runtime_backend).toBe('pane');
  });

  it('refuses anything off-contract', () => {
    const base = {
      ok: true,
      preferences: {},
      revision: REVISION,
      profile: { kind: 'personal', id: 'p' },
    };
    expect(parseEngineConfig(base)).not.toBeNull();
    expect(parseEngineConfig({ ...base, ok: false })).toBeNull();
    expect(parseEngineConfig({ ...base, revision: 'short' })).toBeNull();
    expect(parseEngineConfig({ ...base, profile: { kind: 'other', id: 'p' } })).toBeNull();
    expect(parseEngineConfig({ ...base, preferences: { python_bin: 3 } })).toBeNull();
    expect(
      parseEngineConfig({ ...base, preferences: { agent_runtime_backend: 'shell' } })
    ).toBeNull();
    expect(parseEngineConfig(null)).toBeNull();
  });
});

describe('engineConfigChanges', () => {
  it('patches edited values, unsets cleared ones and ignores the rest', () => {
    const baseline = { ...empty, ffmpeg_bin: '/opt/ffmpeg', python_bin: 'python3' };
    const draft = {
      ...baseline,
      ffmpeg_bin: '  ',
      python_bin: 'python3',
      ffprobe_bin: ' /opt/ffprobe ',
    };
    expect(engineConfigChanges(baseline, draft)).toEqual({
      patch: { ffprobe_bin: '/opt/ffprobe' },
      unset: ['ffmpeg_bin'],
    });
    expect(engineConfigChanges(baseline, baseline)).toEqual({ patch: {}, unset: [] });
  });
});

describe('engineConfigFailure', () => {
  it('maps statuses to messages', () => {
    expect(engineConfigFailure(409, 'save_failed')).toBe('conflict');
    expect(engineConfigFailure(403, 'load_failed')).toBe('denied');
    expect(engineConfigFailure(401, 'load_failed')).toBe('denied');
    expect(engineConfigFailure(400, 'save_failed')).toBe('invalid');
    expect(engineConfigFailure(500, 'save_failed')).toBe('save_failed');
  });
});
