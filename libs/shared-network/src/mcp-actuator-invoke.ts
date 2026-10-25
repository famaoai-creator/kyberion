/**
 * Bounded actuator.invoke for the Kyberion MCP facade.
 * Only catalog allowlisted (actuator, op) pairs may run; default mode is dry_run.
 */
import * as path from 'node:path';
import {
  loadActuatorManifest,
  type ActuatorManifestFile,
} from '@agent/core/actuator-manifest-index';
import {
  actuatorManifestAcceptsPipeline,
  buildSingleOpPipelinePayload,
  planActuatorDryRun,
  resolveCliActionKind,
} from '@agent/core/actuator/actuator-sdk';
import type { ActuatorOpDiscoveryOperation } from '@agent/core/actuator/actuator-op-discovery';
import { loadMcpActuatorOpDiscovery, lookupDiscoveryOpEntry } from './mcp-actuator-discovery.js';
import { createAjv } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExec,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { executeServicePreset } from '@agent/core/service/service-engine';

export type ActuatorInvokeAllowlistEntry = {
  actuator: string;
  op: string;
  risk_class?: 'low' | 'medium' | 'high' | 'critical';
  requires_approval?: boolean;
  execution?: 'dry_run' | 'service_preset' | 'actuator_cli';
  notes?: string;
};

export type ActuatorInvokeMode = 'dry_run' | 'live';

function resolveManifest(actuatorId: string): ActuatorManifestFile {
  const manifestPath = assertSafeRepositoryPath(
    path.join(pathResolver.rootDir(), 'libs/actuators', actuatorId, 'manifest.json'),
    { allowMissingLeaf: false }
  );
  return loadActuatorManifest(manifestPath);
}

type ResolvedOpDeclaration = {
  declaredIn: 'manifest' | 'discovery';
  discovery?: ActuatorOpDiscoveryOperation;
};

/**
 * Pipeline-style actuators declare only `pipeline` in manifest.json while the
 * real single-op surface lives in actuator-op-discovery.json — the same merge
 * the playground applies, so an op that resolves there is declared here too.
 * Both the manifest actuator_id and the requested directory name are lookup
 * keys, matching the capability.list merge.
 */
function resolveDeclaredOp(
  manifest: ActuatorManifestFile,
  actuatorId: string,
  op: string
): ResolvedOpDeclaration {
  const ops = (manifest.capabilities || [])
    .map((capability) => (typeof capability.op === 'string' ? capability.op : ''))
    .filter(Boolean);
  if (ops.includes(op)) return { declaredIn: 'manifest' };
  const catalog = loadMcpActuatorOpDiscovery();
  const discovery = catalog
    ? lookupDiscoveryOpEntry(catalog, [manifest.actuator_id || '', actuatorId].filter(Boolean), op)
    : null;
  if (discovery) return { declaredIn: 'discovery', discovery };
  if (ops.length > 0) {
    throw new Error(
      `[MCP_ACTUATOR_OP_UNKNOWN] actuator '${manifest.actuator_id || 'unknown'}' does not declare op '${op}'` +
        (catalog ? '' : ' (actuator-op-discovery catalog unavailable)')
    );
  }
  return { declaredIn: 'manifest' };
}

/**
 * A discovery-only op on a pipeline-driven actuator must go in as the one-step
 * pipeline envelope production executes; actuators without a `pipeline` entry
 * dispatch single actions directly and stay bare.
 */
function buildInvokePayload(args: {
  op: string;
  params: Record<string, unknown>;
  manifest: ActuatorManifestFile;
  resolved: ResolvedOpDeclaration;
}): Record<string, unknown> {
  if (args.resolved.declaredIn === 'discovery' && actuatorManifestAcceptsPipeline(args.manifest)) {
    return buildSingleOpPipelinePayload(
      args.op,
      args.params,
      args.resolved.discovery?.kind ?? 'capture'
    );
  }
  return { action: args.op, op: args.op, params: args.params };
}

function findAllowlistEntry(
  allowlist: readonly ActuatorInvokeAllowlistEntry[],
  actuator: string,
  op: string
): ActuatorInvokeAllowlistEntry {
  const entry = allowlist.find((item) => item.actuator === actuator && item.op === op);
  if (!entry) {
    throw new Error(
      `[MCP_ACTUATOR_NOT_ALLOWLISTED] ${actuator}:${op} is not on actuator_invoke_allowlist; use kyberion.capability.search`
    );
  }
  return entry;
}

function evaluateDryRun(args: {
  actuatorId: string;
  op: string;
  params: Record<string, unknown>;
  manifest: ActuatorManifestFile;
  resolved: ResolvedOpDeclaration;
}): Record<string, unknown> {
  const payload = buildInvokePayload(args);
  // A bare discovery-only op carries its declared kind — the action-name
  // heuristic inside resolveCliActionKind only knows manifest-era names.
  const discoveryKind = args.resolved.discovery?.kind;
  const kind =
    args.resolved.declaredIn === 'discovery' &&
    !actuatorManifestAcceptsPipeline(args.manifest) &&
    (discoveryKind === 'capture' ||
      discoveryKind === 'apply' ||
      discoveryKind === 'transform' ||
      discoveryKind === 'control')
      ? discoveryKind
      : resolveCliActionKind(payload);
  const plan = planActuatorDryRun({ kind, dryRun: true });
  let validated = true;
  let error: string | undefined;
  const schemaRef = args.manifest.contract_schema;
  if (typeof schemaRef === 'string' && schemaRef) {
    try {
      const ajv = createAjv();
      const validate = compileSchemaFromPath(ajv, pathResolver.rootResolve(schemaRef));
      if (!validate(payload)) {
        validated = false;
        error = (validate.errors || [])
          .map((item) => `${item.instancePath || '/'} ${item.message || 'is invalid'}`)
          .join('; ');
      }
    } catch (err) {
      validated = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const inputSchema = args.resolved.discovery?.input_schema as Record<string, unknown> | undefined;
  // Same rule as the playground: inferred/legacy schemas are hints, not
  // authoritative contracts — only authored schemas gate the dry run.
  const marker = inputSchema?.['x-kyberion-contract'];
  if (validated && inputSchema && marker !== 'legacy-open' && marker !== 'inferred-legacy') {
    try {
      const ajv = createAjv();
      const validate = ajv.compile(inputSchema);
      if (!validate(args.params)) {
        validated = false;
        error = (validate.errors || [])
          .map((item) => `params${item.instancePath || '/'} ${item.message || 'is invalid'}`)
          .join('; ');
      }
    } catch (err) {
      validated = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    ok: validated,
    mode: 'dry_run',
    actuator_id: args.actuatorId,
    op: args.op,
    kind,
    dry_run: true,
    handler: plan.skipHandler ? 'skipped' : 'capture',
    validated,
    ...(error ? { error } : {}),
    payload,
  };
}

function resolveActuatorCli(actuatorId: string): string {
  const candidates = [
    path.join(pathResolver.rootDir(), 'dist/libs/actuators', actuatorId, 'src/index.js'),
    path.join(pathResolver.rootDir(), 'dist/libs/actuators', actuatorId, 'index.js'),
  ];
  for (const candidate of candidates) {
    try {
      const safe = assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
      if (safeExistsSync(safe) && safeLstat(safe).isFile()) return safe;
    } catch {
      // try next
    }
  }
  throw new Error(
    `[MCP_ACTUATOR_CLI_MISSING] compiled actuator CLI not found for '${actuatorId}' (run pnpm build)`
  );
}

export async function invokeAllowlistedActuator(input: {
  actuator: string;
  op: string;
  params?: Record<string, unknown>;
  mode?: ActuatorInvokeMode;
  allowlist: readonly ActuatorInvokeAllowlistEntry[];
  callerRole: string;
  approvalGranted?: boolean;
}): Promise<Record<string, unknown>> {
  const actuator = String(input.actuator || '').trim();
  const op = String(input.op || '').trim();
  if (!actuator || !op) throw new Error('actuator and op are required');
  const entry = findAllowlistEntry(input.allowlist, actuator, op);
  const mode: ActuatorInvokeMode = input.mode === 'live' ? 'live' : 'dry_run';
  const params = input.params && typeof input.params === 'object' ? input.params : {};
  const manifest = resolveManifest(actuator);
  const resolved = resolveDeclaredOp(manifest, actuator, op);

  if (mode === 'dry_run' || entry.execution === 'dry_run') {
    return {
      ...evaluateDryRun({ actuatorId: actuator, op, params, manifest, resolved }),
      allowlist: { risk_class: entry.risk_class || 'medium', notes: entry.notes || null },
    };
  }

  if (input.callerRole !== 'operator') {
    throw new Error(
      '[MCP_ACTUATOR_LIVE_DENIED] live actuator.invoke requires caller role operator'
    );
  }

  if (entry.requires_approval === true && input.approvalGranted !== true) {
    throw new Error(
      '[MCP_ACTUATOR_APPROVAL_REQUIRED] live actuator.invoke requires human approval'
    );
  }

  const execution = entry.execution || 'actuator_cli';
  if (execution === 'service_preset') {
    const serviceId = String(params.service_id || params.service || '').trim();
    const action = String(params.action || op).trim();
    if (!serviceId) throw new Error('service_preset execution requires params.service_id');
    const result = await executeServicePreset(serviceId, action, params, 'secret-guard');
    return {
      ok: true,
      mode: 'live',
      actuator_id: actuator,
      op,
      execution: 'service_preset',
      result,
    };
  }

  if (execution === 'actuator_cli') {
    const execPath = resolveActuatorCli(actuator);
    const tmpDir = pathResolver.sharedTmp('mcp-actuator-invoke');
    const inputPath = path.join(tmpDir, `${actuator}-${Date.now()}.json`);
    if (!safeExistsSync(tmpDir)) safeMkdir(tmpDir, { recursive: true });
    const payload = buildInvokePayload({ op, params, manifest, resolved });
    safeWriteFile(inputPath, `${JSON.stringify(payload, null, 2)}\n`);
    const output = safeExec('node', [execPath, '--input', inputPath], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 60_000,
      maxOutputMB: 5,
    });
    return {
      ok: true,
      mode: 'live',
      actuator_id: actuator,
      op,
      execution: 'actuator_cli',
      output,
    };
  }

  throw new Error(`[MCP_ACTUATOR_EXECUTION_UNKNOWN] unsupported execution '${execution}'`);
}

/** Test helper: load allowlist shape from catalog-like object. */
export function readActuatorInvokeAllowlist(catalog: {
  actuator_invoke_allowlist?: ActuatorInvokeAllowlistEntry[];
}): ActuatorInvokeAllowlistEntry[] {
  return Array.isArray(catalog.actuator_invoke_allowlist) ? catalog.actuator_invoke_allowlist : [];
}
