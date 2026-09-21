import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir, safeStat } from './secure-io.js';
import {
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
  type SeamProviderCandidate,
  type SeamProviderDecision,
} from './seam-provider-selection.js';
import { resolveVoiceTtsAdapter } from './voice-provider-adapters.js';

export type VoiceEngineStatus = 'active' | 'shadow' | 'disabled';
export type VoiceEngineKind = 'native_local' | 'voice_clone_service';
export type VoiceEnginePlatform = 'any' | 'darwin' | 'linux' | 'win32';
export type VoiceEngineArtifactFormat = 'wav' | 'mp3' | 'ogg' | 'aiff';

export interface VoiceEngineRecord {
  engine_id: string;
  display_name: string;
  kind: VoiceEngineKind;
  provider: string;
  status: VoiceEngineStatus;
  platforms: VoiceEnginePlatform[];
  /**
   * Languages the engine speaks through Kyberion's runtime path (BCP-47
   * primary subtags), or ['*'] when the host's installed voices decide.
   * Undeclared = unknown; never excluded by language.
   */
  languages?: string[];
  language_notes?: string;
  model_id?: string;
  bridge_script?: string;
  tts_adapter_id?: string;
  runtime_id?: string;
  live_presence?: boolean;
  stt_bridge_script?: string;
  supports: {
    list_voices: boolean;
    playback: boolean;
    voice_clone?: boolean;
    icl_ref_audio?: boolean;
    artifact_formats: VoiceEngineArtifactFormat[];
  };
  fallback_engine_id?: string;
  notes?: string;
}

export interface VoiceEngineRegistry {
  version: string;
  default_engine_id: string;
  engines: VoiceEngineRecord[];
}

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge(
  'product/governance/voice-engine-registry.json'
);
const DEFAULT_REGISTRY_DIR = pathResolver.knowledge('product/governance/voice-engines');

let cachedRegistryPath: string | null = null;
let cachedRegistryDir: string | null = null;
let cachedRegistry: VoiceEngineRegistry | null = null;

function getRegistryPath(): string {
  const configured =
    getRegisteredEnvText('KYBERION_VOICE_ENGINE_REGISTRY_PATH')?.trim() || DEFAULT_REGISTRY_PATH;
  return assertSafeRepositoryPath(configured, { allowMissingLeaf: true });
}

function getRegistryDir(): string {
  const configured =
    getRegisteredEnvText('KYBERION_VOICE_ENGINE_REGISTRY_DIR')?.trim() || DEFAULT_REGISTRY_DIR;
  return assertSafeRepositoryPath(configured, { allowMissingLeaf: true });
}

const voiceEngineCatalog = defineCatalog<VoiceEngineRegistry>({
  id: 'voice-engine-registry',
  path: getRegistryPath,
  schema: pathResolver.knowledge('product/schemas/voice-engine-registry.schema.json'),
});

function loadRegistryFromPath(registryPath: string): VoiceEngineRegistry {
  const safeRegistryPath = assertSafeRepositoryPath(registryPath);
  return defineCatalog<VoiceEngineRegistry>({
    id: 'voice-engine-registry.entry',
    path: safeRegistryPath,
    schema: pathResolver.knowledge('product/schemas/voice-engine-registry.schema.json'),
  }).load();
}

function loadRegistryDirectory(registryDir: string): VoiceEngineRegistry {
  const dir = assertSafeRepositoryPath(registryDir, { allowMissingLeaf: true });
  if (!safeExistsSync(dir)) {
    throw new Error(`Voice engine registry directory not found: ${dir}`);
  }

  const files = safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    throw new Error(`Voice engine registry directory is empty: ${dir}`);
  }

  const engines: VoiceEngineRecord[] = [];
  let version = '';
  let defaultEngineId = '';

  for (const file of files) {
    const filePath = assertSafeRepositoryPath(path.join(dir, file));
    if (!safeStat(filePath).isFile()) {
      continue;
    }

    const parsed = loadRegistryFromPath(filePath);
    if (!defaultEngineId) {
      defaultEngineId = parsed.default_engine_id;
      version = parsed.version;
    } else if (parsed.default_engine_id !== defaultEngineId) {
      throw new Error(`Voice engine registry default_engine_id mismatch in ${file}`);
    }
    if (parsed.version !== version) {
      throw new Error(`Voice engine registry version mismatch in ${file}`);
    }

    const record = parsed.engines?.[0];
    if (!record) {
      throw new Error(`Voice engine registry file ${file} must contain exactly one engine`);
    }
    if (file.replace(/\.json$/i, '') !== record.engine_id) {
      throw new Error(
        `Voice engine registry file ${file} must match engine_id ${record.engine_id}`
      );
    }
    engines.push(record);
  }

  if (!defaultEngineId) {
    throw new Error(`Voice engine registry directory produced no engines: ${dir}`);
  }

  return {
    version,
    default_engine_id: defaultEngineId,
    engines,
  };
}

export function loadVoiceEngineRegistryDirectory(
  registryDir = getRegistryDir()
): VoiceEngineRegistry {
  return loadRegistryDirectory(registryDir);
}

export function _resetVoiceEngineRegistryCacheForTests(): void {
  cachedRegistryPath = null;
  cachedRegistryDir = null;
  cachedRegistry = null;
  voiceEngineCatalog.reset();
}

export function getVoiceEngineRegistry(): VoiceEngineRegistry {
  const registryPath = getRegistryPath();
  const registryDir = getRegistryDir();
  if (cachedRegistryPath === registryPath && cachedRegistryDir === registryDir && cachedRegistry)
    return cachedRegistry;

  if (registryPath === DEFAULT_REGISTRY_PATH && safeExistsSync(registryDir)) {
    const parsed = loadRegistryDirectory(registryDir);
    cachedRegistryPath = registryPath;
    cachedRegistryDir = registryDir;
    cachedRegistry = parsed;
    return parsed;
  }

  const parsed = voiceEngineCatalog.load();
  cachedRegistryPath = registryPath;
  cachedRegistryDir = registryDir;
  cachedRegistry = parsed;
  return parsed;
}

export function listVoiceEngines(
  status: VoiceEngineStatus | 'all' = 'active'
): VoiceEngineRecord[] {
  const registry = getVoiceEngineRegistry();
  if (status === 'all') return registry.engines;
  return registry.engines.filter((engine) => engine.status === status);
}

export function getVoiceEngineRecord(engineId?: string): VoiceEngineRecord {
  const registry = getVoiceEngineRegistry();
  const resolvedEngineId = engineId || registry.default_engine_id;
  return (
    registry.engines.find((engine) => engine.engine_id === resolvedEngineId) ||
    registry.engines.find((engine) => engine.engine_id === registry.default_engine_id) ||
    registry.engines[0]
  );
}

function isSupportedPlatform(engine: VoiceEngineRecord, platform: NodeJS.Platform): boolean {
  return (
    engine.platforms.includes('any') || engine.platforms.includes(platform as VoiceEnginePlatform)
  );
}

export function resolveVoiceEngineForPlatform(
  engineId?: string,
  platform: NodeJS.Platform = process.platform
): VoiceEngineRecord {
  const registry = getVoiceEngineRegistry();
  const defaultEngine = getVoiceEngineRecord(registry.default_engine_id);
  const visited = new Set<string>();
  let current = getVoiceEngineRecord(engineId);

  while (current) {
    if (visited.has(current.engine_id)) break;
    visited.add(current.engine_id);
    if (current.status === 'active' && isSupportedPlatform(current, platform)) {
      return current;
    }
    if (current.fallback_engine_id) {
      current = getVoiceEngineRecord(current.fallback_engine_id);
      continue;
    }
    break;
  }

  if (defaultEngine.status === 'active' && isSupportedPlatform(defaultEngine, platform)) {
    return defaultEngine;
  }

  throw new Error(`No compatible active voice engine found for platform ${platform}`);
}

/* ------------------------------------------------------------------ *
 * voice-tts-engine seam: language-aware, purpose-driven engine choice.
 * ------------------------------------------------------------------ */

export const VOICE_TTS_ENGINE_SEAM = 'voice-tts-engine';

/** Normalise a language tag to its lower-case primary subtag ('ja-JP' → 'ja'). */
export function normalizeLanguageTag(tag: string | undefined | null): string {
  return (
    String(tag ?? '')
      .trim()
      .toLowerCase()
      .split(/[-_]/u)[0] ?? ''
  );
}

/**
 * Cheap script-based language guess for TTS routing, not a classifier:
 * kana (or kana + kanji) → ja, Hangul → ko, Han without kana → zh, else en.
 */
export function detectTextLanguage(text: string): string {
  const value = String(text ?? '');
  if (/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/u.test(value)) return 'ja';
  if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(value)) return 'ko';
  if (/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(value)) return 'zh';
  return 'en';
}

/** Undeclared languages or '*' count as supported (the host decides). */
export function voiceEngineSupportsLanguage(engine: VoiceEngineRecord, language: string): boolean {
  const wanted = normalizeLanguageTag(language);
  if (!wanted || !engine.languages || engine.languages.length === 0) return true;
  return engine.languages.includes('*') || engine.languages.includes(wanted);
}

/** Engines behind the external_provider adapter send text off the machine. */
export function isLocalVoiceEngine(engine: VoiceEngineRecord): boolean {
  return engine.tts_adapter_id !== 'external_provider';
}

export function isVoiceCloneEngine(engine: VoiceEngineRecord): boolean {
  return Boolean(engine.supports.voice_clone && engine.supports.icl_ref_audio);
}

/** Hard needs of a synthesis request; an engine that cannot meet them is never chosen. */
export interface VoiceTtsRequirements {
  /** Language of the text (primary subtag). */
  language?: string;
  platform?: NodeJS.Platform;
  /** Artifact format the request must produce. */
  format?: VoiceEngineArtifactFormat;
  /**
   * Voice identity class: 'clone' = must speak with the profile's cloned voice
   * (voice_clone + icl_ref_audio); 'stock' = must not turn the profile's
   * reference samples into a cloned voice (clone-capable engines are excluded).
   * Unset: no identity constraint.
   */
  identity?: 'clone' | 'stock';
  /** Text must not leave the machine. */
  localOnly?: boolean;
}

export function unmetVoiceTtsRequirements(
  engine: VoiceEngineRecord,
  requires: VoiceTtsRequirements
): string[] {
  const unmet: string[] = [];
  if (engine.status !== 'active') unmet.push(`status ${engine.status}`);
  // external_provider engines have no Kyberion TTS runtime adapter yet; the
  // render path would silently fall to the host voice under their name.
  if (resolveVoiceTtsAdapter(engine).adapter_id === 'unsupported') {
    unmet.push(`no runtime adapter (${engine.tts_adapter_id ?? 'unknown'})`);
  }
  if (requires.platform && !isSupportedPlatform(engine, requires.platform)) {
    unmet.push(`platform ${requires.platform}`);
  }
  if (requires.format && !engine.supports.artifact_formats.includes(requires.format)) {
    unmet.push(`format ${requires.format}`);
  }
  if (requires.language && !voiceEngineSupportsLanguage(engine, requires.language)) {
    unmet.push(`language ${normalizeLanguageTag(requires.language)}`);
  }
  if (requires.identity === 'clone' && !isVoiceCloneEngine(engine)) {
    unmet.push('voice_clone (identity guard)');
  }
  if (requires.identity === 'stock' && isVoiceCloneEngine(engine)) {
    unmet.push('would clone the profile voice (identity guard)');
  }
  if (requires.localOnly && !isLocalVoiceEngine(engine)) unmet.push('local_only');
  return unmet;
}

export interface SelectVoiceTtsEngineOptions {
  /** Governed purpose (naturalness / latency / privacy); unset = seam default / fallback. */
  purpose?: string;
  requires?: VoiceTtsRequirements;
  /** Engines to choose from. Default: every engine in the registry. */
  engines?: VoiceEngineRecord[];
  /** Request facts operator rules may match (at least `language` when known). */
  context?: Record<string, string>;
  /** Record + pin (inside a mission). Default true; calibration/explain pass false. */
  record?: boolean;
}

export interface VoiceTtsEngineSelection {
  /** Eligible engines, best first. */
  engines: VoiceEngineRecord[];
  decision: SeamProviderDecision;
}

/** Thrown when no engine can meet the requirements; carries the audited decision. */
export class VoiceTtsEngineSelectionError extends Error {
  constructor(readonly decision: SeamProviderDecision) {
    super(`[VOICE_TTS_SELECTION] ${decision.rationale}`);
    this.name = 'VoiceTtsEngineSelectionError';
  }
}

export function listVoiceTtsEngineCandidates(
  requires: VoiceTtsRequirements = {},
  engines: VoiceEngineRecord[] = listVoiceEngines('all')
): SeamProviderCandidate[] {
  return engines.map((engine) => {
    const unmet = unmetVoiceTtsRequirements(engine, requires);
    return { id: engine.engine_id, eligible: unmet.length === 0, unmet };
  });
}

/**
 * Purpose-driven engine choice. Requirements decide eligibility from the
 * engine records; the governed policy ranks the eligible ones; the decision
 * is audited and (inside a mission) pinned under the purpose or `default`.
 * Callers that name an engine explicitly never call this.
 */
export function selectVoiceTtsEngine(
  options: SelectVoiceTtsEngineOptions = {}
): VoiceTtsEngineSelection {
  const purpose = String(options.purpose || '').trim() || undefined;
  const engines = options.engines ?? listVoiceEngines('all');
  const requires = options.requires ?? {};
  if (purpose) {
    const known = listSeamSelectionPurposes(VOICE_TTS_ENGINE_SEAM);
    if (!known.includes(purpose)) {
      throw new Error(
        `[VOICE_TTS_SELECTION] unknown purpose '${purpose}' for seam '${VOICE_TTS_ENGINE_SEAM}' (known: ${known.join(', ')})`
      );
    }
  }
  const language = normalizeLanguageTag(requires.language);
  const context = {
    ...(language ? { language } : {}),
    ...(options.context ?? {}),
  };
  const decision = resolveSeamProviderDecision({
    seam: VOICE_TTS_ENGINE_SEAM,
    candidates: listVoiceTtsEngineCandidates(requires, engines),
    ...(purpose ? { purpose } : {}),
    ...(Object.keys(context).length ? { context } : {}),
    decisionKey: purpose ?? 'default',
    ...(options.record === false ? { record: false, pin: false } : {}),
  });
  if (decision.strategy === 'unresolved') throw new VoiceTtsEngineSelectionError(decision);
  const byId = new Map(engines.map((engine) => [engine.engine_id, engine]));
  return {
    engines: decision.ranked.flatMap((id) => byId.get(id) ?? []),
    decision,
  };
}
