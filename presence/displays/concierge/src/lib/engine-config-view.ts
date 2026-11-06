/**
 * 設定 › エンジン (pure helpers): the profile's engine runtime defaults as the
 * form edits them. Mirrors the contract of `/api/voice/engine-config`
 * (libs/core/voice/engine-runtime-preferences-operator.ts).
 */
export const ENGINE_CONFIG_FIELDS = [
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
] as const;
export type EngineConfigField = (typeof ENGINE_CONFIG_FIELDS)[number];
export type EngineConfigValues = Record<EngineConfigField, string>;

export const ENGINE_CONFIG_HELP: Record<
  EngineConfigField,
  'binary' | 'record' | 'fluid' | 'bridge' | null
> = {
  ffmpeg_bin: 'binary',
  ffprobe_bin: 'binary',
  python_bin: 'binary',
  audio_record_command: 'record',
  audio_playback_backend: 'bridge',
  fluid_audio_stt_command: 'fluid',
  streaming_stt_bridge: 'bridge',
  streaming_tts_bridge: 'bridge',
  agent_runtime_backend: null,
  agent_pane_runtime_provider: 'bridge',
};

export interface EngineConfigSnapshot {
  values: EngineConfigValues;
  revision: string;
  profile: { kind: 'personal' | 'customer'; id: string };
}

/** Pure. A server response, or null when it does not match the contract. */
export function parseEngineConfig(body: unknown): EngineConfigSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const data = body as {
    ok?: unknown;
    preferences?: unknown;
    revision?: unknown;
    profile?: { kind?: unknown; id?: unknown };
  };
  if (
    data.ok !== true ||
    !data.preferences ||
    typeof data.preferences !== 'object' ||
    typeof data.revision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(data.revision) ||
    (data.profile?.kind !== 'personal' && data.profile?.kind !== 'customer') ||
    typeof data.profile.id !== 'string'
  )
    return null;
  const preferences = data.preferences as Record<string, unknown>;
  const values = {} as EngineConfigValues;
  for (const key of ENGINE_CONFIG_FIELDS) {
    const value = preferences[key];
    if (value !== undefined && typeof value !== 'string') return null;
    if (
      key === 'agent_runtime_backend' &&
      value !== undefined &&
      value !== 'pipe' &&
      value !== 'pane'
    )
      return null;
    values[key] = value ?? '';
  }
  return {
    values,
    revision: data.revision,
    profile: { kind: data.profile.kind, id: data.profile.id },
  };
}

/**
 * Pure. Only edited fields: a changed value is patched, a cleared one is
 * unset (back to the default).
 */
export function engineConfigChanges(
  baseline: EngineConfigValues,
  draft: EngineConfigValues
): { patch: Partial<EngineConfigValues>; unset: EngineConfigField[] } {
  const patch: Partial<EngineConfigValues> = {};
  const unset: EngineConfigField[] = [];
  for (const key of ENGINE_CONFIG_FIELDS) {
    const value = draft[key].trim();
    if (value === baseline[key]) continue;
    if (value) patch[key] = value;
    else unset.push(key);
  }
  return { patch, unset };
}

/** Status message for an HTTP failure. */
export function engineConfigFailure(status: number, fallback: 'load_failed' | 'save_failed') {
  if (status === 409) return 'conflict' as const;
  if (status === 401 || status === 403) return 'denied' as const;
  if (status === 400) return 'invalid' as const;
  return fallback;
}
