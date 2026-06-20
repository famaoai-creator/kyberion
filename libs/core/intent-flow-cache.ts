import AjvModule, { type ValidateFunction } from 'ajv';
import { createHash } from 'node:crypto';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';
import type { ActuatorExecutionBrief } from './src/types/actuator-execution-brief.js';
import type { OrganizationWorkLoopSummary } from './work-design.js';
import type { AgentRoutingDecision, CompileUserIntentFlowInput, IntentContract, UserIntentFlow } from './intent-contract.js';
import type { IntentResolutionPacket, StandardIntentDefinition } from './intent-resolution.js';
import type { ReasoningLevelDecision } from './reasoning-level-policy.js';
import type { ReasoningModelRoute } from './reasoning-model-routing.js';
import { loadReasoningLevelPolicy } from './reasoning-level-policy.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CACHE_PATH = pathResolver.shared('runtime/intent-flow-cache.json');
const CACHE_SCHEMA_PATH = pathResolver.knowledge('product/schemas/intent-flow-cache.schema.json');
const INTENT_CONTRACT_SCHEMA_PATH = pathResolver.knowledge('product/schemas/intent-contract.schema.json');
const WORK_LOOP_SCHEMA_PATH = pathResolver.knowledge('product/schemas/organization-work-loop.schema.json');
const EXECUTION_BRIEF_SCHEMA_PATH = pathResolver.knowledge('product/schemas/actuator-execution-brief.schema.json');
const CACHE_SCHEMA_VERSION = '1.0.0';
const INTENT_CONTRACT_SCHEMA_VERSION = 'https://kyberion.local/schemas/intent-contract.schema.json';
const REDACTED_PROMPT_VALUE = '<redacted>';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type CacheStatus = 'disabled' | 'miss' | 'hit' | 'invalid' | 'write';
type ConfidenceBand = 'low' | 'medium' | 'high';

export interface IntentFlowCacheKey {
  normalized_intent_text: string;
  locale: string;
  tier: 'public' | 'confidential';
  channel: string;
  service_bindings: string[];
  runtime_context_fingerprint: Record<string, unknown>;
  selected_intent_id: string;
  selected_confidence_band: ConfidenceBand;
  reasoning_level: string;
  reasoning_policy_version: string;
  intent_contract_schema_version: string;
  recommended_model_id: string | null;
}

export interface IntentFlowCacheEligibility {
  eligible: boolean;
  reason: string;
  cacheKey?: IntentFlowCacheKey;
  cacheKeyHash?: string;
  ttlMs: number;
}

interface IntentFlowCacheEntry {
  cache_key_hash: string;
  cache_key: IntentFlowCacheKey;
  created_at: string;
  expires_at: string;
  payload: CachedIntentFlowPayload;
}

interface IntentFlowCacheStore {
  version: string;
  updated_at: string;
  ttl_ms: number;
  entries: IntentFlowCacheEntry[];
}

interface CachedIntentFlowPayload {
  source: 'llm';
  executionBrief: ActuatorExecutionBrief & { request_text: string };
  intentContract: IntentContract & { source_text: string };
  workLoop: OrganizationWorkLoopSummary;
  reasoningDecision: ReasoningLevelDecision;
  shadowModelRoute: ReasoningModelRoute;
  routingDecision?: AgentRoutingDecision;
}

export interface IntentFlowCacheLookupResult {
  status: CacheStatus;
  reason: string;
  cacheKeyHash?: string;
  cachedFlow?: UserIntentFlow;
}

export interface IntentFlowCacheWriteResult {
  status: CacheStatus;
  reason: string;
  cacheKeyHash?: string;
}

let cacheValidateFn: ValidateFunction | null = null;
let intentContractValidateFn: ValidateFunction | null = null;
let workLoopValidateFn: ValidateFunction | null = null;
let executionBriefValidateFn: ValidateFunction | null = null;
let cachedStore: IntentFlowCacheStore | null = null;
let cachedStorePath: string | null = null;

function ensureCacheValidator(): ValidateFunction {
  if (cacheValidateFn) return cacheValidateFn;
  cacheValidateFn = compileSchemaFromPath(ajv, CACHE_SCHEMA_PATH);
  return cacheValidateFn;
}

function ensureIntentContractValidator(): ValidateFunction {
  if (intentContractValidateFn) return intentContractValidateFn;
  intentContractValidateFn = compileSchemaFromPath(ajv, INTENT_CONTRACT_SCHEMA_PATH);
  return intentContractValidateFn;
}

function ensureWorkLoopValidator(): ValidateFunction {
  if (workLoopValidateFn) return workLoopValidateFn;
  workLoopValidateFn = compileSchemaFromPath(ajv, WORK_LOOP_SCHEMA_PATH);
  return workLoopValidateFn;
}

function ensureExecutionBriefValidator(): ValidateFunction {
  if (executionBriefValidateFn) return executionBriefValidateFn;
  executionBriefValidateFn = compileSchemaFromPath(ajv, EXECUTION_BRIEF_SCHEMA_PATH);
  return executionBriefValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateCacheStore(value: unknown, label = CACHE_PATH): IntentFlowCacheStore {
  const validate = ensureCacheValidator();
  if (!validate(value)) {
    throw new Error(`Invalid intent-flow cache at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as IntentFlowCacheStore;
}

function validateStoredExecutionBrief(value: unknown): value is ActuatorExecutionBrief & { request_text: string } {
  const validate = ensureExecutionBriefValidator();
  return Boolean(validate(value));
}

function validateStoredIntentContract(value: unknown): value is IntentContract & { source_text: string } {
  const validate = ensureIntentContractValidator();
  return Boolean(validate(value));
}

function validateStoredWorkLoop(value: unknown): value is OrganizationWorkLoopSummary {
  const validate = ensureWorkLoopValidator();
  return Boolean(validate(value));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const next = canonicalize((value as Record<string, unknown>)[key]);
      if (next !== undefined) acc[key] = next;
      return acc;
    }, {});
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cacheExpiry(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

function normalizeText(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function confidenceBand(confidence?: number): ConfidenceBand {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return 'low';
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.65) return 'medium';
  return 'low';
}

const ALLOWED_RUNTIME_CONTEXT_KEYS = new Set([
  'channel',
  'execution_shape',
  'locale',
  'mission_id',
  'mode',
  'model_id',
  'model_provider',
  'platform_id',
  'project_id',
  'project_name',
  'service_binding_ids',
  'service_bindings',
  'surface',
  'target_platform',
  'tenant_id',
  'tenant_slug',
  'task_type',
  'track_id',
  'track_name',
  'workflow_shape',
]);

function normalizeRuntimeContextFingerprint(value: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return {};
  const keys = Object.keys(value);
  const fingerprint: Record<string, unknown> = {};
  for (const key of keys) {
    if (!ALLOWED_RUNTIME_CONTEXT_KEYS.has(key)) return null;
    if (/(token|secret|password|credential|cookie|bearer|api[_-]?key|auth|session|jwt)/i.test(key)) {
      return null;
    }
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string') {
      fingerprint[key] = normalizeText(raw);
      continue;
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      fingerprint[key] = raw;
      continue;
    }
    if (Array.isArray(raw)) {
      const normalized = raw.map((item) => {
        if (typeof item === 'string') return normalizeText(item);
        if (typeof item === 'number' || typeof item === 'boolean') return item;
        return null;
      });
      if (normalized.some((item) => item === null)) return null;
      fingerprint[key] = [...new Set(normalized.map(String))].sort();
      continue;
    }
    return null;
  }
  return canonicalize(fingerprint) as Record<string, unknown>;
}

function normalizeServiceBindings(bindings: string[] | undefined): string[] {
  return [...new Set((bindings || []).map((value) => normalizeText(value)).filter(Boolean))].sort();
}

function isCacheableTier(tier: CompileUserIntentFlowInput['tier']): tier is 'public' | 'confidential' {
  return tier === 'public' || tier === 'confidential';
}

export function buildIntentFlowCacheEligibility(input: {
  text: string;
  locale?: string;
  tier?: CompileUserIntentFlowInput['tier'];
  channel?: string;
  serviceBindings?: string[];
  runtimeContext?: Record<string, unknown>;
  resolutionPacket: IntentResolutionPacket;
  selectedIntent?: StandardIntentDefinition;
  reasoningDecision: ReasoningLevelDecision;
  shadowModelRoute: ReasoningModelRoute;
}): IntentFlowCacheEligibility {
  const policy = loadReasoningLevelPolicy();
  const ttlMs = Math.max(1, Number(policy.cache_ttl_hours || 24) * 60 * 60 * 1000);
  if (!isCacheableTier(input.tier)) {
    return { eligible: false, reason: 'request tier is not cacheable', ttlMs };
  }
  if (input.reasoningDecision.level !== 'REACTION_FAST') {
    return { eligible: false, reason: 'reasoning level is not REACTION_FAST', ttlMs };
  }
  const selectedIntent = input.selectedIntent;
  const selectedConfidence = input.resolutionPacket.selected_confidence;
  if (!selectedIntent || typeof selectedConfidence !== 'number' || selectedConfidence < 0.85) {
    return { eligible: false, reason: 'selected intent is missing or below the fast-lane confidence threshold', ttlMs };
  }
  if (selectedIntent.risk_profile !== 'low') {
    return { eligible: false, reason: 'selected intent risk is not low', ttlMs };
  }
  const runtimeContextFingerprint = normalizeRuntimeContextFingerprint(input.runtimeContext);
  if (runtimeContextFingerprint === null) {
    return { eligible: false, reason: 'runtime context cannot be safely reduced to the allowlist', ttlMs };
  }
  const recommendedModelId = input.shadowModelRoute.recommended_model_id;
  if (!recommendedModelId) {
    return { eligible: false, reason: 'recommended model id is missing', ttlMs };
  }

  const cacheKey: IntentFlowCacheKey = {
    normalized_intent_text: normalizeText(input.text),
    locale: normalizeText(input.locale || ''),
    tier: input.tier,
    channel: normalizeText(input.channel || ''),
    service_bindings: normalizeServiceBindings(input.serviceBindings),
    runtime_context_fingerprint: runtimeContextFingerprint,
    selected_intent_id: selectedIntent.id || input.resolutionPacket.selected_intent_id || '',
    selected_confidence_band: confidenceBand(selectedConfidence),
    reasoning_level: input.reasoningDecision.level,
    reasoning_policy_version: input.reasoningDecision.policy_version,
    intent_contract_schema_version: INTENT_CONTRACT_SCHEMA_VERSION,
    recommended_model_id: recommendedModelId,
  };

  return {
    eligible: true,
    reason: 'cacheable low-risk reaction-fast request',
    cacheKey,
    cacheKeyHash: sha256Hex(cacheKey),
    ttlMs,
  };
}

function loadCacheStoreFromDisk(): IntentFlowCacheStore | null {
  if (!safeExistsSync(CACHE_PATH)) return null;
  const raw = safeReadFile(CACHE_PATH, { encoding: 'utf8' }) as string;
  return validateCacheStore(JSON.parse(raw), CACHE_PATH);
}

function loadCacheStore(): IntentFlowCacheStore {
  if (cachedStore && cachedStorePath === CACHE_PATH) return cachedStore;
  const store = loadCacheStoreFromDisk();
  if (store) {
    cachedStore = store;
    cachedStorePath = CACHE_PATH;
    return store;
  }
  const empty: IntentFlowCacheStore = {
    version: CACHE_SCHEMA_VERSION,
    updated_at: nowIso(),
    ttl_ms: DEFAULT_TTL_MS,
    entries: [],
  };
  cachedStore = empty;
  cachedStorePath = CACHE_PATH;
  return empty;
}

function saveCacheStore(store: IntentFlowCacheStore): void {
  const dir = pathResolver.shared('runtime');
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(CACHE_PATH, JSON.stringify(store, null, 2));
  cachedStore = store;
  cachedStorePath = CACHE_PATH;
}

function isExpired(entry: IntentFlowCacheEntry): boolean {
  return Date.parse(entry.expires_at) <= Date.now();
}

function restoreCachedFlow(payload: CachedIntentFlowPayload, inputText: string): UserIntentFlow {
  const executionBrief = clone(payload.executionBrief);
  executionBrief.request_text = inputText;
  const intentContract = clone(payload.intentContract);
  intentContract.source_text = inputText;
  return {
    executionBrief,
    intentContract,
    workLoop: clone(payload.workLoop),
    routingDecision: payload.routingDecision ? clone(payload.routingDecision) : undefined,
    reasoningDecision: clone(payload.reasoningDecision),
    shadowModelRoute: clone(payload.shadowModelRoute),
    source: payload.source,
  };
}

function validateCachedFlowPayload(payload: CachedIntentFlowPayload): string | null {
  if (payload.source !== 'llm') return 'cached flow source must be llm';
  if (!validateStoredExecutionBrief(payload.executionBrief)) return 'cached execution brief failed validation';
  if (!validateStoredIntentContract(payload.intentContract)) return 'cached intent contract failed validation';
  if (!validateStoredWorkLoop(payload.workLoop)) return 'cached work loop failed validation';
  if (!payload.reasoningDecision || typeof payload.reasoningDecision.level !== 'string') {
    return 'cached reasoning decision is invalid';
  }
  if (!payload.shadowModelRoute || typeof payload.shadowModelRoute.model_route_status !== 'string') {
    return 'cached shadow model route is invalid';
  }
  return null;
}

export function lookupIntentFlowCache(input: {
  eligibility: IntentFlowCacheEligibility;
  inputText: string;
}): IntentFlowCacheLookupResult {
  const { eligibility } = input;
  if (!eligibility.eligible || !eligibility.cacheKeyHash || !eligibility.cacheKey) {
    return {
      status: 'disabled',
      reason: eligibility.reason,
    };
  }

  let store: IntentFlowCacheStore;
  try {
    store = loadCacheStore();
  } catch {
    return { status: 'invalid', reason: 'intent flow cache store is invalid' };
  }

  const entry = store.entries.find((row) => row.cache_key_hash === eligibility.cacheKeyHash);
  if (!entry) {
    return {
      status: 'miss',
      reason: 'no matching cache entry',
      cacheKeyHash: eligibility.cacheKeyHash,
    };
  }
  if (entry.cache_key_hash !== eligibility.cacheKeyHash) {
    return {
      status: 'miss',
      reason: 'cache key mismatch',
      cacheKeyHash: eligibility.cacheKeyHash,
    };
  }
  if (isExpired(entry)) {
    return {
      status: 'miss',
      reason: 'cache entry expired',
      cacheKeyHash: eligibility.cacheKeyHash,
    };
  }

  const payloadError = validateCachedFlowPayload(entry.payload);
  if (payloadError) {
    return {
      status: 'invalid',
      reason: payloadError,
      cacheKeyHash: eligibility.cacheKeyHash,
    };
  }

  return {
    status: 'hit',
    reason: 'cache entry matched',
    cacheKeyHash: eligibility.cacheKeyHash,
    cachedFlow: restoreCachedFlow(entry.payload, input.inputText),
  };
}

export function storeIntentFlowCache(input: {
  eligibility: IntentFlowCacheEligibility;
  flow: UserIntentFlow;
}): IntentFlowCacheWriteResult {
  const { eligibility, flow } = input;
  if (!eligibility.eligible || !eligibility.cacheKeyHash || !eligibility.cacheKey) {
    return { status: 'disabled', reason: eligibility.reason };
  }
  if (flow.source !== 'llm') {
    return { status: 'disabled', reason: 'only llm flows are cacheable', cacheKeyHash: eligibility.cacheKeyHash };
  }
  if (flow.intentContract.approval.requires_approval) {
    return { status: 'disabled', reason: 'approval-required flows are not cacheable', cacheKeyHash: eligibility.cacheKeyHash };
  }
  if (flow.intentContract.clarification_needed) {
    return { status: 'disabled', reason: 'clarification-required flows are not cacheable', cacheKeyHash: eligibility.cacheKeyHash };
  }
  const payload: CachedIntentFlowPayload = {
    source: 'llm',
    executionBrief: {
      ...clone(flow.executionBrief),
      request_text: REDACTED_PROMPT_VALUE,
    },
    intentContract: {
      ...clone(flow.intentContract),
      source_text: REDACTED_PROMPT_VALUE,
    },
    workLoop: clone(flow.workLoop),
    reasoningDecision: clone(flow.reasoningDecision),
    shadowModelRoute: clone(flow.shadowModelRoute),
    ...(flow.routingDecision ? { routingDecision: clone(flow.routingDecision) } : {}),
  };
  const payloadError = validateCachedFlowPayload(payload);
  if (payloadError) {
    return { status: 'invalid', reason: payloadError, cacheKeyHash: eligibility.cacheKeyHash };
  }

  let store: IntentFlowCacheStore;
  try {
    store = loadCacheStore();
  } catch {
    store = {
      version: CACHE_SCHEMA_VERSION,
      updated_at: nowIso(),
      ttl_ms: eligibility.ttlMs,
      entries: [],
    };
  }
  const nextEntries = store.entries.filter((entry) => entry.cache_key_hash !== eligibility.cacheKeyHash);
  const nextStore: IntentFlowCacheStore = {
    version: CACHE_SCHEMA_VERSION,
    updated_at: nowIso(),
    ttl_ms: eligibility.ttlMs,
    entries: [
      ...nextEntries,
      {
        cache_key_hash: eligibility.cacheKeyHash,
        cache_key: eligibility.cacheKey,
        created_at: nowIso(),
        expires_at: cacheExpiry(eligibility.ttlMs),
        payload,
      },
    ],
  };
  try {
    saveCacheStore(nextStore);
  } catch {
    return { status: 'miss', reason: 'cache write failed', cacheKeyHash: eligibility.cacheKeyHash };
  }
  return {
    status: 'write',
    reason: 'cache entry stored',
    cacheKeyHash: eligibility.cacheKeyHash,
  };
}

export function loadIntentFlowCacheSnapshot(): IntentFlowCacheStore {
  return loadCacheStore();
}

export function refreshIntentFlowCacheSnapshot(): IntentFlowCacheStore {
  cachedStore = null;
  cachedStorePath = null;
  return loadCacheStore();
}

export function intentFlowCachePath(): string {
  return CACHE_PATH;
}

export function getIntentContractSchemaVersion(): string {
  return INTENT_CONTRACT_SCHEMA_VERSION;
}

export function getDefaultIntentFlowCacheTtlMs(): number {
  return DEFAULT_TTL_MS;
}
