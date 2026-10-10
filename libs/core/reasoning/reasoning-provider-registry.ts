/**
 * Declarative reasoning-provider registry.
 *
 * The runtime still owns the construction of built-in adapters, but provider
 * identity, capability metadata, and the extension seam live here. This keeps
 * routing policy independent from the bootstrap switch and gives managed
 * packs a single, reversible registration point for provider modules.
 *
 * RS-01: the descriptor JSON under
 * `knowledge/product/governance/reasoning-providers/` is the single source of
 * truth for every per-provider table (capability profile, CLI binary/probe
 * args, sandbox probe args, managed install hints, model env keys, egress
 * endpoint/provider id, runtime instructions, discovery membership). Callers
 * derive those tables from this loader; they must not carry their own
 * provider list. A provider whose descriptor is incomplete fails closed at
 * load time with `[REASONING_PROVIDER_REGISTRY_INVALID] <mode>: <reason>`.
 */

import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import type { ReasoningBackendCandidate } from './reasoning-backend.js';
import type { IntentExtractorCandidate } from '../intent/intent-extractor.js';
import type { VoiceBridgeCandidate } from '../voice/voice-bridge.js';
import type {
  BackendDataEgress,
  BackendInputModality,
  BackendTransport,
  BackendUtilityFit,
  ThinkingLevel,
  ThinkingLevelMap,
} from '../backend-capability-profile.js';
import { pathResolver } from '../path-resolver.js';
import { loadRegistryDirectory, type RegistryDirectoryOptions } from '../registry-directory.js';
import { assertModuleInvariant } from '../invariants.js';
import { isRecord } from '../foundation/text.js';
import { resolveSecretIdentity } from '../secret/secret-identity.js';
import { getSecretForIdentity } from '../secret/secret-guard.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { createLogger } from '../logger.js';

const logger = createLogger('reasoning-provider-registry');

export interface ReasoningProviderCapabilities {
  reasoning: boolean;
  structured_output: boolean;
  abort: boolean;
  session_continuity: boolean;
  input_modalities: readonly BackendInputModality[];
}

/**
 * Billing shape of a completed request. 'free' = local runtime or flat-rate
 * subscription CLI (a revoked speculative request costs nothing extra);
 * 'metered' = per-token/per-request billing. Optional on the descriptor;
 * callers treat a missing value as 'metered' (fail closed on cost).
 */
export type ReasoningProviderCostTier = 'free' | 'metered';

/** Execution/readiness adapter ids. A new protocol adds one id here and in the schema. */
export const REASONING_PROVIDER_ADAPTERS = [
  'claude-cli',
  'claude-agent-sdk',
  'provider-cli',
  'anthropic-api',
  'gemini-api',
  'grok-api',
  'openrouter-api',
  'openai-compatible',
  'stub',
] as const;
export type ReasoningProviderAdapterId = (typeof REASONING_PROVIDER_ADAPTERS)[number];

const TRANSPORTS: readonly BackendTransport[] = ['cli', 'sdk', 'api', 'local-server', 'in-process'];
const DATA_EGRESS: readonly BackendDataEgress[] = ['local-only', 'external-api'];
const UTILITY_FITS: readonly BackendUtilityFit[] = ['judge', 'classify', 'summarize', 'divergent'];
const THINKING_LEVELS: readonly ThinkingLevel[] = ['low', 'medium', 'high'];

export interface ReasoningProviderProfile {
  streaming: boolean;
  tool_calling: boolean;
  native_subagent: boolean;
  thinking_levels: ThinkingLevelMap;
  supports_strict_tools: boolean;
  supports_grammar_tools: boolean;
  utility_fit: readonly BackendUtilityFit[];
}

export interface ReasoningProviderCliSandbox {
  /** Argument template; `{prompt}` and `{permission_args}` are substituted. */
  args: readonly string[];
  prompt_via_stdin?: boolean;
  enforcement_preflight?: boolean;
}

export interface ReasoningProviderCliInstall {
  npm_package?: string;
  brew_formula?: string;
  hint: string;
}

/** XP-01 cheap capability probe declared per CLI descriptor (RS follow-up b). */
export interface ReasoningProviderCliCapabilityProbe {
  binary_args: readonly string[];
  auth_args?: readonly string[];
  /** Named auth-result interpreter; default is exit-status success. */
  auth_interpreter?: 'claude-auth-status';
  /** Named placeholder-shim detector + fallback binary resolver. */
  placeholder_fallback?: 'claude-cli-shim';
  headless: boolean;
  structured_output: boolean;
  sandbox_flags?: { args: readonly string[]; expected_flags: readonly string[] };
}

export type ReasoningProviderPermissionTier = 'implementer' | 'explorer' | 'planner';

/** XP-02 tier projection: an explicit grant (`args`) or an explicit refusal. */
export type ReasoningProviderPermissionProjection =
  | { args: readonly string[]; notes?: string; requires_full_sandbox_enforcement?: boolean }
  | { refused: string };

/** An environment variable the CLI harness sets in every child it spawns (agent-session detection). */
export interface ReasoningProviderCliSessionMarker {
  env: string;
  /** Match only this value (case-insensitive); any non-empty value otherwise. */
  equals?: string;
}

export interface ReasoningProviderCli {
  binary: string;
  version_args: readonly string[];
  help_args?: readonly string[];
  bin_env_key?: string;
  discovery: boolean;
  model_flag?: string;
  sandbox?: ReasoningProviderCliSandbox;
  install?: ReasoningProviderCliInstall;
  capability_probe?: ReasoningProviderCliCapabilityProbe;
  permission_profiles?: Partial<
    Record<ReasoningProviderPermissionTier, ReasoningProviderPermissionProjection>
  >;
  /** Env markers that show a process runs inside this CLI's agent session. */
  session_markers?: readonly ReasoningProviderCliSessionMarker[];
  /** Principal name recorded as `agent:<name>` for such a session (default: the mode). */
  session_principal?: string;
}

export interface ReasoningProviderDescriptor {
  mode: ReasoningBackendMode;
  provider: string;
  module: string;
  capabilities: ReasoningProviderCapabilities;
  env_keys: string[];
  secret_refs?: readonly ReasoningProviderSecretRef[];
  cost_tier?: ReasoningProviderCostTier;
  transport: BackendTransport;
  data_egress: BackendDataEgress;
  adapter: ReasoningProviderAdapterId;
  openai_compatible_preset?: string;
  profile: ReasoningProviderProfile;
  aliases?: readonly string[];
  model_vendor?: string;
  endpoint?: string;
  egress_provider_id?: string;
  model_env_keys?: readonly string[];
  setup_hint?: string;
  runtime_instructions?: readonly string[];
  cli?: ReasoningProviderCli;
}

export interface ReasoningProviderSecretRef {
  service_id: string;
  secret_key: string;
  env_keys: readonly string[];
}

export interface ReasoningProviderRuntimeBundle {
  mode: ReasoningBackendMode;
  backend: ReasoningBackendCandidate;
  intentExtractor?: IntentExtractorCandidate;
  voiceBridge?: VoiceBridgeCandidate;
}

export type ReasoningProviderConformanceStatus = 'verified' | 'declared' | 'unavailable' | 'failed';

export interface ReasoningProviderConformanceCheck {
  name:
    | 'prompt'
    | 'structured_output'
    | 'abort'
    | 'failover'
    | 'egress_scope'
    | 'usage'
    | 'sandbox_enforcement';
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

const REGISTRY_DIR = pathResolver.knowledge('product/governance/reasoning-providers');
const REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/reasoning-provider-registry.schema.json'
);

/** Mode / alias / id slug. Any governed JSON mode matching it is accepted — no TS allowlist. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const CLI_BINARY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ENDPOINT_PATTERN = /^https:\/\/[a-z0-9.-]+$/u;

const INPUT_MODALITIES = new Set<BackendInputModality>(['text', 'image', 'audio']);

const reasoningProviderDirectoryOptions: RegistryDirectoryOptions = {
  id: 'reasoning-provider-registry',
  dirPath: REGISTRY_DIR,
  schemaPath: REGISTRY_SCHEMA_PATH,
  arrayKey: 'providers',
  idKey: 'mode',
  envDirVar: 'KYBERION_REASONING_PROVIDER_REGISTRY_DIR',
  envPathVar: 'KYBERION_REASONING_PROVIDER_REGISTRY_PATH',
};

/**
 * Registry overrides (`KYBERION_REASONING_PROVIDER_REGISTRY_DIR` / `_PATH`)
 * are a hermetic-test / development seam. A production runtime
 * (`NODE_ENV=production`) ignores them and always loads the committed
 * descriptors, so an env var cannot swap provider endpoints or egress
 * classification under a deployed runtime.
 */
export function reasoningProviderRegistryOverridesAllowed(): boolean {
  return getRegisteredEnvText('NODE_ENV')?.trim().toLowerCase() !== 'production';
}

function effectiveReasoningProviderDirectoryOptions(): RegistryDirectoryOptions {
  if (reasoningProviderRegistryOverridesAllowed()) return reasoningProviderDirectoryOptions;
  const ignored = [
    reasoningProviderDirectoryOptions.envDirVar,
    reasoningProviderDirectoryOptions.envPathVar,
  ].filter((name): name is string => Boolean(name && getRegisteredEnvText(name)?.trim()));
  if (ignored.length > 0) {
    logger.warn(
      `reasoning provider registry override ignored — ${ignored.join(', ')} not honoured when NODE_ENV=production | unset it; edit knowledge/product/governance/reasoning-providers/ instead | ${REGISTRY_DIR}`
    );
  }
  const {
    envDirVar: _envDirVar,
    envPathVar: _envPathVar,
    ...committedOnly
  } = reasoningProviderDirectoryOptions;
  return committedOnly;
}

/**
 * Loopback or private-network host (RFC 1918, IPv6 ULA, localhost). Used to
 * keep a descriptor's declared `data_egress` consistent with its endpoint.
 */
export function isLocalReasoningEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase().replace(/^\[(.*)\]$/u, '$1');
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '0.0.0.0' ||
      hostname === '::' ||
      hostname === '::1' ||
      /^127\./u.test(hostname) ||
      /^10\./u.test(hostname) ||
      /^192\.168\./u.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./u.test(hostname) ||
      /^fd[0-9a-f]{2}:/u.test(hostname)
    );
  } catch {
    return false;
  }
}

let cachedDescriptors: readonly ReasoningProviderDescriptor[] | null = null;
const registeredFactories = new Map<ReasoningBackendMode, ReasoningProviderFactory>();
const CONFORMANCE_CHECK_NAMES = [
  'prompt',
  'structured_output',
  'abort',
  'failover',
  'egress_scope',
  'usage',
  'sandbox_enforcement',
] as const;
const CONFORMANCE_STATUSES = ['verified', 'declared', 'unavailable', 'failed'] as const;

function isInputModality(value: unknown): value is BackendInputModality {
  return typeof value === 'string' && INPUT_MODALITIES.has(value as BackendInputModality);
}

function isReasoningProviderCostTier(value: unknown): value is ReasoningProviderCostTier {
  return value === 'free' || value === 'metered';
}

function parseInputModalities(
  rawCapabilities: Record<string, unknown>
): readonly BackendInputModality[] | null {
  if (
    !Array.isArray(rawCapabilities.input_modalities) ||
    !rawCapabilities.input_modalities.every(isInputModality)
  ) {
    return null;
  }
  const modalities = rawCapabilities.input_modalities as BackendInputModality[];
  return modalities.includes('text') ? modalities : null;
}

type ParseResult = { descriptor: ReasoningProviderDescriptor } | { reason: string };

function isStringArray(value: unknown, pattern?: RegExp): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'string' && entry.trim().length > 0 && (!pattern || pattern.test(entry))
    )
  );
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  pattern?: RegExp
): { ok: true; value?: string } | { ok: false } {
  const value = raw[key];
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) {
    return { ok: false };
  }
  return { ok: true, value: value.trim() };
}

function parseProfile(value: unknown): ReasoningProviderProfile | string {
  if (!isRecord(value)) return 'profile is missing';
  const booleans = [
    'streaming',
    'tool_calling',
    'native_subagent',
    'supports_strict_tools',
    'supports_grammar_tools',
  ] as const;
  for (const key of booleans) {
    if (typeof value[key] !== 'boolean') return `profile.${key} must be a boolean`;
  }
  const levels = value.thinking_levels;
  if (!isRecord(levels)) return 'profile.thinking_levels must be an object';
  const thinkingLevels: ThinkingLevelMap = {};
  for (const [level, wire] of Object.entries(levels)) {
    if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
      return `profile.thinking_levels has unknown level ${level}`;
    }
    if (wire !== null && typeof wire !== 'string') {
      return `profile.thinking_levels.${level} must be a string or null`;
    }
    thinkingLevels[level as ThinkingLevel] = wire as string | null;
  }
  if (
    !Array.isArray(value.utility_fit) ||
    !value.utility_fit.every((fit) => UTILITY_FITS.includes(fit as BackendUtilityFit))
  ) {
    return 'profile.utility_fit must list known utility fits';
  }
  return {
    streaming: value.streaming as boolean,
    tool_calling: value.tool_calling as boolean,
    native_subagent: value.native_subagent as boolean,
    thinking_levels: thinkingLevels,
    supports_strict_tools: value.supports_strict_tools as boolean,
    supports_grammar_tools: value.supports_grammar_tools as boolean,
    utility_fit: [...(value.utility_fit as BackendUtilityFit[])],
  };
}

function parseCli(value: unknown): ReasoningProviderCli | string {
  if (!isRecord(value)) return 'cli block is missing';
  if (typeof value.binary !== 'string' || !CLI_BINARY_PATTERN.test(value.binary)) {
    return 'cli.binary must be a bare executable name';
  }
  if (!isStringArray(value.version_args)) return 'cli.version_args must be a string array';
  if (value.help_args !== undefined && !isStringArray(value.help_args)) {
    return 'cli.help_args must be a string array';
  }
  if (typeof value.discovery !== 'boolean') return 'cli.discovery must be a boolean';
  const binEnvKey = optionalString(value, 'bin_env_key', ENV_KEY_PATTERN);
  if (!binEnvKey.ok) return 'cli.bin_env_key must be an env var name';
  const modelFlag = optionalString(value, 'model_flag', /^--?[a-z][a-z0-9-]*$/u);
  if (!modelFlag.ok) return 'cli.model_flag must be a flag';
  let sandbox: ReasoningProviderCliSandbox | undefined;
  if (value.sandbox !== undefined) {
    const raw = value.sandbox;
    if (
      !isRecord(raw) ||
      !Array.isArray(raw.args) ||
      !raw.args.every((a) => typeof a === 'string')
    ) {
      return 'cli.sandbox.args must be a string array';
    }
    if (raw.prompt_via_stdin !== undefined && typeof raw.prompt_via_stdin !== 'boolean') {
      return 'cli.sandbox.prompt_via_stdin must be a boolean';
    }
    if (raw.enforcement_preflight !== undefined && typeof raw.enforcement_preflight !== 'boolean') {
      return 'cli.sandbox.enforcement_preflight must be a boolean';
    }
    sandbox = {
      args: [...(raw.args as string[])],
      ...(raw.prompt_via_stdin === true ? { prompt_via_stdin: true } : {}),
      ...(raw.enforcement_preflight === true ? { enforcement_preflight: true } : {}),
    };
  }
  let install: ReasoningProviderCliInstall | undefined;
  if (value.install !== undefined) {
    const raw = value.install;
    if (!isRecord(raw) || typeof raw.hint !== 'string' || !raw.hint.trim()) {
      return 'cli.install.hint is required';
    }
    const npm = optionalString(raw, 'npm_package');
    const brew = optionalString(raw, 'brew_formula');
    if (!npm.ok || !brew.ok) return 'cli.install package names must be non-empty strings';
    install = {
      ...(npm.value ? { npm_package: npm.value } : {}),
      ...(brew.value ? { brew_formula: brew.value } : {}),
      hint: raw.hint.trim(),
    };
  }
  let capabilityProbe: ReasoningProviderCliCapabilityProbe | undefined;
  if (value.capability_probe !== undefined) {
    const raw = value.capability_probe;
    if (!isRecord(raw) || !isStringArray(raw.binary_args)) {
      return 'cli.capability_probe.binary_args must be a string array';
    }
    if (raw.auth_args !== undefined && !isStringArray(raw.auth_args)) {
      return 'cli.capability_probe.auth_args must be a string array';
    }
    if (typeof raw.headless !== 'boolean' || typeof raw.structured_output !== 'boolean') {
      return 'cli.capability_probe.headless/structured_output must be booleans';
    }
    if (raw.auth_interpreter !== undefined && raw.auth_interpreter !== 'claude-auth-status') {
      return 'cli.capability_probe.auth_interpreter is not a registered interpreter';
    }
    if (raw.placeholder_fallback !== undefined && raw.placeholder_fallback !== 'claude-cli-shim') {
      return 'cli.capability_probe.placeholder_fallback is not a registered fallback';
    }
    let sandboxFlags: ReasoningProviderCliCapabilityProbe['sandbox_flags'];
    if (raw.sandbox_flags !== undefined) {
      const flags = raw.sandbox_flags;
      if (
        !isRecord(flags) ||
        !isStringArray(flags.args) ||
        !isStringArray(flags.expected_flags) ||
        flags.expected_flags.length === 0
      ) {
        return 'cli.capability_probe.sandbox_flags needs args and expected_flags';
      }
      sandboxFlags = { args: [...flags.args], expected_flags: [...flags.expected_flags] };
    }
    capabilityProbe = {
      binary_args: [...raw.binary_args],
      ...(raw.auth_args ? { auth_args: [...(raw.auth_args as string[])] } : {}),
      ...(raw.auth_interpreter ? { auth_interpreter: 'claude-auth-status' as const } : {}),
      ...(raw.placeholder_fallback ? { placeholder_fallback: 'claude-cli-shim' as const } : {}),
      headless: raw.headless,
      structured_output: raw.structured_output,
      ...(sandboxFlags ? { sandbox_flags: sandboxFlags } : {}),
    };
  }
  let permissionProfiles: ReasoningProviderCli['permission_profiles'];
  if (value.permission_profiles !== undefined) {
    const raw = value.permission_profiles;
    if (!isRecord(raw)) return 'cli.permission_profiles must be an object';
    permissionProfiles = {};
    for (const [tier, entry] of Object.entries(raw)) {
      if (tier !== 'implementer' && tier !== 'explorer' && tier !== 'planner') {
        return `cli.permission_profiles.${tier} is not a KD-05 tier`;
      }
      if (!isRecord(entry)) return `cli.permission_profiles.${tier} must be an object`;
      if (typeof entry.refused === 'string' && entry.refused.trim()) {
        if (entry.args !== undefined) {
          return `cli.permission_profiles.${tier} cannot both grant and refuse`;
        }
        permissionProfiles[tier] = { refused: entry.refused };
        continue;
      }
      if (!Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === 'string')) {
        return `cli.permission_profiles.${tier} needs args or refused`;
      }
      permissionProfiles[tier] = {
        args: [...(entry.args as string[])],
        ...(typeof entry.notes === 'string' ? { notes: entry.notes } : {}),
        ...(entry.requires_full_sandbox_enforcement === true
          ? { requires_full_sandbox_enforcement: true }
          : {}),
      };
    }
  }
  let sessionMarkers: ReasoningProviderCliSessionMarker[] | undefined;
  if (value.session_markers !== undefined) {
    const raw = value.session_markers;
    if (!Array.isArray(raw)) return 'cli.session_markers must be an array';
    sessionMarkers = [];
    for (const entry of raw) {
      if (!isRecord(entry) || typeof entry.env !== 'string' || !ENV_KEY_PATTERN.test(entry.env)) {
        return 'cli.session_markers[].env must be an env var name';
      }
      if (entry.equals !== undefined && (typeof entry.equals !== 'string' || !entry.equals)) {
        return 'cli.session_markers[].equals must be a non-empty string';
      }
      sessionMarkers.push({
        env: entry.env,
        ...(typeof entry.equals === 'string' ? { equals: entry.equals } : {}),
      });
    }
  }
  const sessionPrincipal = optionalString(value, 'session_principal', /^[a-z0-9][a-z0-9-]*$/u);
  if (!sessionPrincipal.ok) return 'cli.session_principal must be a lowercase name';
  return {
    binary: value.binary,
    version_args: [...value.version_args],
    ...(value.help_args ? { help_args: [...(value.help_args as string[])] } : {}),
    ...(binEnvKey.value ? { bin_env_key: binEnvKey.value } : {}),
    discovery: value.discovery,
    ...(modelFlag.value ? { model_flag: modelFlag.value } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(install ? { install } : {}),
    ...(capabilityProbe ? { capability_probe: capabilityProbe } : {}),
    ...(permissionProfiles ? { permission_profiles: permissionProfiles } : {}),
    ...(sessionMarkers ? { session_markers: sessionMarkers } : {}),
    ...(sessionPrincipal.value ? { session_principal: sessionPrincipal.value } : {}),
  };
}

/**
 * Validate one descriptor and explain the first problem. The reason is
 * operator-visible (load errors, the fixture contract test), so a provider
 * that is unknown or incomplete fails closed with a concrete next step.
 */
export function explainReasoningProviderDescriptor(value: unknown): ParseResult {
  if (!isRecord(value)) return { reason: 'descriptor is not an object' };
  if (typeof value.mode !== 'string' || !PROVIDER_ID_PATTERN.test(value.mode)) {
    return { reason: 'mode must be a lowercase slug' };
  }
  if (
    typeof value.provider !== 'string' ||
    !value.provider.trim() ||
    typeof value.module !== 'string' ||
    !value.module.trim() ||
    !isRecord(value.capabilities) ||
    !Array.isArray(value.env_keys) ||
    value.env_keys.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    return { reason: 'provider, module, capabilities and env_keys are required' };
  }
  const rawCapabilities = value.capabilities;
  const reasoning = rawCapabilities.reasoning;
  const structuredOutput = rawCapabilities.structured_output;
  const abort = rawCapabilities.abort;
  const sessionContinuity = rawCapabilities.session_continuity;
  const requiredBooleanCapabilities = [reasoning, structuredOutput, abort, sessionContinuity];
  if (requiredBooleanCapabilities.some((entry) => typeof entry !== 'boolean')) {
    return {
      reason: 'capabilities must declare reasoning/structured_output/abort/session_continuity',
    };
  }
  const inputModalities = parseInputModalities(rawCapabilities);
  if (!inputModalities) return { reason: 'capabilities.input_modalities must include text' };
  const rawCostTier = value.cost_tier;
  if (rawCostTier !== undefined && !isReasoningProviderCostTier(rawCostTier)) {
    return { reason: 'cost_tier must be free or metered' };
  }
  const costTier = isReasoningProviderCostTier(rawCostTier) ? rawCostTier : undefined;
  if (!TRANSPORTS.includes(value.transport as BackendTransport)) {
    return { reason: `transport must be one of ${TRANSPORTS.join(', ')}` };
  }
  if (!DATA_EGRESS.includes(value.data_egress as BackendDataEgress)) {
    return { reason: `data_egress must be one of ${DATA_EGRESS.join(', ')}` };
  }
  if (!REASONING_PROVIDER_ADAPTERS.includes(value.adapter as ReasoningProviderAdapterId)) {
    return {
      reason: `adapter must be one of ${REASONING_PROVIDER_ADAPTERS.join(', ')} (a new protocol needs a new adapter)`,
    };
  }
  const transport = value.transport as BackendTransport;
  const adapter = value.adapter as ReasoningProviderAdapterId;
  const preset = optionalString(value, 'openai_compatible_preset', PROVIDER_ID_PATTERN);
  if (!preset.ok) return { reason: 'openai_compatible_preset must be a slug' };
  if (adapter === 'openai-compatible' && !preset.value) {
    return { reason: 'openai-compatible adapter requires openai_compatible_preset' };
  }
  const profile = parseProfile(value.profile);
  if (typeof profile === 'string') return { reason: profile };
  let cli: ReasoningProviderCli | undefined;
  if (value.cli !== undefined || transport === 'cli' || adapter === 'provider-cli') {
    const parsedCli = parseCli(value.cli);
    if (typeof parsedCli === 'string') return { reason: parsedCli };
    cli = parsedCli;
  }
  if (value.aliases !== undefined && !isStringArray(value.aliases, PROVIDER_ID_PATTERN)) {
    return { reason: 'aliases must be lowercase slugs' };
  }
  const modelVendor = optionalString(value, 'model_vendor', PROVIDER_ID_PATTERN);
  const endpoint = optionalString(value, 'endpoint', ENDPOINT_PATTERN);
  const egressProviderId = optionalString(value, 'egress_provider_id', PROVIDER_ID_PATTERN);
  const setupHint = optionalString(value, 'setup_hint');
  if (!modelVendor.ok) return { reason: 'model_vendor must be a slug' };
  if (!endpoint.ok) return { reason: 'endpoint must be an https origin' };
  if (!egressProviderId.ok) return { reason: 'egress_provider_id must be a slug' };
  if (!setupHint.ok) return { reason: 'setup_hint must be a non-empty string' };
  if (endpoint.value) {
    const localEndpoint = isLocalReasoningEndpoint(endpoint.value);
    if (value.data_egress === 'local-only' && !localEndpoint) {
      return {
        reason: `data_egress local-only requires a loopback/private endpoint (got ${endpoint.value}); declare external-api or point endpoint at a local host`,
      };
    }
    if (value.data_egress === 'external-api' && localEndpoint) {
      return {
        reason: `data_egress external-api must not use a loopback/private endpoint (got ${endpoint.value}); declare local-only instead`,
      };
    }
  }
  if (value.model_env_keys !== undefined && !isStringArray(value.model_env_keys, ENV_KEY_PATTERN)) {
    return { reason: 'model_env_keys must be env var names' };
  }
  let secretRefs: ReasoningProviderSecretRef[] | undefined;
  if (value.secret_refs !== undefined) {
    if (!Array.isArray(value.secret_refs)) return { reason: 'secret_refs must be an array' };
    secretRefs = [];
    for (const [index, entry] of value.secret_refs.entries()) {
      if (
        !isRecord(entry) ||
        typeof entry.service_id !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(entry.service_id) ||
        typeof entry.secret_key !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,63}$/u.test(entry.secret_key) ||
        !isStringArray(entry.env_keys, ENV_KEY_PATTERN) ||
        entry.env_keys.length === 0
      ) {
        return { reason: `secret_refs[${index}] needs service_id, secret_key, and env_keys` };
      }
      secretRefs.push({
        service_id: entry.service_id,
        secret_key: entry.secret_key,
        env_keys: [...entry.env_keys],
      });
    }
  }
  if (value.runtime_instructions !== undefined && !isStringArray(value.runtime_instructions)) {
    return { reason: 'runtime_instructions must be non-empty strings' };
  }
  const descriptor: ReasoningProviderDescriptor = {
    mode: value.mode as ReasoningBackendMode,
    provider: value.provider.trim(),
    module: value.module.trim(),
    capabilities: {
      reasoning: reasoning as boolean,
      structured_output: structuredOutput as boolean,
      abort: abort as boolean,
      session_continuity: sessionContinuity as boolean,
      input_modalities: inputModalities,
    },
    env_keys: value.env_keys.map((entry) => entry.trim()),
    ...(secretRefs ? { secret_refs: secretRefs } : {}),
    ...(costTier !== undefined ? { cost_tier: costTier } : {}),
    transport,
    data_egress: value.data_egress as BackendDataEgress,
    adapter,
    ...(preset.value ? { openai_compatible_preset: preset.value } : {}),
    profile,
    ...(value.aliases ? { aliases: [...(value.aliases as string[])] } : {}),
    ...(modelVendor.value ? { model_vendor: modelVendor.value } : {}),
    ...(endpoint.value ? { endpoint: endpoint.value } : {}),
    ...(egressProviderId.value ? { egress_provider_id: egressProviderId.value } : {}),
    ...(value.model_env_keys ? { model_env_keys: [...(value.model_env_keys as string[])] } : {}),
    ...(setupHint.value ? { setup_hint: setupHint.value } : {}),
    ...(value.runtime_instructions
      ? { runtime_instructions: [...(value.runtime_instructions as string[])] }
      : {}),
    ...(cli ? { cli } : {}),
  };
  // The prompt-reconstruction invariant is documented until PI-05 supplies
  // the durable request log; descriptor validation remains runtime-owned.
  assertModuleInvariant('reasoning-provider-registry', 'prompt-reconstruction', descriptor);
  return { descriptor };
}

export function parseReasoningProviderDescriptor(
  value: unknown
): ReasoningProviderDescriptor | null {
  const result = explainReasoningProviderDescriptor(value);
  return 'descriptor' in result ? result.descriptor : null;
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
      !check.evidence.trim() ||
      seen.has(check.name)
    ) {
      throw new Error(`[REASONING_PROVIDER_CONFORMANCE_INVALID] ${mode}`);
    }
    seen.add(check.name);
  }
  if (
    seen.size !== CONFORMANCE_CHECK_NAMES.length ||
    !evidence.passed ||
    evidence.checks.some((check) => check.status === 'failed')
  ) {
    throw new Error(`[REASONING_PROVIDER_CONFORMANCE_FAILED] ${mode}`);
  }
  const requiredLiveChecks = new Set([
    'prompt',
    'structured_output',
    'abort',
    'failover',
    'egress_scope',
  ]);
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
  const { items } = loadRegistryDirectory<Record<string, unknown>>(
    effectiveReasoningProviderDirectoryOptions()
  );
  const descriptors = items.map((entry, index) => {
    const result = explainReasoningProviderDescriptor(entry);
    if ('reason' in result) {
      const label =
        isRecord(entry) && typeof entry.mode === 'string' ? entry.mode : `entry ${index}`;
      throw new Error(
        `[REASONING_PROVIDER_REGISTRY_INVALID] ${label}: ${result.reason} — fix knowledge/product/governance/reasoning-providers/${label}.json (schema: reasoning-provider-registry.schema.json)`
      );
    }
    return result.descriptor;
  });
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    for (const id of [descriptor.mode, ...(descriptor.aliases ?? [])]) {
      if (seen.has(id)) {
        throw new Error(`Duplicate reasoning provider mode or alias: ${id}`);
      }
      seen.add(id);
    }
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

/**
 * Resolve only the secret references declared for a provider. Explicit
 * environment values take precedence; secret-store values are considered
 * only for the live process environment, never for caller-supplied fixtures.
 */
export function resolveReasoningProviderEnvironment(
  descriptor: ReasoningProviderDescriptor,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (env !== process.env || !descriptor.secret_refs?.length) return env;
  let resolved: NodeJS.ProcessEnv | undefined;
  for (const reference of descriptor.secret_refs) {
    const target = resolved ?? env;
    if (reference.env_keys.some((name) => getRegisteredEnvText(name, { env: target })?.trim())) {
      continue;
    }
    const identity = resolveSecretIdentity(reference.service_id, reference.secret_key);
    const value = getSecretForIdentity(identity, `reasoning.${descriptor.mode}`)?.trim();
    if (!value) continue;
    resolved ??= { ...env };
    for (const name of reference.env_keys) resolved[name] = value;
  }
  return resolved ?? env;
}

/** Secret-aware credential lookup for backend auto-selection policy rules. */
export function resolveReasoningProviderSecretEnvValue(
  envName: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const direct = getRegisteredEnvText(envName, { env })?.trim();
  if (direct || env !== process.env) return direct;
  for (const descriptor of listReasoningProviderDescriptors()) {
    if (!descriptor.secret_refs?.some((reference) => reference.env_keys.includes(envName)))
      continue;
    const resolved = resolveReasoningProviderEnvironment(descriptor, env);
    const value = getRegisteredEnvText(envName, { env: resolved })?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve any provider identifier — a mode (`codex-cli`), a runtime backend
 * name declared in `aliases` (`shell-claude-cli`), or a provider id (`codex`,
 * first descriptor in registry order) — to its governed descriptor.
 * Unknown identifiers resolve to `undefined`; callers fail closed.
 */
export function resolveReasoningProviderDescriptor(
  identifier: string | undefined | null
): ReasoningProviderDescriptor | undefined {
  const id = identifier?.trim().toLowerCase();
  if (!id) return undefined;
  const descriptors = listReasoningProviderDescriptors();
  return (
    descriptors.find((descriptor) => descriptor.mode === id) ??
    descriptors.find((descriptor) => descriptor.aliases?.includes(id)) ??
    descriptors.find((descriptor) => descriptor.provider === id)
  );
}

/** Descriptors whose adapter runs a local CLI binary (`cli` block present). */
export function listCliReasoningProviderDescriptors(): Array<
  ReasoningProviderDescriptor & { cli: ReasoningProviderCli }
> {
  return listReasoningProviderDescriptors().filter(
    (descriptor): descriptor is ReasoningProviderDescriptor & { cli: ReasoningProviderCli } =>
      Boolean(descriptor.cli)
  );
}

/** Model env override keys for a mode, highest precedence first (empty when none). */
export function reasoningProviderModelEnvKeys(mode: string): readonly string[] {
  return resolveReasoningProviderDescriptor(mode)?.model_env_keys ?? [];
}

/** Register a provider module for an existing governed mode. */
export function registerReasoningProvider(
  descriptor: ReasoningProviderDescriptor,
  factory: ReasoningProviderFactory,
  options: ReasoningProviderRegistrationOptions = {}
): () => void {
  const governedDescriptor = getReasoningProviderDescriptor(descriptor.mode);
  if (!governedDescriptor) {
    throw new Error(`Unknown reasoning provider mode: ${descriptor.mode}`);
  }
  if (registeredFactories.has(descriptor.mode)) {
    throw new Error(`Duplicate reasoning provider factory: ${descriptor.mode}`);
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

/**
 * Test seam: seed the descriptor cache from raw governed entries (validated
 * exactly like the loader does) for suites that mock path-resolver/secure-io
 * and therefore cannot read the registry directory.
 */
export function primeReasoningProviderRegistryForTests(entries: readonly unknown[]): void {
  cachedDescriptors = entries.map((entry, index) => {
    const result = explainReasoningProviderDescriptor(entry);
    if ('reason' in result) {
      throw new Error(`[REASONING_PROVIDER_REGISTRY_INVALID] entry ${index}: ${result.reason}`);
    }
    return result.descriptor;
  });
}
