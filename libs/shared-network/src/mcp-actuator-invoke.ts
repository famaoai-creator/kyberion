/**
 * Bounded actuator.invoke for the Kyberion MCP facade.
 * Only catalog allowlisted (actuator, op) pairs may run; default mode is dry_run.
 */
import * as path from 'node:path';
import {
  loadActuatorManifest,
  type ActuatorManifestFile,
} from '@agent/core/actuator-manifest-index';
import { planActuatorDryRun, resolveCliActionKind } from '@agent/core/actuator-sdk';
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
import { executeServicePreset } from '@agent/core/service-engine';

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

function assertOpDeclared(manifest: ActuatorManifestFile, op: string): void {
  const ops = (manifest.capabilities || [])
    .map((capability) => (typeof capability.op === 'string' ? capability.op : ''))
    .filter(Boolean);
  if (ops.length > 0 && !ops.includes(op)) {
    throw new Error(
      `[MCP_ACTUATOR_OP_UNKNOWN] actuator '${manifest.actuator_id || 'unknown'}' does not declare op '${op}'`
    );
  }
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
}): Record<string, unknown> {
  const payload = { action: args.op, op: args.op, params: args.params };
  const kind = resolveCliActionKind(payload);
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
  assertOpDeclared(manifest, op);

  if (mode === 'dry_run' || entry.execution === 'dry_run') {
    return {
      ...evaluateDryRun({ actuatorId: actuator, op, params, manifest }),
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
    const payload = { action: op, op, params };
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
