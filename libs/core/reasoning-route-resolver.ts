import { Ajv, type ValidateFunction } from 'ajv';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import { getReasoningPayloadScope } from './reasoning-egress-scope.js';
import { loadModelRegistry } from './reasoning-model-routing.js';
import { resolveActiveProfileRoot } from './profile-root.js';

const ajv = new Ajv({ allErrors: true });
const POLICY_PATH = pathResolver.knowledge('product/governance/reasoning-route-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/reasoning-route-policy.schema.json');
const USER_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/reasoning-route-user-config.schema.json'
);
const USER_CONFIG_PATH = pathResolver.shared('state/reasoning-route-user-config.json');

export type ReasoningRole = string;
export type ReasoningCapability = 'text' | 'structured_output' | 'tools' | 'vision' | 'streaming';
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
export interface ReasoningRoutePolicy {
  version: string;
  runtime_adapters: Record<string, RuntimeAdapterConfig>;
  profiles: Record<string, RuntimeProfileConfig>;
  roles: Record<string, RoleRouteConfig>;
  fallback: {
    max_attempts: number;
    max_in_place_retries: number;
    on_unsupported_parameter: UnsupportedParameterPolicy;
  };
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
  limits: { contextWindowTokens?: number; maxCompletionTokens?: number; timeoutMs: number };
  candidates: string[];
  governance: { dataTier: string; egress: 'enforced'; spend: 'enforced' };
  provenance: Array<{ source: string; field: string }>;
  rejectedCandidates: Array<{ profile: string; reason: string }>;
  failover: ReasoningRoutePolicy['fallback'];
}

let validatePolicyFn: ValidateFunction | null = null;
let validateUserConfigFn: ValidateFunction | null = null;
let cachedPolicy: ReasoningRoutePolicy | null = null;

function validator(): ValidateFunction {
  if (!validatePolicyFn) validatePolicyFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validatePolicyFn;
}

function validatePolicy(value: unknown, label: string): ReasoningRoutePolicy {
  if (!validator()(value)) {
    const errors = (validator().errors || []).map(
      (error) => `${error.instancePath || '/'} ${error.message || 'invalid'}`
    );
    throw new Error(`Invalid reasoning route policy at ${label}: ${errors.join('; ')}`);
  }
  return value as ReasoningRoutePolicy;
}

export function loadReasoningRoutePolicy(): ReasoningRoutePolicy {
  if (cachedPolicy) return cachedPolicy;
  if (!safeExistsSync(POLICY_PATH))
    throw new Error(`Missing reasoning route policy: ${POLICY_PATH}`);
  cachedPolicy = validatePolicy(
    JSON.parse(safeReadFile(POLICY_PATH, { encoding: 'utf8' }) as string),
    POLICY_PATH
  );
  return cachedPolicy;
}

export function loadReasoningRouteUserConfig(): ReasoningRouteUserConfig {
  if (!safeExistsSync(USER_CONFIG_PATH)) return {};
  const value = JSON.parse(
    safeReadFile(USER_CONFIG_PATH, { encoding: 'utf8' }) as string
  ) as ReasoningRouteUserConfig;
  validateReasoningRouteUserConfig(value, USER_CONFIG_PATH);
  return value;
}

export function validateReasoningRouteUserConfig(
  value: unknown,
  label = USER_CONFIG_PATH
): ReasoningRouteUserConfig {
  if (!validateUserConfigFn) validateUserConfigFn = compileSchemaFromPath(ajv, USER_SCHEMA_PATH);
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
  return env[key]?.trim() || env.KYBERION_REASONING_PROFILE?.trim();
}

function loadOperatorLlmSelection(): { provider: string; model_id?: string } | null {
  const filePath = path.join(resolveActiveProfileRoot(), 'onboarding', 'llm-selection.json');
  if (!safeExistsSync(filePath)) return null;
  try {
    const value = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as {
      provider?: unknown;
      model_id?: unknown;
    };
    if (typeof value.provider !== 'string' || !value.provider.trim()) return null;
    return {
      provider: value.provider.trim(),
      model_id:
        typeof value.model_id === 'string' && value.model_id.trim()
          ? value.model_id.trim()
          : undefined,
    };
  } catch {
    return null;
  }
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
    .map((key) => env[key]?.trim())
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
  const registered = loadModelRegistry().models.find((entry) => entry.model_id === model);
  if (registered) {
    if (registered.status === 'blocked' || registered.status === 'deprecated') {
      throw new Error(
        `Model ${model} is ${registered.status} and cannot be selected for ${input.profile}`
      );
    }
    return model;
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
    env?: NodeJS.ProcessEnv;
    policy?: ReasoningRoutePolicy;
    userConfig?: ReasoningRouteUserConfig;
  } = {}
): ResolvedReasoningRoute {
  const policy = input.policy ?? loadReasoningRoutePolicy();
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
    if (allowedTools.includes('shell_exec') && env.KYBERION_REASONING_ALLOW_SHELL_TOOL !== 'true') {
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
      rejectedCandidates,
      failover: policy.fallback,
    };
  }
  throw new Error(
    `No usable reasoning route for role ${role}. Rejected: ${rejectedCandidates.map((x) => `${x.profile} (${x.reason})`).join('; ')}`
  );
}

export function resetReasoningRoutePolicyCache(): void {
  cachedPolicy = null;
  validatePolicyFn = null;
  validateUserConfigFn = null;
}
