import {
  appendJsonLine,
  defineCatalog,
  getRegisteredEnv,
  getRegisteredEnvText,
  isRecord,
  parseSafeJsonInput,
  type GovernedCatalog,
} from '@agent/core/foundation';
import { logger } from '@agent/core/core';
import {
  safeExec,
  safeReadFile,
  safeWriteFile,
  safeExistsSync,
  safeMkdir,
  safeOpenAppendFile,
  assertSafeRepositoryPath,
} from '@agent/core/secure-io';
import { retry } from '@agent/core/async-utils';
import { runtimeSupervisor } from '@agent/core/runtime-supervisor';
import { spawnManagedProcess, stopManagedProcess } from '@agent/core/managed-process';
import { derivePipelineStatus } from '@agent/core/pipeline-contract';
import { resolveServiceBinding } from '@agent/core/service-binding';
import * as pathResolver from '@agent/core/path-resolver';
import { executeServicePreset, executeMcp } from '@agent/core/service-engine';
import {
  beginServiceOAuth,
  exchangeServiceOAuthCode,
  refreshServiceOAuthToken,
} from '@agent/core/oauth-broker';
import { validateServiceAuth } from '@agent/core/service-validator';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { loadServiceEndpointsCatalog } from '@agent/core/service-endpoint-registry';
import { getServicePresetRecord } from '@agent/core/service-preset-registry';
import {
  CloudflareOsControlPlane,
  type IntroductionMode,
  type OsKnowledgeTier,
  type ResourceScope,
} from '@agent/core/cloudflare-os-control-plane';
import { withEgressPayloadContext, type EgressPayloadContext } from '@agent/core/egress-policy';
import {
  describeServiceHarness,
  planServiceOperation,
  verifyServiceOperationResult,
  createServiceExecutionReceipt,
  persistServiceExecutionReceipt,
  type ServiceExecutionReceipt,
} from '@agent/core/service-harness';
import { recordServiceCall } from '@agent/core/service-recording-session';
import {
  validateContextSecurityScope,
  type ContextSecurityScope,
} from '@agent/core/context-security-scope';
import { capabilityEntry } from '@agent/core/path-resolver';
import { parseServicePidRegistry, type ServicePidRegistry } from '@agent/core/service-pid-registry';
import { runOpPreflight } from '@agent/core/op-preflight';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { secureFetch } from '@agent/core/network';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface ServiceAction {
  service_id: string;
  mode: 'API' | 'CLI' | 'SDK' | 'RECONCILE' | 'PRESET' | 'OAUTH' | 'MCP' | 'HARNESS';
  action: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params: any;
  auth?: 'none' | 'secret-guard' | 'session';
  steps?: Array<{
    op: string;
    params: any;
    retry?: RetryPolicy;
  }>;
  context?: Record<string, any>;
}

export interface ServiceActionExecutionOptions {
  /** Trusted caller-side presence signal for approval-gated service actions. */
  hasHuman?: boolean;
  /** Trusted caller-side resolver for an already-bound approval decision. */
  approvalGranted?: (input: ServiceAction) => boolean | Promise<boolean>;
}

export interface ServiceManifestEntry {
  path: string;
  description?: string;
  preset_path?: string;
  env?: Record<string, string>;
}

export type ServiceManifest = Record<string, ServiceManifestEntry>;

type RetryPolicy = {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
};

const SERVICE_ACTUATOR_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/service-actuator/manifest.json'
);
const DEFAULT_PIPELINE_RETRY: Required<RetryPolicy> = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};
const PID_FILE = pathResolver.shared('services-pids.json');
const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const SERVICE_MANIFEST_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/service-manifest.schema.json'
);
const serviceManifestCatalogs = new Map<string, GovernedCatalog<ServiceManifest>>();
const cloudflareOsControlPlane = new CloudflareOsControlPlane();
const DANGEROUS_DYNAMIC_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function serviceManifestCatalogAtPath(manifestPath: string): GovernedCatalog<ServiceManifest> {
  const existing = serviceManifestCatalogs.get(manifestPath);
  if (existing) return existing;
  const catalog = defineCatalog<ServiceManifest>({
    id: 'service-manifest',
    path: manifestPath,
    schema: SERVICE_MANIFEST_SCHEMA_PATH,
  });
  serviceManifestCatalogs.set(manifestPath, catalog);
  return catalog;
}

function resolveServiceRepositoryPath(ref: string): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), { allowMissingLeaf: true });
}

function isSafeServiceId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Service params/context/steps intentionally accept provider-specific fields.
 * Keep that dynamic contract, but never pass prototype-control keys through the
 * actuator boundary where they could be merged into runtime state.
 */
function hasSafeDynamicServiceTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeDynamicServiceTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_DYNAMIC_KEYS.has(key) && hasSafeDynamicServiceTree(nested)
  );
}

/** Validate a persisted service manifest before reconcile can start or stop services. */
export function parseServiceManifest(value: unknown): ServiceManifest | null {
  if (!isRecord(value)) return null;

  const manifest: ServiceManifest = {};
  for (const [serviceId, candidate] of Object.entries(value)) {
    if (!isSafeServiceId(serviceId) || !isRecord(candidate) || !nonEmptyString(candidate.path)) {
      return null;
    }
    if (candidate.description !== undefined && typeof candidate.description !== 'string') {
      return null;
    }
    if (candidate.preset_path !== undefined && !nonEmptyString(candidate.preset_path)) {
      return null;
    }

    let env: Record<string, string> | undefined;
    if (candidate.env !== undefined) {
      if (!isRecord(candidate.env)) return null;
      env = {};
      for (const [key, envValue] of Object.entries(candidate.env)) {
        if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') {
          return null;
        }
        if (typeof envValue !== 'string') return null;
        env[key] = envValue;
      }
    }

    manifest[serviceId] = {
      path: candidate.path,
      ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
      ...(typeof candidate.preset_path === 'string' ? { preset_path: candidate.preset_path } : {}),
      ...(env ? { env } : {}),
    };
  }
  return manifest;
}

function serviceResourceId(serviceId: string): string {
  return `service:${serviceId}`;
}

function loadPids(): ServicePidRegistry {
  if (!safeExistsSync(PID_FILE)) return {};
  try {
    const content = safeReadFile(PID_FILE, { encoding: 'utf8' }) as string;
    const parsed: unknown = parseSafeJsonInput(content, 'service PID registry');
    return parseServicePidRegistry(parsed) ?? {};
  } catch (_) {
    return {};
  }
}

function savePids(pids: ServicePidRegistry) {
  safeWriteFile(PID_FILE, JSON.stringify(pids, null, 2));
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function emitRecoveryStimulus(serviceId: string) {
  const date = new Date();
  const stimulus = {
    id: `req-${date.toISOString().split('T')[0].replace(/-/g, '')}-recovery-${crypto.randomBytes(3).toString('hex')}`,
    ts: date.toISOString(),
    ttl: 600,
    origin: { channel: 'system', source_id: 'service-actuator' },
    signal: {
      intent: 'alert',
      priority: 8,
      payload: `[SELF_HEALING] Service '${serviceId}' crash detected.`,
    },
    control: {
      status: 'pending',
      feedback: 'auto',
      evidence: [{ step: 'auto_recovery', ts: date.toISOString(), agent: 'service-actuator' }],
    },
  };
  appendJsonLine(STIMULI_PATH, stimulus);
}

const buildPipelineRetryPolicy = createGovernedRetryOptionsBuilder({
  manifestPath: SERVICE_ACTUATOR_MANIFEST_PATH,
  defaults: DEFAULT_PIPELINE_RETRY,
  fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

function resolveServiceBaseUrl(serviceId: string): string {
  try {
    const catalog = loadServiceEndpointsCatalog();
    const baseUrl = catalog?.services?.[serviceId]?.base_url;
    if (typeof baseUrl === 'string' && baseUrl.trim()) return baseUrl.trim();
    const pattern = typeof catalog?.default_pattern === 'string' ? catalog.default_pattern : '';
    if (pattern.includes('{service_id}')) return pattern.replace('{service_id}', serviceId);
  } catch (err) {
    logger.warn(`[service-actuator-helpers] suppressed error in resolveServiceBaseUrl: ${err}`);
  }
  return `https://api.${serviceId}.com/v1`;
}

function registerServiceRuntime(serviceId: string, pid: number | undefined, manifestPath?: string) {
  if (!pid) return;

  const updated = runtimeSupervisor.update(serviceResourceId(serviceId), {
    pid,
    state: 'running',
    metadata: {
      serviceId,
      manifestPath,
    },
    lastActiveAt: Date.now(),
  });

  if (!updated) {
    runtimeSupervisor.register({
      resourceId: serviceResourceId(serviceId),
      kind: 'service',
      ownerId: manifestPath || serviceId,
      ownerType: manifestPath ? 'service-manifest' : 'service',
      pid,
      shutdownPolicy: 'detached',
      metadata: {
        serviceId,
        manifestPath,
      },
      cleanup: () => {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (_) {
          /* best-effort cleanup */
        }
      },
    });
  }
}

function unregisterServiceRuntime(serviceId: string) {
  runtimeSupervisor.unregister(serviceResourceId(serviceId));
}

async function startService(id: string, service: ServiceManifestEntry, pids: ServicePidRegistry) {
  const rootDir = pathResolver.rootDir();
  const scriptPath = path.join(rootDir, service.path);
  const builtEntry = capabilityEntry(id);
  const logFile = path.join(rootDir, `active/shared/logs/${id}.log`);
  if (!safeExistsSync(path.dirname(logFile))) safeMkdir(path.dirname(logFile), { recursive: true });
  const out = safeOpenAppendFile(logFile);

  const env = { ...process.env, ...(service.env || {}) };
  const managed = spawnManagedProcess({
    resourceId: serviceResourceId(id),
    kind: 'service',
    ownerId: service.path || id,
    ownerType: 'service-actuator',
    command: 'node',
    args: [builtEntry],
    shutdownPolicy: 'detached',
    spawnOptions: {
      detached: true,
      stdio: ['ignore', out, out],
      cwd: rootDir,
      env,
    },
    metadata: {
      scriptPath,
      builtEntry,
    },
  });
  const child = managed.child;
  child.unref();
  if (typeof child.pid === 'number' && Number.isSafeInteger(child.pid) && child.pid > 0) {
    pids[id] = child.pid;
  }
  registerServiceRuntime(id, child.pid, scriptPath);
  logger.success(`  - ${id} started (PID: ${child.pid}).`);
}

export async function handleAction(
  input: ServiceAction,
  onEvent?: (data: any) => void,
  options: ServiceActionExecutionOptions = {}
) {
  const admitted = await admitServiceAction(input, options);
  input = admitted;
  if (input.action === 'pipeline') {
    const results: Array<{ op: string; status: 'success' | 'failed'; error?: string }> = [];
    let ctx = { ...input.context };
    const steps = input.steps || [];
    for (const step of steps) {
      logger.info(`🔌 [SERVICE] Executing step: ${step.op}`);
      const stepResult = await retry(async () => {
        return await handleSingleAction(
          {
            service_id: step.params.service_id,
            mode: step.op.toUpperCase() as ServiceAction['mode'],
            action: step.params.action,
            params: step.params.params,
            auth: step.params.auth,
            method: step.params.method,
            // The pipeline envelope is authoritative. A step may add context
            // but cannot weaken or redirect the parent mission scope.
            context: { ...(step.params.context || {}), ...input.context },
          },
          undefined,
          false,
          options
        );
      }, buildPipelineRetryPolicy(step.params.retry));

      const exportKey = step.params.export_as || 'last_service_result';
      ctx[exportKey] = stepResult;
      results.push({ op: step.op, status: 'success' });
    }
    if (input.context?.context_path) {
      safeWriteFile(
        resolveServiceRepositoryPath(input.context.context_path),
        JSON.stringify(ctx, null, 2)
      );
    }
    return { status: derivePipelineStatus(results), results, ...ctx };
  }
  return await handleSingleAction(input, onEvent, true);
}

async function handleSingleAction(
  input: ServiceAction,
  onEvent?: (data: any) => void,
  alreadyAdmitted = false,
  options: ServiceActionExecutionOptions = {}
) {
  if (!alreadyAdmitted) input = await admitServiceAction(input, options);
  logger.info(
    `🔌 [SERVICE] Dispatching to ${input.service_id} (Mode: ${input.mode}, Action: ${input.action})`
  );

  const preparedObservation = prepareServiceObservation(input);
  enforceResourceIntroduction(input);

  const egressContext = prepareServiceEgressContext(input);

  const execute = async (): Promise<unknown> => {
    switch (input.mode) {
      case 'PRESET':
        return await executeServicePreset(
          input.service_id,
          input.action,
          input.params,
          input.auth === 'secret-guard' ? 'secret-guard' : 'none'
        );

      case 'MCP':
        assertUnsafeCliAllowed();
        const mcpCmd = String(input.params.command || 'npx');
        const mcpArgs = Array.isArray(input.params.args) ? input.params.args.map(String) : [];
        return await executeMcp(mcpCmd, mcpArgs, {
          action: input.params.mcp_action || 'call_tool',
          name: input.action,
          arguments: input.params.arguments || input.params,
        });

      case 'OAUTH':
        if (input.action === 'begin')
          return beginServiceOAuth(input.service_id, input.params || {});
        if (input.action === 'exchange') {
          return await exchangeServiceOAuthCode(input.service_id, input.params || {});
        }
        if (input.action === 'refresh') {
          return await refreshServiceOAuthToken(input.service_id, input.params || {});
        }
        throw new Error(`Unsupported OAuth action: ${input.action}`);

      case 'RECONCILE':
        return await reconcileServices(input);

      case 'HARNESS':
        return await executeHarnessRequest(input);

      case 'API':
        return await executeApiRequest(input);

      case 'CLI':
        return await executeCliRequest(input);

      default:
        throw new Error(`Unsupported mode: ${input.mode}`);
    }
  };

  const result = egressContext
    ? await withEgressPayloadContext(egressContext, execute)
    : await execute();

  // Capture only canonical PRESET calls when an explicit recording session is
  // attached by the caller. The session stores operation metadata and bounded
  // result shape; it redacts secret parameter values before persistence.
  if (input.mode === 'PRESET') {
    const sessionId = String(input.context?.service_recording_session_id || '').trim();
    if (sessionId) {
      try {
        recordServiceCall(sessionId, {
          service_id: input.service_id,
          action: input.action,
          params: input.params,
          result,
          summary: input.context?.service_recording_summary,
          produces: input.context?.service_recording_produces,
          consumes: Array.isArray(input.context?.service_recording_consumes)
            ? input.context.service_recording_consumes.map(String)
            : undefined,
        });
      } catch (error) {
        // Recording is enrichment after the external call. Never throw here or
        // a retry could duplicate a side effect that already completed.
        logger.warn(
          `[service-actuator] service recording failed after execution: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  recordServiceObservation(preparedObservation, result);
  return result;
}

/**
 * DH-01: service-actuator is also a public execution boundary. Pipeline
 * dispatch normally arrives through run_pipeline, but direct CLI, harness,
 * and embedded callers must receive the same serial preflight waterfall.
 */
async function admitServiceAction(
  input: ServiceAction,
  options: ServiceActionExecutionOptions = {}
): Promise<ServiceAction> {
  if (!hasSafeDynamicServiceTree(input)) {
    throw new Error('[POLICY_VIOLATION] Service action payload contains a reserved prototype key');
  }
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `service:${String(input.mode || input.action || 'unknown').toLowerCase()}:${input.action || 'unknown'}`,
    params: input as unknown as Record<string, unknown>,
    context: input.context,
    source: 'actuator',
    requiresApproval:
      input.params?._approval_required === true || input.context?._approval_required === true,
    approvalGranted: options.approvalGranted ? await options.approvalGranted(input) : false,
    ...(options.hasHuman !== undefined ? { hasHuman: options.hasHuman } : {}),
  });
  if (preflight.decision === 'allow' && !hasSafeDynamicServiceTree(preflight.input)) {
    throw new Error('[POLICY_VIOLATION] Service preflight produced a reserved prototype key');
  }
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || 'Service operation was not admitted.'}`
    );
  }
  return preflight.input as unknown as ServiceAction;
}

async function executeHarnessRequest(input: ServiceAction): Promise<unknown> {
  const params = input.params && typeof input.params === 'object' ? input.params : {};
  switch (input.action) {
    case 'describe':
      return describeServiceHarness(input.service_id, {
        detail: params.detail !== false,
      });
    case 'plan': {
      const action = String(params.operation || params.action || '').trim();
      if (!action) throw new Error('HARNESS plan requires params.operation');
      const inputs =
        params.inputs && typeof params.inputs === 'object' && !Array.isArray(params.inputs)
          ? params.inputs
          : {};
      return planServiceOperation(input.service_id, action, inputs);
    }
    case 'verify': {
      const action = String(params.operation || '').trim();
      if (!action) throw new Error('HARNESS verify requires params.operation');
      const descriptor = describeServiceHarness(input.service_id, { detail: true });
      const operation = descriptor.operations.find((candidate) => candidate.action === action);
      if (!operation)
        throw new Error(`Operation "${action}" not found for service ${input.service_id}`);
      return verifyServiceOperationResult(operation, params.result);
    }
    case 'receipt': {
      const requestedServiceId = String(params.service_id || input.service_id).trim();
      if (requestedServiceId !== input.service_id) {
        throw new Error('HARNESS receipt plan service_id must match the request service_id');
      }
      if (
        params.plan &&
        typeof params.plan === 'object' &&
        String(params.plan.service_id || '').trim() !== input.service_id
      ) {
        throw new Error('HARNESS receipt plan service_id must match the request service_id');
      }
      const plan =
        params.plan && typeof params.plan === 'object'
          ? params.plan
          : planServiceOperation(
              input.service_id,
              String(params.operation || '').trim(),
              params.inputs && typeof params.inputs === 'object' ? params.inputs : {}
            );
      const receipt = createServiceExecutionReceipt(
        plan as Parameters<typeof createServiceExecutionReceipt>[0],
        params.result,
        {
          status: params.status as ServiceExecutionReceipt['status'] | undefined,
          error: typeof params.error === 'string' ? params.error : undefined,
        }
      );
      return params.persist === true ? persistServiceExecutionReceipt(receipt) : receipt;
    }
    default:
      throw new Error(`Unsupported HARNESS action: ${input.action}`);
  }
}

interface PreparedObservation {
  missionId: string;
  taskId?: string;
  service: string;
  resourceRef: string;
  tier: OsKnowledgeTier;
  tenantSlug: string;
  purpose: string;
  summary: string;
}

function resolveTrustedScope(
  context: Record<string, any>,
  required: boolean
): ContextSecurityScope | null {
  const raw = context.security_scope;
  if (!raw || typeof raw !== 'object') {
    if (required) {
      throw new Error('[POLICY_VIOLATION] Governed service actions require security_scope');
    }
    return null;
  }
  const scope = raw as ContextSecurityScope;
  const errors = validateContextSecurityScope(scope);
  if (errors.length > 0) {
    throw new Error(`[POLICY_VIOLATION] Invalid service security_scope: ${errors.join('; ')}`);
  }
  const runtimeMissionId = String(getRegisteredEnvText('MISSION_ID') || '').trim();
  if (required && (!runtimeMissionId || runtimeMissionId !== scope.mission_id)) {
    throw new Error('[POLICY_VIOLATION] Service security_scope is not bound to the active mission');
  }
  if (context.mission_id && context.mission_id !== scope.mission_id) {
    throw new Error('[POLICY_VIOLATION] Service mission_id conflicts with security_scope');
  }
  return scope;
}

function enforceResourceIntroduction(input: ServiceAction): void {
  if (input.mode === 'OAUTH' || input.mode === 'RECONCILE') return;
  const context = input.context || {};
  const mode = (context.introduction_mode ||
    context.introductionMode ||
    'warn') as IntroductionMode;
  if (mode !== 'warn' && mode !== 'enforce') {
    throw new Error(`[POLICY_VIOLATION] Invalid introduction mode: ${String(mode)}`);
  }
  const securityScope = resolveTrustedScope(context, mode === 'enforce');
  if (!securityScope) return;
  const missionId = securityScope.mission_id;
  const resourceRef = String(context.resource_ref || context.resourceRef || '').trim();
  if (!missionId || !resourceRef) {
    if (mode === 'enforce') {
      throw new Error(
        '[POLICY_VIOLATION] Enforced service actions require mission_id and resource_ref'
      );
    }
    return;
  }
  const resourceScope = (context.resource_scope ||
    context.resourceScope ||
    (context.observation ? 'read' : input.method === 'GET' ? 'read' : 'write')) as ResourceScope;
  if (resourceScope !== 'read' && resourceScope !== 'write') {
    throw new Error(`[POLICY_VIOLATION] Invalid resource scope: ${String(resourceScope)}`);
  }
  cloudflareOsControlPlane.enforceIntroduction({
    missionId,
    taskId: String(context.task_id || context.taskId || '').trim() || undefined,
    service: input.service_id,
    resourceRef,
    scope: resourceScope,
    mode,
  });
}

function prepareServiceObservation(input: ServiceAction): PreparedObservation | null {
  const context = input.context || {};
  const observation = context.observation;
  if (!observation || typeof observation !== 'object') return null;
  const scope = resolveTrustedScope(context, true);
  if (!scope) return null;
  const resourceRef = String(
    (observation as Record<string, unknown>).resource_ref ||
      (observation as Record<string, unknown>).resourceRef ||
      context.resource_ref ||
      context.resourceRef ||
      ''
  ).trim();
  if (!resourceRef) {
    throw new Error('[POLICY_VIOLATION] Service observations require resource_ref');
  }
  const tier = scope.read_tiers.reduce<OsKnowledgeTier>(
    (highest, candidate) =>
      candidate === 'personal' || (candidate === 'confidential' && highest === 'public')
        ? candidate
        : highest,
    'public'
  );
  const summary = String(
    (observation as Record<string, unknown>).summary || `${input.service_id}:${input.action}`
  ).slice(0, 240);
  return {
    missionId: scope.mission_id,
    taskId: String(context.task_id || context.taskId || '').trim() || undefined,
    service: input.service_id,
    resourceRef,
    tier,
    tenantSlug: scope.tenant_id,
    purpose: scope.purpose,
    summary,
  };
}

function prepareServiceEgressContext(input: ServiceAction): EgressPayloadContext | undefined {
  const context = input.context || {};
  const scope = resolveTrustedScope(context, false);
  if (!scope) return undefined;

  const resourceScope = (context.resource_scope ||
    context.resourceScope ||
    (context.observation ? 'read' : input.method === 'GET' ? 'read' : 'write')) as ResourceScope;
  if (resourceScope !== 'write') return undefined;

  const provenance = cloudflareOsControlPlane.projectTaint(scope.mission_id);
  return {
    tier: provenance.highestTier,
    tenant_slug: scope.tenant_id,
    purpose: scope.purpose,
    provenance,
  };
}

function recordServiceObservation(observation: PreparedObservation | null, _result: unknown): void {
  if (!observation) return;
  try {
    cloudflareOsControlPlane.recordObservation({ ...observation });
  } catch (error) {
    // The external operation has already completed. Do not throw into the
    // governed retry loop and duplicate a side effect; preserve the failure
    // as an operational warning for the audit/recovery path.
    logger.warn(
      `[service-actuator] observation recording failed after service execution: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function reconcileServices(input: ServiceAction) {
  const manifestPath = resolveServiceRepositoryPath(input.params.manifest_path);
  let manifest: ServiceManifest | null;
  try {
    const catalog = serviceManifestCatalogAtPath(manifestPath);
    catalog.reset();
    manifest = parseServiceManifest(catalog.load());
  } catch {
    manifest = null;
  }
  if (!manifest) {
    throw new Error(`Service manifest has an invalid shape: ${manifestPath}`);
  }
  const pids = loadPids();
  let changed = false;

  for (const [id, pid] of Object.entries(pids)) {
    if (!isRunning(pid)) {
      unregisterServiceRuntime(id);
      delete pids[id];
      changed = true;
    } else {
      registerServiceRuntime(id, pid as number, manifestPath);
    }
  }

  for (const [id, service] of Object.entries(manifest)) {
    if (!pids[id] || !isRunning(pids[id])) {
      const authRes = await validateServiceAuth(id, service.preset_path);
      if (!authRes.valid) {
        logger.error(
          `⚠️ [RECONCILE] Auth validation failed for ${id}: ${authRes.reason}. Skipping start.`
        );
        continue;
      }

      await startService(id, service, pids);
      if (pids[id]) emitRecoveryStimulus(id);
      changed = true;
    } else {
      registerServiceRuntime(id, pids[id], manifestPath);
    }
  }

  if (input.params.cleanup) {
    for (const [id, pid] of Object.entries(pids)) {
      if (!manifest[id]) {
        if (isRunning(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch (_) {
            /* best-effort cleanup */
          }
          logger.info(`  - ${id} stopped (not in manifest).`);
        }
        stopManagedProcess(serviceResourceId(id), null);
        unregisterServiceRuntime(id);
        delete pids[id];
        changed = true;
      }
    }
  }

  if (changed) savePids(pids);
  return { status: 'reconciled', active_services: Object.keys(pids) };
}

async function executeApiRequest(input: ServiceAction) {
  const binding = input.auth
    ? resolveServiceBinding(input.service_id, input.auth)
    : resolveServiceBinding(input.service_id, 'none');
  const token: string | null = binding.accessToken || null;
  const baseUrl = resolveServiceBaseUrl(input.service_id);
  const httpMethod = input.method || (input.params ? 'POST' : 'GET');
  return await retry(async () => {
    return await secureFetch({
      method: httpMethod,
      url: `${baseUrl}/${input.action}`,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      data: httpMethod !== 'GET' ? input.params : undefined,
      params: httpMethod === 'GET' ? input.params : undefined,
    });
  }, buildPipelineRetryPolicy(input.params?.retry));
}

async function executeCliRequest(input: ServiceAction) {
  assertUnsafeCliAllowed();
  const serviceConfig = loadServiceEndpointsCatalog().services[input.service_id];
  const servicePreset = serviceConfig?.preset_path
    ? getServicePresetRecord(input.service_id, serviceConfig.preset_path)
    : null;
  if (servicePreset?.operations?.[input.action]) {
    try {
      const presetResult = await executeServicePreset(
        input.service_id,
        input.action,
        input.params,
        input.auth === 'secret-guard' ? 'secret-guard' : 'none'
      );
      return presetResult;
    } catch (_) {
      logger.info(
        `  - CLI preset delegation failed for ${input.service_id}:${input.action}; falling back to raw CLI.`
      );
    }
  }
  const cliBin = `${input.service_id}`;
  const args = [input.action, ...Object.values(input.params)];
  logger.info(`⌨️  [CLI] Executing: ${cliBin} ${args.join(' ')}`);
  return { output: safeExec(cliBin, args as string[]) };
}

function isUnsafeCliAllowed(): boolean {
  return getRegisteredEnv<boolean>('KYBERION_ALLOW_UNSAFE_CLI', { defaultValue: false }) === true;
}

function assertUnsafeCliAllowed() {
  if (!isUnsafeCliAllowed()) {
    throw new Error(
      '[SECURITY] CLI execution disabled. Set KYBERION_ALLOW_UNSAFE_CLI=true to enable.'
    );
  }
}
