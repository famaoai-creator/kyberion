import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const INTENT_EXECUTION_PROFILE_REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'public/schemas/intent-execution-profile-registry.schema.json'
);

export type IntentExecutionProfileStatus = 'active' | 'experimental' | 'conceptual' | 'deprecated';
export type IntentExecutionProfileKind = 'intent-execution-profile';
export type IntentExecutionSurface = 'cli' | 'voice' | 'video' | 'blog' | 'meeting';

export interface IntentExecutionProfileProviderSelection {
  voice?: {
    engine_id?: string;
    provider?: string;
  };
  stt?: {
    engine_id?: string;
    provider?: string;
  };
  video?: {
    backend_id?: string;
    provider?: string;
  };
  meeting?: {
    provider?: 'google_meet' | 'teams_pipeline' | 'zoom' | 'auto';
    mode?: 'transcribe' | 'realtime';
    node?: 'local' | 'named-node';
    audio_bridge?: 'blackhole' | 'pulseaudio' | 'none';
    url_policy?: 'explicit_only' | 'explicit_or_detected';
  };
}

export interface IntentExecutionProfileSurfaceOverride {
  enabled_toolsets?: string[];
  capability_bundle_id?: string;
  provider_selection?: IntentExecutionProfileProviderSelection;
}

export interface IntentExecutionProfileEntry {
  profile_id: string;
  status: IntentExecutionProfileStatus;
  kind: IntentExecutionProfileKind;
  summary: string;
  default_for_intent?: boolean;
  intents?: string[];
  capability_bundle_id?: string;
  enabled_toolsets?: string[];
  provider_selection?: IntentExecutionProfileProviderSelection;
  surface_overrides?: Record<string, IntentExecutionProfileSurfaceOverride>;
  references?: string[];
  notes?: string;
}

export interface IntentExecutionProfileRegistryFile {
  version: string;
  profiles: IntentExecutionProfileEntry[];
}

export interface IntentExecutionProfileResolutionHints {
  surface?: string;
  runtime_context?: Record<string, unknown>;
}

let registryCache: IntentExecutionProfileRegistryFile | null = null;
let registryValidateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (registryValidateFn) return registryValidateFn;
  registryValidateFn = compileSchemaFromPath(ajv, INTENT_EXECUTION_PROFILE_REGISTRY_SCHEMA_PATH);
  return registryValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

export function loadIntentExecutionProfileRegistry(): IntentExecutionProfileRegistryFile {
  if (registryCache) return registryCache;
  const filePath = pathResolver.knowledge('public/governance/intent-execution-profile-registry.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as IntentExecutionProfileRegistryFile;
  const validate = ensureValidator();
  if (!validate(parsed)) {
    throw new Error(`Invalid intent-execution-profile-registry: ${errorsFrom(validate).join('; ')}`);
  }
  registryCache = parsed;
  return registryCache;
}

function statusRank(status: IntentExecutionProfileStatus): number {
  switch (status) {
    case 'active':
      return 0;
    case 'experimental':
      return 1;
    case 'conceptual':
      return 2;
    case 'deprecated':
      return 3;
  }
}

function normalizeSurface(surface?: string): string | undefined {
  const trimmed = typeof surface === 'string' ? surface.trim().toLowerCase() : '';
  return trimmed || undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getNestedString(source: unknown, keys: string[]): string | undefined {
  let current: any = source;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return readString(current);
}

function mergeProviderSelection(
  base?: IntentExecutionProfileProviderSelection,
  override?: IntentExecutionProfileProviderSelection
): IntentExecutionProfileProviderSelection | undefined {
  if (!base && !override) return undefined;
  return {
    ...(base || {}),
    ...(override || {}),
    ...(base?.voice || override?.voice
      ? { voice: { ...(base?.voice || {}), ...(override?.voice || {}) } }
      : {}),
    ...(base?.stt || override?.stt
      ? { stt: { ...(base?.stt || {}), ...(override?.stt || {}) } }
      : {}),
    ...(base?.video || override?.video
      ? { video: { ...(base?.video || {}), ...(override?.video || {}) } }
      : {}),
    ...(base?.meeting || override?.meeting
      ? { meeting: { ...(base?.meeting || {}), ...(override?.meeting || {}) } }
      : {}),
  };
}

function mergeSurfaceOverride(
  profile: IntentExecutionProfileEntry,
  surface?: string
): IntentExecutionProfileEntry {
  const override = surface ? profile.surface_overrides?.[surface] : undefined;
  if (!override) return profile;
  return {
    ...profile,
    capability_bundle_id: override.capability_bundle_id || profile.capability_bundle_id,
    enabled_toolsets: override.enabled_toolsets || profile.enabled_toolsets,
    provider_selection: mergeProviderSelection(profile.provider_selection, override.provider_selection),
  };
}

function extractExecutionHints(
  hints?: IntentExecutionProfileResolutionHints
): {
  surface?: string;
  meetingProvider?: string;
  meetingMode?: string;
  voiceEngineId?: string;
  sttEngineId?: string;
  videoBackendId?: string;
} {
  const runtimeContext = hints?.runtime_context || {};
  return {
    surface: normalizeSurface(hints?.surface || getNestedString(runtimeContext, ['surface']) || getNestedString(runtimeContext, ['channel'])),
    meetingProvider:
      getNestedString(runtimeContext, ['meeting', 'provider']) ||
      getNestedString(runtimeContext, ['meeting_provider']) ||
      getNestedString(runtimeContext, ['provider']),
    meetingMode:
      getNestedString(runtimeContext, ['meeting', 'mode']) ||
      getNestedString(runtimeContext, ['meeting_mode']),
    voiceEngineId:
      getNestedString(runtimeContext, ['voice', 'engine_id']) ||
      getNestedString(runtimeContext, ['voice_engine_id']),
    sttEngineId:
      getNestedString(runtimeContext, ['stt', 'engine_id']) ||
      getNestedString(runtimeContext, ['stt_engine_id']) ||
      getNestedString(runtimeContext, ['transcription', 'engine_id']),
    videoBackendId:
      getNestedString(runtimeContext, ['video', 'backend_id']) ||
      getNestedString(runtimeContext, ['video_backend_id']),
  };
}

function scoreProfile(
  profile: IntentExecutionProfileEntry,
  hints: ReturnType<typeof extractExecutionHints>
): number {
  let score = profile.default_for_intent ? 10 : 0;
  const selection = profile.provider_selection || {};
  if (selection.meeting?.provider && hints.meetingProvider && selection.meeting.provider === hints.meetingProvider) {
    score += 50;
  }
  if (selection.meeting?.mode && hints.meetingMode && selection.meeting.mode === hints.meetingMode) {
    score += 20;
  }
  if (selection.voice?.engine_id && hints.voiceEngineId && selection.voice.engine_id === hints.voiceEngineId) {
    score += 40;
  }
  if (selection.stt?.engine_id && hints.sttEngineId && selection.stt.engine_id === hints.sttEngineId) {
    score += 35;
  }
  if (selection.video?.backend_id && hints.videoBackendId && selection.video.backend_id === hints.videoBackendId) {
    score += 40;
  }
  if (hints.surface && profile.surface_overrides?.[hints.surface]) {
    score += 10;
  }
  return score;
}

function sortProfiles(left: IntentExecutionProfileEntry, right: IntentExecutionProfileEntry): number {
  const statusCompare = statusRank(left.status) - statusRank(right.status);
  if (statusCompare !== 0) return statusCompare;
  if (left.default_for_intent !== right.default_for_intent) {
    return left.default_for_intent ? -1 : 1;
  }
  return left.profile_id.localeCompare(right.profile_id);
}

export function resolveExecutionProfileForIntent(
  intentId?: string,
  hints?: IntentExecutionProfileResolutionHints
): IntentExecutionProfileEntry | null {
  if (!intentId) return null;
  const extractedHints = extractExecutionHints(hints);
  const matched = loadIntentExecutionProfileRegistry()
    .profiles
    .filter((profile) => (profile.intents || []).includes(intentId))
    .map((profile) => mergeSurfaceOverride(profile, extractedHints.surface))
    .sort((left, right) => {
      const scoreDiff = scoreProfile(right, extractedHints) - scoreProfile(left, extractedHints);
      if (scoreDiff !== 0) return scoreDiff;
      return sortProfiles(left, right);
    });
  return matched[0] || null;
}

export function summarizeRelevantExecutionProfilesForIntentIds(
  intentIds: string[],
  hints?: IntentExecutionProfileResolutionHints
): string {
  const profilesById = new Map<string, IntentExecutionProfileEntry>();
  for (const intentId of intentIds) {
    const profile = resolveExecutionProfileForIntent(intentId, hints);
    if (!profile) continue;
    profilesById.set(profile.profile_id, profile);
  }

  const profiles = [...profilesById.values()].map((profile) => ({
    profile_id: profile.profile_id,
    status: profile.status,
    kind: profile.kind,
    summary: profile.summary,
    default_for_intent: Boolean(profile.default_for_intent),
    capability_bundle_id: profile.capability_bundle_id || '',
    enabled_toolsets: profile.enabled_toolsets || [],
    provider_selection: profile.provider_selection || {},
    references: profile.references || [],
  }));

  return JSON.stringify(profiles, null, 2);
}

export function summarizeRelevantExecutionProfilesForIntentIdsCompact(
  intentIds: string[],
  hints?: IntentExecutionProfileResolutionHints
): string {
  const profilesById = new Map<string, IntentExecutionProfileEntry>();
  for (const intentId of intentIds) {
    const profile = resolveExecutionProfileForIntent(intentId, hints);
    if (!profile) continue;
    profilesById.set(profile.profile_id, profile);
  }

  const profiles = [...profilesById.values()].sort(sortProfiles);
  if (profiles.length === 0) return 'none';

  return profiles
    .map((profile) => {
      const toolsets = (profile.enabled_toolsets || []).slice(0, 4).join(', ') || 'n/a';
      const bundle = profile.capability_bundle_id || 'n/a';
      const selection = profile.provider_selection || {};
      const providerBits = [
        selection.voice?.engine_id ? `voice=${selection.voice.engine_id}` : '',
        selection.stt?.engine_id ? `stt=${selection.stt.engine_id}` : '',
        selection.video?.backend_id ? `video=${selection.video.backend_id}` : '',
        selection.meeting?.provider
          ? `meeting=${selection.meeting.provider}/${selection.meeting.mode || 'n/a'}`
          : '',
      ].filter(Boolean).join(' ');
      return `- ${profile.profile_id} [${profile.status}] default=${profile.default_for_intent ? 'yes' : 'no'} bundle=${bundle} toolsets=${toolsets}${providerBits ? ` provider=${providerBits}` : ''}`;
    })
    .join('\n');
}

export function resetIntentExecutionProfileRegistryCache(): void {
  registryCache = null;
}
