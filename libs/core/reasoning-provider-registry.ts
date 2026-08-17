/**
 * Declarative reasoning-provider registry.
 *
 * The runtime still owns the construction of built-in adapters, but provider
 * identity, capability metadata, and the extension seam live here. This keeps
 * routing policy independent from the bootstrap switch and gives managed
 * packs a single, reversible registration point for provider modules.
 */

import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import type { ReasoningBackendCandidate } from './reasoning-backend.js';
import type { IntentExtractorCandidate } from './intent-extractor.js';
import type { VoiceBridgeCandidate } from './voice-bridge.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { assertModuleInvariant } from './invariants.js';

export interface ReasoningProviderCapabilities {
  reasoning: boolean;
  structured_output: boolean;
  abort: boolean;
  session_continuity: boolean;
  images: boolean;
}

export interface ReasoningProviderDescriptor {
  mode: ReasoningBackendMode;
  provider: string;
  module: string;
  capabilities: ReasoningProviderCapabilities;
  env_keys: string[];
}

export interface ReasoningProviderRuntimeBundle {
  mode: ReasoningBackendMode;
  backend: ReasoningBackendCandidate;
  intentExtractor?: IntentExtractorCandidate;
  voiceBridge?: VoiceBridgeCandidate;
}

export type ReasoningProviderConformanceStatus = 'verified' | 'declared' | 'unavailable' | 'failed';

export interface ReasoningProviderConformanceCheck {
  name: 'prompt' | 'structured_output' | 'abort' | 'usage';
  status: ReasoningProviderConformanceStatus;
  evidence: string;
}

/**
 * Evidence supplied by a provider module at activation time.
 *
 * `live: false` is intentionally representable so offline reports can state
 * what was not exercised. Such a report is not sufficient for non-stub
 * plugin activation; the activation gate below requires live verification of
 * the provider-facing checks.
 */
export interface ReasoningProviderConformanceEvidence {
  version: '1.0.0';
  backend: string;
  live: boolean;
  passed: boolean;
  checks: ReasoningProviderConformanceCheck[];
}

export interface ReasoningProviderRegistrationOptions {
  conformance?: ReasoningProviderConformanceEvidence;
  requireConformance?: boolean;
}

export interface ReasoningProviderBuildContext {
  mode: ReasoningBackendMode;
  descriptor: ReasoningProviderDescriptor;
  /** Deliberately opaque so provider modules cannot depend on bootstrap internals. */
  options: unknown;
}

export type ReasoningProviderFactory = (
  context: ReasoningProviderBuildContext
) => ReasoningProviderRuntimeBundle | null;

interface RegistryFile {
  version?: string;
  providers?: unknown;
}

const REGISTRY_PATH = pathResolver.knowledge('product/governance/reasoning-provider-registry.json');

const KNOWN_MODES = new Set<ReasoningBackendMode>([
  'claude-cli',
  'codex-cli',
  'claude-agent',
  'anthropic',
  'gemini-cli',
  'gemini-api',
  'agy-cli',
  'grok-cli',
  'grok-api',
  'copilot',
  'local',
  'ollama',
  'vllm',
  'lmstudio',
  'llamacpp',
  'mlx',
  'localai',
  'nemotron',
  'nemotron-api',
  'openrouter',
  'stub',
]);

const FALLBACK_CAPABILITIES: ReasoningProviderCapabilities = {
  reasoning: true,
  structured_output: true,
  abort: false,
  session_continuity: false,
  images: false,
};

let cachedDescriptors: readonly ReasoningProviderDescriptor[] | null = null;
const registeredFactories = new Map<ReasoningBackendMode, ReasoningProviderFactory>();
const CONFORMANCE_CHECK_NAMES = ['prompt', 'structured_output', 'abort', 'usage'] as const;
const CONFORMANCE_STATUSES = ['verified', 'declared', 'unavailable', 'failed'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseDescriptor(value: unknown): ReasoningProviderDescriptor | null {
  if (
    !isRecord(value) ||
    typeof value.mode !== 'string' ||
    !KNOWN_MODES.has(value.mode as ReasoningBackendMode)
  ) {
    return null;
  }
  if (typeof value.provider !== 'string' || typeof value.module !== 'string') return null;
  const rawCapabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const rawEnvKeys = Array.isArray(value.env_keys) ? value.env_keys : [];
  const descriptor: ReasoningProviderDescriptor = {
    mode: value.mode as ReasoningBackendMode,
    provider: value.provider,
    module: value.module,
    capabilities: {
      reasoning: parseBoolean(rawCapabilities.reasoning, FALLBACK_CAPABILITIES.reasoning),
      structured_output: parseBoolean(
        rawCapabilities.structured_output,
        FALLBACK_CAPABILITIES.structured_output
      ),
      abort: parseBoolean(rawCapabilities.abort, FALLBACK_CAPABILITIES.abort),
      session_continuity: parseBoolean(
        rawCapabilities.session_continuity,
        FALLBACK_CAPABILITIES.session_continuity
      ),
      images: parseBoolean(rawCapabilities.images, FALLBACK_CAPABILITIES.images),
    },
    env_keys: rawEnvKeys.filter((entry): entry is string => typeof entry === 'string'),
  };
  // The prompt-reconstruction invariant is documented until PI-05 supplies
  // the durable request log; descriptor validation remains runtime-owned.
  assertModuleInvariant('reasoning-provider-registry', 'prompt-reconstruction', descriptor);
  return descriptor;
}

function assertConformanceEvidence(
  mode: ReasoningBackendMode,
  evidence: ReasoningProviderConformanceEvidence | undefined
): void {
  if (!evidence) {
    throw new Error(`[REASONING_PROVIDER_CONFORMANCE_REQUIRED] ${mode}`);
  }
  if (
    evidence.version !== '1.0.0' ||
    typeof evidence.backend !== 'string' ||
    !evidence.backend.trim() ||
    typeof evidence.live !== 'boolean' ||
    typeof evidence.passed !== 'boolean' ||
    !Array.isArray(evidence.checks)
  ) {
    throw new Error(`[REASONING_PROVIDER_CONFORMANCE_INVALID] ${mode}`);
  }

  const seen = new Set<string>();
  for (const check of evidence.checks) {
    if (
      !check ||
      !CONFORMANCE_CHECK_NAMES.includes(check.name) ||
      !CONFORMANCE_STATUSES.includes(check.status) ||
      typeof check.evidence !== 'string' ||
      seen.has(check.name)
    ) {
      throw new Error(`[REASONING_PROVIDER_CONFORMANCE_INVALID] ${mode}`);
    }
    seen.add(check.name);
  }
  if (seen.size !== CONFORMANCE_CHECK_NAMES.length || !evidence.passed) {
    throw new Error(`[REASONING_PROVIDER_CONFORMANCE_FAILED] ${mode}`);
  }
  const requiredLiveChecks = new Set(['prompt', 'structured_output', 'abort']);
  const hasVerifiedLiveContract =
    evidence.live &&
    evidence.checks.every(
      (check) => !requiredLiveChecks.has(check.name) || check.status === 'verified'
    );
  if (!hasVerifiedLiveContract) {
    throw new Error(`[REASONING_PROVIDER_CONFORMANCE_FAILED] ${mode}`);
  }
}

function loadDescriptors(): readonly ReasoningProviderDescriptor[] {
  if (!safeExistsSync(REGISTRY_PATH)) return [];
  let parsed: RegistryFile;
  try {
    parsed = JSON.parse(
      safeReadFile(REGISTRY_PATH, { encoding: 'utf8' }) as string
    ) as RegistryFile;
  } catch (error) {
    throw new Error(
      `Invalid reasoning provider registry at ${REGISTRY_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!Array.isArray(parsed.providers)) {
    throw new Error(
      `Invalid reasoning provider registry at ${REGISTRY_PATH}: providers must be an array`
    );
  }
  const descriptors = parsed.providers
    .map(parseDescriptor)
    .filter((entry): entry is ReasoningProviderDescriptor => entry !== null);
  const seen = new Set<ReasoningBackendMode>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.mode)) {
      throw new Error(`Duplicate reasoning provider mode: ${descriptor.mode}`);
    }
    seen.add(descriptor.mode);
  }
  return descriptors;
}

export function listReasoningProviderDescriptors(): readonly ReasoningProviderDescriptor[] {
  cachedDescriptors ??= loadDescriptors();
  return cachedDescriptors;
}

export function listReasoningProviderModes(): readonly ReasoningBackendMode[] {
  return listReasoningProviderDescriptors().map((descriptor) => descriptor.mode);
}

export function getReasoningProviderDescriptor(
  mode: ReasoningBackendMode
): ReasoningProviderDescriptor | undefined {
  return listReasoningProviderDescriptors().find((descriptor) => descriptor.mode === mode);
}

/** Register a provider module for an existing governed mode. */
export function registerReasoningProvider(
  descriptor: ReasoningProviderDescriptor,
  factory: ReasoningProviderFactory,
  options: ReasoningProviderRegistrationOptions = {}
): () => void {
  if (!KNOWN_MODES.has(descriptor.mode)) {
    throw new Error(`Unknown reasoning provider mode: ${descriptor.mode}`);
  }
  if (registeredFactories.has(descriptor.mode)) {
    throw new Error(`Duplicate reasoning provider factory: ${descriptor.mode}`);
  }
  const governedDescriptor = getReasoningProviderDescriptor(descriptor.mode);
  if (!governedDescriptor) {
    throw new Error(`Reasoning provider mode is not governed: ${descriptor.mode}`);
  }
  if (
    governedDescriptor.provider !== descriptor.provider ||
    governedDescriptor.module !== descriptor.module
  ) {
    throw new Error(`Reasoning provider descriptor mismatch: ${descriptor.mode}`);
  }
  if (options.requireConformance && descriptor.mode !== 'stub') {
    assertConformanceEvidence(descriptor.mode, options.conformance);
  }
  registeredFactories.set(descriptor.mode, factory);
  return () => {
    if (registeredFactories.get(descriptor.mode) === factory) {
      registeredFactories.delete(descriptor.mode);
    }
  };
}

export function buildRegisteredReasoningProvider(
  mode: ReasoningBackendMode,
  options: unknown
): ReasoningProviderRuntimeBundle | null {
  const factory = registeredFactories.get(mode);
  if (!factory) return null;
  const descriptor = getReasoningProviderDescriptor(mode);
  if (!descriptor) throw new Error(`Reasoning provider factory has no descriptor: ${mode}`);
  return factory({ mode, descriptor, options });
}

export function resetReasoningProviderRegistryForTests(): void {
  registeredFactories.clear();
  cachedDescriptors = null;
}
