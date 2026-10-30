import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { credentialBindingReadiness } from '../foundation/credential-binding.js';
import { withEngineRuntimePreferencesTransaction } from './engine-runtime-preferences-transaction.js';
import { pathResolver } from '../path-resolver.js';
import { resolveActiveProfileRoot } from '../profile-root.js';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import {
  getEngineRuntimePreferences,
  previewEngineRuntimePreferences,
  saveEngineRuntimePreferences,
  type EngineRuntimePreferencesPatch,
} from './engine-runtime-preferences.js';
import {
  ENGINE_RUNTIME_OPERATOR_ROLE,
  withEngineRuntimePreferencesAccess,
} from './engine-runtime-preferences-access.js';

export interface EngineRuntimeOperatorPrincipal {
  role: string;
  source: 'loopback' | 'token' | 'anonymous';
  principalId?: string;
  loopback: boolean;
}
export class EngineRuntimeOperatorError extends Error {
  constructor(
    public readonly code: 'engine_config_conflict' | 'invalid_patch' | 'preference_rejected'
  ) {
    super(code);
  }
}
export const ENGINE_RUNTIME_PREFERENCE_KEYS = [
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
export interface EngineRuntimeOperatorUpdate {
  patch?: EngineRuntimePreferencesPatch;
  unset?: readonly (keyof EngineRuntimePreferencesPatch)[];
  expected_revision: string;
}
function target(principal: EngineRuntimeOperatorPrincipal) {
  if (
    getPluginExecutionContext() ||
    principal?.role !== 'localadmin' ||
    principal.source !== 'loopback' ||
    principal.loopback !== true ||
    !principal.principalId?.trim()
  )
    throw new Error('[ENGINE_RUNTIME_OPERATOR_DENIED]');
  credentialBindingReadiness();
  const root = resolveActiveProfileRoot({ lexicalOnly: true });
  const relative = path
    .relative(pathResolver.rootDir(), path.join(root, 'onboarding', 'engine-runtime.json'))
    .split(path.sep)
    .join('/');
  const profile =
    relative === 'knowledge/personal/onboarding/engine-runtime.json'
      ? { kind: 'personal' as const, id: 'personal' }
      : { kind: 'customer' as const, id: path.basename(root) };
  return { relative, profile };
}
function snapshot(profile: { kind: 'personal' | 'customer'; id: string }) {
  const preferences = getEngineRuntimePreferences();
  const revision = createHash('sha256')
    .update(JSON.stringify({ profile, preferences }))
    .digest('hex');
  return { preferences, profile, revision };
}
function run<T>(
  principal: EngineRuntimeOperatorPrincipal,
  action: (profile: { kind: 'personal' | 'customer'; id: string }) => T
): T {
  const selected = target(principal);
  return withEngineRuntimePreferencesTransaction(selected.relative, () =>
    withEngineRuntimePreferencesAccess(selected.relative, () =>
      withExecutionContext(ENGINE_RUNTIME_OPERATOR_ROLE, () => action(selected.profile))
    )
  );
}
export function getOperatorEngineRuntimePreferences(principal: EngineRuntimeOperatorPrincipal) {
  return run(principal, snapshot);
}
export function updateOperatorEngineRuntimePreferences(
  principal: EngineRuntimeOperatorPrincipal,
  update: EngineRuntimeOperatorUpdate
) {
  return run(principal, (profile) => {
    const keys = new Set<string>(ENGINE_RUNTIME_PREFERENCE_KEYS);
    const patch = update?.patch;
    const unset = update?.unset === undefined ? [] : update.unset;
    if (
      !update ||
      typeof update.expected_revision !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(update.expected_revision) ||
      (patch !== undefined && (!patch || typeof patch !== 'object' || Array.isArray(patch))) ||
      !Array.isArray(unset) ||
      Object.keys(update).some((key) => !['patch', 'unset', 'expected_revision'].includes(key)) ||
      Object.keys(patch || {}).some((key) => !keys.has(key)) ||
      unset.some((key) => !keys.has(key) || Object.hasOwn(patch || {}, key)) ||
      Object.keys(patch || {}).length + unset.length === 0
    )
      throw new EngineRuntimeOperatorError('invalid_patch');
    if (snapshot(profile).revision !== update.expected_revision)
      throw new EngineRuntimeOperatorError('engine_config_conflict');
    const merged = { ...patch };
    for (const key of unset) Object.assign(merged, { [key]: undefined });
    // The core schema remains the single source of field constraints. Guard,
    // scope and I/O errors retain their classification for the HTTP adapter.
    try {
      previewEngineRuntimePreferences(merged);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        message.startsWith('Invalid catalog engine-runtime-preferences at ') ||
        ENGINE_RUNTIME_PREFERENCE_KEYS.some((key) => message.startsWith(key + ' must '))
      )
        throw new EngineRuntimeOperatorError('preference_rejected');
      throw error;
    }
    saveEngineRuntimePreferences(merged);
    return snapshot(profile);
  });
}
