import type { ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeLstat, safeWriteFile } from './secure-io.js';
import { compileSchema } from './foundation/ajv.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import { currentScope, type ScopeContext } from './scope-context.js';
import { getReasoningPayloadScope } from './reasoning-egress-scope.js';
import { loadModelRegistry } from './reasoning-model-routing.js';
import { loadLlmSelectionPreferences } from './llm-selection-state.js';
import {
  BACKEND_CAPABILITY_PROFILES,
  backendRouteCapabilities,
  backendCapabilityProfile,
  resolveConstrainedSampling,
  resolveThinkingLevel,
  type BackendCapabilityProfile,
  type BackendRouteCapability,
  type ConstrainedSampling,
  type ThinkingLevel,
} from './backend-capability-profile.js';

const POLICY_PATH = pathResolver.knowledge('product/governance/reasoning-route-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/reasoning-route-policy.schema.json');
const USER_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/reasoning-route-user-config.schema.json'
);
const USER_CONFIG_PATH = pathResolver.shared('state/reasoning-route-user-config.json');

export type ReasoningRole = string;
export type ReasoningCapability = BackendRouteCapability;
export type UnsupportedParameterPolicy = 'reject' | 'warn-and-drop' | 'translate';
export type ReasoningToolName = 'read_file' | 'write_file' | 'list_directory' | 'shell_exec';
export type SamplingParams = {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop?: string | string[];
};

export interface RuntimeAdapterConfig {
  adapter: string;
  selection?: {
    display_name: string;
    model_provider?: string;
    discovery_provider?: string;
    availability: {
      kind: 'always' | 'env_any' | 'provider_discovery';
      names?: string[];
    };
  };
  preset?: string;
  endpoint_policy?: 'local' | 'public';
  model_policy?: 'approved' | 'local-unregistered';
  capabilities: ReasoningCapability[];
  supported_parameters: string[];
  parameter_aliases?: Record<string, string>;
}
export interface RuntimeProfileConfig {
  mode: string;
  model?: string;
  model_ref?: string;
  capabilities?: ReasoningCapability[];
  tools_enabled?: boolean;
  allowed_tools?: ReasoningToolName[];
  context_window_tokens?: number;
  max_completion_tokens?: number;
  timeout_ms?: number;
  sampling?: SamplingParams;
}
export interface RoleRouteConfig {
  candidates: string[];
  requires?: ReasoningCapability[];
  sampling?: SamplingParams;
}
export interface ReasoningRouteBinding {
  profile?: string;
  mode?: string;
  provider?: string;
  model?: string;
  permission_mode?: 'readonly' | 'edit' | 'full';
  capability_profile?: string;
}
export interface ReasoningRouteRouting {
  steps?: Record<string, ReasoningRouteBinding>;
  tags?: Record<string, ReasoningRouteBinding>;
  personas?: Record<string, ReasoningRouteBinding>;
}
export interface ReasoningRoutePolicy {
  version: string;
  runtime_adapters: Record<string, RuntimeAdapterConfig>;
  profiles: Record<string, RuntimeProfileConfig>;
  roles: Record<string, RoleRouteConfig>;
  routing?: ReasoningRouteRouting;
  permission_floor?: 'readonly' | 'edit' | 'full';
  fallback: {
    max_attempts: number;
    max_in_place_retries: number;
    on_unsupported_parameter: UnsupportedParameterPolicy;
  };
  tenant_overrides?: Record<string, ReasoningRouteOverlay>;
  organization_overrides?: Record<string, ReasoningRouteOverlay>;
  project_overrides?: Record<string, ReasoningRouteOverlay>;
}

export interface ReasoningRouteOverlay {
  roles?: Record<string, Partial<RoleRouteConfig>>;
  profiles?: Record<string, Partial<RuntimeProfileConfig>>;
}
export interface ResolvedStepReasoningRoute {
  profile?: string;
  mode?: ReasoningBackendMode | string;
  model?: string;
  permission_mode: 'readonly' | 'edit' | 'full';
  capability_profile?: string;
  source:
    | 'env'
    | 'promotion'
    | 'step'
    | 'routing.step'
    | 'routing.tag'
    | 'routing.persona'
    | 'pipeline'
    | 'policy';
  provenance: string[];
}
export interface ReasoningRouteUserConfig {
  version?: string;
  revision?: number;
  updated_at?: string;
  last_change?: string;
  roles?: Record<string, { profile?: string; candidates?: string[]; sampling?: SamplingParams }>;
  profiles?: Record<string, Partial<RuntimeProfileConfig>>;
}
export interface ResolvedReasoningRoute {
  role: ReasoningRole;
  profileRef: string;
  mode: ReasoningBackendMode | string;
  model?: string;
  adapter: string;
  capabilities: ReasoningCapability[];
  toolsEnabled: boolean;
  allowedTools: ReasoningToolName[];
  parameters: SamplingParams;
  thinkingLevel?: { requested: ThinkingLevel; wireValue: string };
  constrainedSampling: ReturnType<typeof resolveConstrainedSampling>;
  limits: { contextWindowTokens?: number; maxCompletionTokens?: number; timeoutMs: number };
  candidates: string[];
  governance: { dataTier: string; egress: 'enforced'; spend: 'enforced' };
  provenance: Array<{ source: string; field: string }>;
  backendProfile?: Pick<BackendCapabilityProfile, 'transport' | 'capabilities' | 'utility_fit'>;
  rejectedCandidates: Array<{ profile: string; reason: string }>;
  failover: ReasoningRoutePolicy['fallback'];
}

let validateUserConfigFn: ValidateFunction | null = null;
const reasoningRoutePolicyCatalog = defineCatalog<ReasoningRoutePolicy>({
  id: 'reasoning-route-policy',
  path: POLICY_PATH,
  schema: SCHEMA_PATH,
});
const reasoningRouteUserConfigCatalog = defineCatalog<ReasoningRouteUserConfig>({
  id: 'reasoning-route-user-config',
  path: USER_CONFIG_PATH,
  schema: USER_SCHEMA_PATH,
  fallback: {},
});

export function loadReasoningRoutePolicy(): ReasoningRoutePolicy {
  return reasoningRoutePolicyCatalog.load();
}

export function loadReasoningRouteUserConfig(): ReasoningRouteUserConfig {
  return reasoningRouteUserConfigCatalog.load();
}

/** Load a persisted user-config snapshot through the same schema/path boundary. */
export function loadReasoningRouteUserConfigAtPath(filePath: string): ReasoningRouteUserConfig {
  const safePath = assertSafeRepositoryPath(filePath);
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`Reasoning route user config must be a regular file: ${safePath}`);
  }
  return defineCatalog<ReasoningRouteUserConfig>({
    id: 'reasoning-route-user-config',
    path: safePath,
    schema: USER_SCHEMA_PATH,
  }).load();
}

export function validateReasoningRouteUserConfig(
  value: unknown,
  label = USER_CONFIG_PATH
): ReasoningRouteUserConfig {
  if (!validateUserConfigFn) validateUserConfigFn = compileSchema(USER_SCHEMA_PATH);
  if (!validateUserConfigFn(value)) {
    const errors = (validateUserConfigFn.errors || []).map(
      (error) => `${error.instancePath || '/'} ${error.message || 'invalid'}`
    );
    throw new Error(`Invalid reasoning route user config at ${label}: ${errors.join('; ')}`);
  }
  return value as ReasoningRouteUserConfig;
}

export function reasoningRouteUserConfigPath(): string {
  return USER_CONFIG_PATH;
}

export function saveReasoningRouteUserConfig(config: ReasoningRouteUserConfig): void {
  validateReasoningRouteUserConfig(config);
  const policy = loadReasoningRoutePolicy();
  for (const role of Object.keys(config.roles || {})) {
    if (!policy.roles[role]) throw new Error(`Unknown role in user config: ${role}`);
    const roleConfig = config.roles?.[role];
    const refs = roleConfig?.profile ? [roleConfig.profile] : roleConfig?.candidates || [];
    for (const ref of refs) {
      if (!policy.profiles[ref] && !config.profiles?.[ref])
        throw new Error(`Unknown profile in user config: ${ref}`);
    }
  }
  safeWriteFile(USER_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', {
    mkdir: true,
    encoding: 'utf8',
  });
}

export function normalizeReasoningRole(
  value?: string,
  policy?: ReasoningRoutePolicy
): ReasoningRole {
  const normalized = String(value || 'default')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  const roles = Object.keys((policy ?? loadReasoningRoutePolicy()).roles);
  if (roles.includes(normalized)) return normalized;
  throw new Error(`Unknown reasoning role "${value}". Allowed roles: ${roles.join(', ')}`);
}

function envText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return getRegisteredEnvText(name, { env });
}

function mergeSampling(...values: Array<SamplingParams | undefined>): SamplingParams {
  const result: SamplingParams = {};
  for (const value of values) if (value) Object.assign(result, value);
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error(`Invalid sampling parameter ${key}`);
  }
  return result;
}

function requestedBinding(role: ReasoningRole, env: NodeJS.ProcessEnv): string | undefined {
  const key = `KYBERION_REASONING_ROLE_${role.toUpperCase()}`;
  return envText(env, key)?.trim() || envText(env, 'KYBERION_REASONING_PROFILE')?.trim();
}

function loadOperatorLlmSelection(): { provider: string; model_id?: string } | null {
  const value = loadLlmSelectionPreferences();
  if (!value) return null;
  return {
    provider: value.provider,
    model_id: value.model_id,
  };
}

function parseBinding(binding: string): { profile?: string; mode?: string; model?: string } {
  if (binding.startsWith('profile:')) return { profile: binding.slice('profile:'.length).trim() };
  const separator = binding.indexOf(':');
  if (separator > 0)
    return { mode: binding.slice(0, separator), model: binding.slice(separator + 1) };
  return { profile: binding };
}

function modelFromRuntimeEnv(mode: string, env: NodeJS.ProcessEnv): string | undefined {
  const keys: Record<string, string[]> = {
    anthropic: ['KYBERION_ANTHROPIC_MODEL', 'KYBERION_CLAUDE_MODEL'],
    'gemini-api': ['KYBERION_GEMINI_MODEL'],
    'grok-api': ['KYBERION_GROK_API_MODEL'],
    'grok-cli': ['KYBERION_GROK_CLI_MODEL'],
    'cursor-cli': ['KYBERION_CURSOR_CLI_MODEL'],
    openrouter: ['KYBERION_OPENROUTER_MODEL'],
    'nemotron-api': ['KYBERION_NEMOTRON_MODEL'],
    ollama: ['KYBERION_OLLAMA_MODEL', 'OLLAMA_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
    vllm: ['KYBERION_VLLM_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
    lmstudio: ['KYBERION_LMSTUDIO_MODEL', 'KYBERION_LM_STUDIO_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
    llamacpp: ['KYBERION_LLAMACPP_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
    mlx: ['KYBERION_MLX_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
    localai: ['KYBERION_LOCALAI_MODEL', 'KYBERION_LOCAL_LLM_MODEL'],
    local: ['KYBERION_LOCAL_LLM_MODEL'],
  };
  return [...(keys[mode] || []), 'KYBERION_REASONING_MODEL']
    .map((key) => envText(env, key)?.trim())
    .find(Boolean);
}

export function resolveSamplingParams(input: {
  mode: string;
  sampling?: SamplingParams;
  policy?: ReasoningRoutePolicy;
}): SamplingParams {
  const policy = input.policy ?? loadReasoningRoutePolicy();
  const adapter = policy.runtime_adapters[input.mode];
  if (!adapter) throw new Error(`Unknown reasoning runtime mode "${input.mode}"`);
  const result = mergeSampling(input.sampling);
  const unsupported = Object.keys(result).filter(
    (key) => !adapter.supported_parameters.includes(key)
  );
  if (unsupported.length > 0 && policy.fallback.on_unsupported_parameter === 'reject') {
    throw new Error(`Unsupported parameters for ${input.mode}: ${unsupported.join(', ')}`);
  }
  if (unsupported.length > 0 && policy.fallback.on_unsupported_parameter === 'warn-and-drop') {
    for (const key of unsupported) delete (result as Record<string, unknown>)[key];
  }
  if (unsupported.length > 0 && policy.fallback.on_unsupported_parameter === 'translate') {
    for (const key of unsupported) {
      const alias = adapter.parameter_aliases?.[key];
      if (!alias || !adapter.supported_parameters.includes(alias)) {
        throw new Error(`Unsupported parameters for ${input.mode}: ${key} has no safe translation`);
      }
      const value = (result as Record<string, unknown>)[key];
      delete (result as Record<string, unknown>)[key];
      (result as Record<string, unknown>)[alias] = value;
    }
  }
  return result;
}

function resolveAndValidateModel(input: {
  model?: string;
  modelRef?: string;
  adapter: RuntimeAdapterConfig;
  profile: string;
}): string | undefined {
  const model = input.model || input.modelRef;
  if (!model) return undefined;
  const registryModel =
    input.adapter.selection?.model_provider && !model.includes(':')
      ? `${input.adapter.selection.model_provider}:${model}`
      : model;
  const registered = loadModelRegistry().models.find((entry) => entry.model_id === registryModel);
  if (registered) {
    if (registered.status === 'blocked' || registered.status === 'deprecated') {
      throw new Error(
        `Model ${registryModel} is ${registered.status} and cannot be selected for ${input.profile}`
      );
    }
    return registryModel;
  }
  if (input.adapter.model_policy === 'local-unregistered') return model;
  throw new Error(`Model ${model} is not approved in model-registry.json for ${input.profile}`);
}

export function resolveReasoningRoute(
  input: {
    role?: string;
    requestedProfile?: string;
    requestedMode?: string;
    requestedModel?: string;
    requiredCapabilities?: ReasoningCapability[];
    sampling?: SamplingParams;
    thinkingLevel?: ThinkingLevel;
    constrainedSampling?: ConstrainedSampling;
    env?: NodeJS.ProcessEnv;
    policy?: ReasoningRoutePolicy;
    userConfig?: ReasoningRouteUserConfig;
    scope?: ScopeContext;
  } = {}
): ResolvedReasoningRoute {
  const policy = resolveScopedReasoningRoutePolicy(
    input.policy ?? loadReasoningRoutePolicy(),
    input.scope ?? currentScope()
  );
  const env = input.env ?? process.env;
  const role = normalizeReasoningRole(input.role, policy);
  const user = input.userConfig ?? loadReasoningRouteUserConfig();
  const roleUser = user.roles?.[role];
  const binding = input.requestedProfile || requestedBinding(role, env);
  const parsed = binding ? parseBinding(binding) : {};
  const rolePolicy = policy.roles[role] ?? policy.roles.default;
  const operatorSelection =
    role === 'default' &&
    !binding &&
    !input.requestedProfile &&
    !roleUser?.profile &&
    !roleUser?.candidates
      ? loadOperatorLlmSelection()
      : null;
  const selectedProfileRef = operatorSelection
    ? Object.entries(policy.profiles).find(
        ([, profile]) => profile.mode === operatorSelection.provider
      )?.[0]
    : undefined;
  const requestedProfileRef =
    parsed.profile || input.requestedProfile?.replace(/^profile:/, '') || roleUser?.profile;
  const configuredCandidates = requestedProfileRef
    ? [requestedProfileRef]
    : selectedProfileRef
      ? [
          selectedProfileRef,
          ...rolePolicy.candidates.filter((candidate) => candidate !== selectedProfileRef),
        ]
      : roleUser?.candidates || rolePolicy.candidates;
  const candidates = input.requestedMode
    ? configuredCandidates.filter(
        (profileRef) => policy.profiles[profileRef]?.mode === input.requestedMode
      )
    : configuredCandidates;
  const required = Array.from(
    new Set([...(rolePolicy.requires || []), ...(input.requiredCapabilities || [])])
  );
  const rejectedCandidates: Array<{ profile: string; reason: string }> = [];
  const provenance: Array<{ source: string; field: string }> = [
    { source: 'policy', field: `roles.${role}` },
  ];

  for (const profileRef of candidates) {
    const policyBase = policy.profiles[profileRef];
    const userProfile = user.profiles?.[profileRef];
    const base = policyBase ?? userProfile;
    const overlay = policyBase ? userProfile : undefined;
    if (!base) {
      rejectedCandidates.push({ profile: profileRef, reason: 'unknown profile' });
      continue;
    }
    const mode = parsed.mode || overlay?.mode || base.mode;
    const adapter = policy.runtime_adapters[mode];
    if (!adapter) {
      rejectedCandidates.push({ profile: profileRef, reason: `unknown mode ${mode}` });
      continue;
    }
    let model: string | undefined;
    try {
      model = resolveAndValidateModel({
        model:
          input.requestedModel ||
          parsed.model ||
          overlay?.model ||
          base.model ||
          (operatorSelection && mode === operatorSelection.provider
            ? operatorSelection.model_id
            : undefined) ||
          modelFromRuntimeEnv(mode, env),
        modelRef: overlay?.model_ref || base.model_ref,
        adapter,
        profile: profileRef,
      });
    } catch (error) {
      rejectedCandidates.push({
        profile: profileRef,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const toolsEnabled = overlay?.tools_enabled ?? base.tools_enabled ?? false;
    const allowedTools = toolsEnabled ? (overlay?.allowed_tools ?? base.allowed_tools ?? []) : [];
    if (
      allowedTools.includes('shell_exec') &&
      envText(env, 'KYBERION_REASONING_ALLOW_SHELL_TOOL') !== 'true'
    ) {
      rejectedCandidates.push({
        profile: profileRef,
        reason: 'shell_exec requires KYBERION_REASONING_ALLOW_SHELL_TOOL=true',
      });
      continue;
    }
    const capabilitySet = new Set([
      ...(adapter.capabilities || []),
      ...(base.capabilities || []),
      ...(overlay?.capabilities || []),
    ]);
    // The route policy describes what a profile requests; the backend profile
    // is the authoritative declaration of what the selected transport can
    // actually provide. Keep custom test/local policy modes valid while
    // applying the registry to every built-in mode.
    const baseBackendProfile = Object.prototype.hasOwnProperty.call(
      BACKEND_CAPABILITY_PROFILES,
      mode
    )
      ? backendCapabilityProfile(mode as ReasoningBackendMode)
      : undefined;
    const modelCompatibility = model
      ? loadModelRegistry().models.find((entry) => entry.model_id === model)?.compat
      : undefined;
    const backendProfile = baseBackendProfile
      ? {
          ...baseBackendProfile,
          capabilities: {
            ...baseBackendProfile.capabilities,
            ...(modelCompatibility
              ? {
                  thinkingLevelMap: {
                    ...baseBackendProfile.capabilities.thinkingLevelMap,
                    ...(modelCompatibility.thinkingLevelMap || {}),
                  },
                  ...(modelCompatibility.supportsStrictTools === undefined
                    ? {}
                    : { supportsStrictTools: modelCompatibility.supportsStrictTools }),
                  ...(modelCompatibility.supportsGrammarTools === undefined
                    ? {}
                    : { supportsGrammarTools: modelCompatibility.supportsGrammarTools }),
                }
              : {}),
          },
        }
      : undefined;
    if (backendProfile) {
      const supportedRouteCapabilities = new Set(backendRouteCapabilities(backendProfile));
      for (const capability of [
        'text',
        'structured_output',
        'tools',
        'vision',
        'streaming',
      ] as const) {
        if (!supportedRouteCapabilities.has(capability)) capabilitySet.delete(capability);
      }
      provenance.push({ source: 'backend-profile', field: `${mode}.capabilities` });
    }
    let resolvedThinkingLevel: { requested: ThinkingLevel; wireValue: string } | undefined;
    let constrainedSampling: ReturnType<typeof resolveConstrainedSampling> = {
      mode: 'disabled',
      reason: 'not-requested',
    };
    if (backendProfile) {
      const thinking = resolveThinkingLevel(backendProfile, input.thinkingLevel);
      if (!thinking.supported) {
        rejectedCandidates.push({
          profile: profileRef,
          reason: `thinking level ${input.thinkingLevel} is unavailable: ${thinking.reason}`,
        });
        continue;
      }
      if (input.thinkingLevel && thinking.wireValue) {
        resolvedThinkingLevel = {
          requested: input.thinkingLevel,
          wireValue: thinking.wireValue,
        };
      }
      try {
        constrainedSampling = resolveConstrainedSampling(input.constrainedSampling, {
          supportsStrictTools: backendProfile.capabilities.supportsStrictTools,
          supportsGrammarTools: backendProfile.capabilities.supportsGrammarTools,
        });
      } catch (error) {
        rejectedCandidates.push({
          profile: profileRef,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    if (!toolsEnabled || allowedTools.length === 0) capabilitySet.delete('tools');
    const capabilities = Array.from(capabilitySet);
    const missing = required.filter((capability) => !capabilities.includes(capability));
    if (missing.length > 0) {
      rejectedCandidates.push({
        profile: profileRef,
        reason: `missing capabilities: ${missing.join(', ')}`,
      });
      continue;
    }
    const sampling = resolveSamplingParams({
      mode,
      sampling: mergeSampling(
        base.sampling,
        rolePolicy.sampling,
        roleUser?.sampling,
        overlay?.sampling,
        input.sampling
      ),
      policy,
    });
    if (binding)
      provenance.push({
        source: 'override',
        field: input.requestedProfile ? 'request.profile' : `env/user.role.${role}`,
      });
    if (overlay) provenance.push({ source: 'user', field: `profiles.${profileRef}` });
    if (operatorSelection && mode === operatorSelection.provider) {
      provenance.push({ source: 'operator-selection', field: 'llm-selection.json' });
    }
    return {
      role,
      profileRef,
      mode: mode as ReasoningBackendMode,
      model,
      adapter: adapter.adapter,
      capabilities,
      toolsEnabled,
      allowedTools,
      parameters: sampling,
      ...(resolvedThinkingLevel ? { thinkingLevel: resolvedThinkingLevel } : {}),
      constrainedSampling,
      limits: {
        contextWindowTokens: overlay?.context_window_tokens ?? base.context_window_tokens,
        maxCompletionTokens: overlay?.max_completion_tokens ?? base.max_completion_tokens,
        timeoutMs: overlay?.timeout_ms ?? base.timeout_ms ?? 60000,
      },
      candidates,
      governance: {
        dataTier: getReasoningPayloadScope()?.tier || 'confidential',
        egress: 'enforced',
        spend: 'enforced',
      },
      provenance,
      ...(backendProfile
        ? {
            backendProfile: {
              transport: backendProfile.transport,
              capabilities: backendProfile.capabilities,
              utility_fit: backendProfile.utility_fit,
            },
          }
        : {}),
      rejectedCandidates,
      failover: policy.fallback,
    };
  }
  throw new Error(
    `No usable reasoning route for role ${role}. Rejected: ${rejectedCandidates.map((x) => `${x.profile} (${x.reason})`).join('; ')}`
  );
}

/** Apply tenant -> organization -> project overlays; the later layer is more specific. */
export function resolveScopedReasoningRoutePolicy(
  policy: ReasoningRoutePolicy,
  scope?: ScopeContext
): ReasoningRoutePolicy {
  const layers = [
    scope?.tenant_slug ? policy.tenant_overrides?.[scope.tenant_slug] : undefined,
    scope?.organization_id ? policy.organization_overrides?.[scope.organization_id] : undefined,
    scope?.project_id ? policy.project_overrides?.[scope.project_id] : undefined,
  ].filter(Boolean) as ReasoningRouteOverlay[];
  return layers.reduce<ReasoningRoutePolicy>((resolved, layer) => {
    const roles = { ...resolved.roles };
    for (const [role, overlay] of Object.entries(layer.roles || {})) {
      roles[role] = { ...(roles[role] || { candidates: [] }), ...overlay } as RoleRouteConfig;
    }
    const profiles = { ...resolved.profiles };
    for (const [profile, overlay] of Object.entries(layer.profiles || {})) {
      profiles[profile] = {
        ...(profiles[profile] || { mode: '' }),
        ...overlay,
      } as RuntimeProfileConfig;
    }
    return { ...resolved, roles, profiles };
  }, policy);
}

const PERMISSION_RANK: Record<'readonly' | 'edit' | 'full', number> = {
  readonly: 0,
  edit: 1,
  full: 2,
};

function modeForProvider(policy: ReasoningRoutePolicy, provider: string): string | undefined {
  const normalized = provider.trim().toLowerCase();
  return Object.values(policy.profiles).find((profile) => {
    if (profile.mode === normalized) return true;
    const modeProvider = profile.mode.split('-')[0];
    return modeProvider === normalized;
  })?.mode;
}

function profileForBinding(
  policy: ReasoningRoutePolicy,
  binding: ReasoningRouteBinding
): string | undefined {
  if (binding.profile) return binding.profile;
  const mode =
    binding.mode || (binding.provider ? modeForProvider(policy, binding.provider) : undefined);
  if (!mode) return undefined;
  return Object.entries(policy.profiles).find(([, profile]) => profile.mode === mode)?.[0];
}

/** Resolve Takt-style step routing onto Kyberion's governed profile resolver. */
export function resolveStepReasoningRoute(input: {
  stepId: string;
  step?: ReasoningRouteBinding & {
    tags?: string[];
    promotion?: Array<
      ReasoningRouteBinding & { after_failures?: number; after_iterations?: number }
    >;
  };
  tags?: string[];
  persona?: string;
  pipelineProfile?: string;
  failures?: number;
  iterations?: number;
  env?: NodeJS.ProcessEnv;
  policy?: ReasoningRoutePolicy;
}): ResolvedStepReasoningRoute {
  const policy = input.policy ?? loadReasoningRoutePolicy();
  const env = input.env ?? process.env;
  const floor = policy.permission_floor ?? 'readonly';
  const provenance: string[] = [];
  let binding: ReasoningRouteBinding | undefined;
  let source: ResolvedStepReasoningRoute['source'] = 'policy';

  const envBinding =
    envText(env, 'KYBERION_REASONING_PROFILE') || envText(env, 'KYBERION_REASONING_BACKEND');
  if (envBinding) {
    binding = envBinding.startsWith('profile:')
      ? { profile: envBinding.slice('profile:'.length) }
      : { mode: envBinding };
    source = 'env';
    provenance.push('env');
  }
  if (!binding && input.step?.promotion?.length) {
    const eligible = input.step.promotion.filter(
      (candidate) =>
        (candidate.after_failures === undefined ||
          (input.failures ?? 0) >= candidate.after_failures) &&
        (candidate.after_iterations === undefined ||
          (input.iterations ?? 0) >= candidate.after_iterations)
    );
    const promotion = eligible[eligible.length - 1];
    if (promotion) {
      binding = promotion;
      source = 'promotion';
      provenance.push(`promotion:${eligible.length}`);
    }
  }
  if (
    !binding &&
    input.step &&
    (input.step.profile ||
      input.step.mode ||
      input.step.provider ||
      input.step.model ||
      input.step.permission_mode)
  ) {
    binding = input.step;
    source = 'step';
    provenance.push('step');
  }
  if (!binding) {
    const routed = policy.routing?.steps?.[input.stepId];
    if (routed) {
      binding = routed;
      source = 'routing.step';
      provenance.push(`routing.steps.${input.stepId}`);
    }
  }
  if (!binding) {
    for (const tag of input.tags || input.step?.tags || []) {
      const routed = policy.routing?.tags?.[tag];
      if (routed) {
        binding = routed;
        source = 'routing.tag';
        provenance.push(`routing.tags.${tag}`);
        break;
      }
    }
  }
  if (!binding && input.persona && policy.routing?.personas?.[input.persona]) {
    binding = policy.routing.personas[input.persona];
    source = 'routing.persona';
    provenance.push(`routing.personas.${input.persona}`);
  }
  if (!binding && input.pipelineProfile) {
    binding = { profile: input.pipelineProfile };
    source = 'pipeline';
    provenance.push('pipeline');
  }

  const requestedPermission = binding?.permission_mode ?? 'readonly';
  if (PERMISSION_RANK[requestedPermission] < PERMISSION_RANK[floor]) {
    throw new Error(
      `[REASONING_PERMISSION_FLOOR] step=${input.stepId} requested=${requestedPermission} floor=${floor}`
    );
  }
  const profile = profileForBinding(policy, binding || {});
  const route = resolveReasoningRoute({
    role: input.persona || 'default',
    ...(profile ? { requestedProfile: profile } : {}),
    ...(binding?.mode ? { requestedMode: binding.mode as ReasoningBackendMode } : {}),
    ...(binding?.model ? { requestedModel: binding.model } : {}),
    env,
    policy,
  });
  return {
    profile: route.profileRef,
    mode: route.mode,
    ...(route.model ? { model: route.model } : {}),
    permission_mode: requestedPermission,
    capability_profile:
      binding?.capability_profile ||
      (requestedPermission === 'readonly' ? 'explorer' : 'implementer'),
    source,
    provenance: [
      ...provenance,
      ...route.provenance.map((entry) => `${entry.source}:${entry.field}`),
    ],
  };
}

export function _resetReasoningRoutePolicyCacheForTests(): void {
  reasoningRoutePolicyCatalog.reset();
  reasoningRouteUserConfigCatalog.reset();
  validateUserConfigFn = null;
}
