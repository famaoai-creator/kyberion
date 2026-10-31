import * as path from 'node:path';
import { nowIso } from '../foundation/time.js';
import { readJson, writeJson } from '../foundation/json.js';
import { credentialBindingReadiness } from '../foundation/credential-binding.js';
import { withEngineRuntimePreferencesTransaction } from './engine-runtime-preferences-transaction.js';
import { inspectReadPermission } from '../tier-guard.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { resolveActiveProfileRoot } from '../profile-root.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeMkdir } from '../secure-io.js';

/**
 * Operator-owned defaults for local engine binaries and commands used by
 * perception (ffmpeg/ffprobe/python) and voice (record/playback) paths.
 * Resolution order at every consumer: env > this preference > built-in
 * default — the file is the durable default, env stays the escape hatch.
 * Unlike the realtime conversation preferences these are shared across
 * commands (see/listen/watch/speak/voice recorder), not per-invocation.
 */
export interface EngineRuntimePreferences {
  version: '1.0.0';
  ffmpeg_bin?: string;
  ffprobe_bin?: string;
  python_bin?: string;
  audio_record_command?: string;
  audio_playback_backend?: string;
  /** FluidAudio/Parakeet batch STT bridge command (KYBERION_FLUID_AUDIO_STT_COMMAND). */
  fluid_audio_stt_command?: string;
  /** Registered streaming STT bridge id (KYBERION_STREAMING_STT_BRIDGE). */
  streaming_stt_bridge?: string;
  /** Registered streaming TTS bridge id (KYBERION_STREAMING_TTS_BRIDGE). */
  streaming_tts_bridge?: string;
  /** Agent runtime launch mode, e.g. pipe or pane (KYBERION_AGENT_RUNTIME_BACKEND). */
  agent_runtime_backend?: 'pipe' | 'pane';
  /** Pane-runtime provider id (KYBERION_AGENT_PANE_RUNTIME_PROVIDER). */
  agent_pane_runtime_provider?: string;
  updated_at?: string;
}

export type EngineRuntimePreferencesPatch = Partial<
  Omit<EngineRuntimePreferences, 'version' | 'updated_at'>
>;

const PREFERENCES_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/engine-runtime-preferences.schema.json'
);

/** Resolve the target, optionally deferring all profile/customer filesystem probes. */
function preferencesTarget(lexicalOnly: boolean): string {
  const filePath = path.resolve(
    resolveActiveProfileRoot({ lexicalOnly }),
    'onboarding',
    'engine-runtime.json'
  );
  const relative = path.relative(pathResolver.rootDir(), filePath);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('[RESOURCE_PATH_SCOPE] Engine runtime profile is outside the repository root');
  }
  return filePath;
}

function preferencesPath(): string {
  return assertSafeRepositoryPath(preferencesTarget(false), { allowMissingLeaf: true });
}

function preferencesCatalogAtPath(filePath: string) {
  return defineCatalog<EngineRuntimePreferences>({
    id: 'engine-runtime-preferences',
    path: filePath,
    schema: PREFERENCES_SCHEMA_PATH,
  });
}

function hasCommandControlCharacters(value: string): boolean {
  return value.includes('\u0000') || value.includes('\r') || value.includes('\n');
}

function validatePreferences(value: EngineRuntimePreferences): void {
  for (const key of ['ffmpeg_bin', 'ffprobe_bin', 'python_bin'] as const) {
    const bin = value[key];
    if (bin === undefined) continue;
    if (typeof bin !== 'string' || !bin.trim() || hasCommandControlCharacters(bin)) {
      throw new Error(key + ' must be a non-empty path without NUL or line breaks');
    }
    if (!path.isAbsolute(bin.trim())) {
      throw new Error(key + ' must be an absolute path');
    }
  }
  for (const key of [
    'audio_record_command',
    'audio_playback_backend',
    'fluid_audio_stt_command',
    'streaming_stt_bridge',
    'streaming_tts_bridge',
    'agent_runtime_backend',
    'agent_pane_runtime_provider',
  ] as const) {
    const command = value[key];
    if (command === undefined) continue;
    if (typeof command !== 'string' || !command.trim() || hasCommandControlCharacters(command)) {
      throw new Error(key + ' must be a non-empty value without NUL or line breaks');
    }
  }
}

function defaultPreferences(): EngineRuntimePreferences {
  return Object.freeze({ version: '1.0.0' });
}

function normalizeAndValidatePreferences(
  value: unknown,
  filePath: string
): EngineRuntimePreferences {
  const normalized =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : value;
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    const record = normalized as Record<string, unknown>;
    for (const key of ['ffmpeg_bin', 'ffprobe_bin', 'python_bin'] as const) {
      const bin = record[key];
      if (typeof bin === 'string') {
        if (hasCommandControlCharacters(bin))
          throw new Error(key + ' must not contain NUL or line breaks');
        record[key] = bin.trim();
      }
    }
    validatePreferences(normalized as EngineRuntimePreferences);
  }
  const validated = preferencesCatalogAtPath(filePath).validate(normalized, filePath);
  return Object.freeze({ ...validated });
}

export type EngineRuntimePreferencesReadiness =
  | { status: 'ready'; preferences: EngineRuntimePreferences }
  | { status: 'missing' }
  | { status: 'unavailable'; reason: 'personal_profile_not_authorized' };

/** Optional consumption never turns scope, policy, schema, or I/O failures into absence. */
export function engineRuntimePreferencesReadiness(): EngineRuntimePreferencesReadiness {
  // A missing task binding is normal for non-secret configuration discovery;
  // malformed/contradictory identities still fail before any profile probing.
  credentialBindingReadiness();
  const filePath = preferencesTarget(true);
  const permission = inspectReadPermission(filePath);
  if (!permission.allowed) {
    const defaultPersonalPath = pathResolver.knowledge('personal/onboarding/engine-runtime.json');
    if (permission.denialKind === 'tier_restriction' && filePath === defaultPersonalPath) {
      return { status: 'unavailable', reason: 'personal_profile_not_authorized' };
    }
    throw new Error(
      '[ENGINE_RUNTIME_PREFERENCES_READ_DENIED] ' +
        (permission.reason || 'Profile read is not authorized')
    );
  }
  assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(filePath)) return { status: 'missing' };
  if (!safeLstat(filePath).isFile()) {
    throw new Error('Engine runtime preferences must be a regular file: ' + filePath);
  }
  // No module/catalog instance is retained: every read rechecks content access,
  // observes profile switches and external edits, and returns a fresh snapshot.
  return {
    status: 'ready',
    preferences: normalizeAndValidatePreferences(readJson<unknown>(filePath), filePath),
  };
}

export function getEngineRuntimePreferencesPath(): string {
  return preferencesPath();
}

export function loadEngineRuntimePreferences(): EngineRuntimePreferences | null {
  const readiness = engineRuntimePreferencesReadiness();
  if (readiness.status === 'ready') return readiness.preferences;
  if (readiness.status === 'missing') return null;
  throw new Error(
    '[ENGINE_RUNTIME_PREFERENCES_UNAVAILABLE] Personal profile is not authorized in this execution; use an authorized operator context for configuration.'
  );
}

/** @deprecated Reads are fresh; retained for callers that previously invalidated the cache. */
export function resetEngineRuntimePreferencesCache(): void {
  // No process-global preference cache remains.
}

export function getEngineRuntimePreferences(): EngineRuntimePreferences {
  return loadEngineRuntimePreferences() || defaultPreferences();
}

/** Validate a proposed update exactly as save does, without writing profile state. */
export function previewEngineRuntimePreferences(
  patch: EngineRuntimePreferencesPatch
): EngineRuntimePreferences {
  const next: EngineRuntimePreferences = {
    ...getEngineRuntimePreferences(),
    ...patch,
    version: '1.0.0',
    updated_at: nowIso(),
  };
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    if (patch[key] === undefined) delete (next as unknown as Record<string, unknown>)[key];
  }
  return normalizeAndValidatePreferences(next, preferencesPath());
}

/** Permission-only admission precedes lock metadata and preserves reset repair. */
function authorizeMutationTarget(repair: boolean): string {
  credentialBindingReadiness();
  const filePath = preferencesTarget(true);
  const permission = inspectReadPermission(filePath);
  if (!permission.allowed) {
    if (
      !repair &&
      permission.denialKind === 'tier_restriction' &&
      filePath === pathResolver.knowledge('personal/onboarding/engine-runtime.json')
    )
      throw new Error(
        '[ENGINE_RUNTIME_PREFERENCES_UNAVAILABLE] Personal profile is not authorized in this execution; use an authorized operator context for configuration.'
      );
    throw new Error(
      '[ENGINE_RUNTIME_PREFERENCES_READ_DENIED] ' +
        (permission.reason || 'Profile read is not authorized')
    );
  }
  return filePath;
}
function mutatePreferences<T>(action: (filePath: string) => T, repair = false): T {
  const filePath = authorizeMutationTarget(repair);
  const relative = path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
  return withEngineRuntimePreferencesTransaction(relative, () => {
    assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    return action(filePath);
  });
}
export function saveEngineRuntimePreferences(
  patch: EngineRuntimePreferencesPatch
): EngineRuntimePreferences {
  return mutatePreferences((filePath) => {
    // Fresh read/merge/validation and publication share the API/CLI transaction.
    const validated = previewEngineRuntimePreferences(patch);
    safeMkdir(path.dirname(filePath), { recursive: true });
    writeJson(filePath, validated);
    resetEngineRuntimePreferencesCache();
    return validated;
  });
}

/** Restore empty defaults, including repair of malformed previous JSON. */
export function resetEngineRuntimePreferences(): EngineRuntimePreferences {
  return mutatePreferences((filePath) => {
    const validated = normalizeAndValidatePreferences(
      { ...defaultPreferences(), updated_at: nowIso() },
      filePath
    );
    safeMkdir(path.dirname(filePath), { recursive: true });
    writeJson(filePath, validated);
    return validated;
  }, true);
}
