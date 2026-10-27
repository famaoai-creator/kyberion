import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExec,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  loadActuatorManifest,
  type ActuatorManifestFile,
} from '@agent/core/actuator-manifest-index';
import {
  ACTUATOR_PIPELINE_STEP_TYPES,
  actuatorManifestAcceptsPipeline,
  buildSingleOpPipelinePayload,
  planActuatorDryRun,
  resolveCliActionKind,
  type ActuatorPipelineStepType,
} from '@agent/core/actuator/actuator-sdk';
import { createAjv, nowIso, readJsonIfPresent, slugify, writeJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import { determineActuatorStepType } from '@agent/core/actuator/actuator-op-registry';
import {
  ROLE_FROM_TYPE,
  validatePipelineAdf,
  type PipelineAdf,
} from '@agent/core/pipeline/pipeline-contract';
import {
  loadActuatorOpDiscoveryAtPath,
  type ActuatorOpDiscoveryOperation,
} from '@agent/core/actuator/actuator-op-discovery';
import * as readline from 'node:readline';
import chalk from 'chalk';
import * as path from 'node:path';
import {
  defineScript,
  isDirectScript,
  ScriptExitError,
  stripSharedScriptFlags,
} from './lib/harness.js';
import {
  parseSafeJsonInput,
  parseSafeJsonObjectInput,
  readSafeJsonFile,
} from './lib/json-input.js';

type Print = (value: unknown) => void;

const PLAYGROUND_USAGE = `Usage: pnpm playground -- [options]

Discovery (read-only — never builds, writes scratch files, or invokes a handler):
  --list [--actuator <id>] [--op <op>] [--search <text>] [--json]
  --actuator <id> --op <op> --describe [--json]

Try a single op:
  --actuator <id> --op <op> [--params '<json>' | --params @file.json]
  --check    validate schema + contract only; never invokes a handler
  --dry-run  capture ops run the handler; apply/transform/control validate only
  (neither)  live execution

Record a session of successful live runs and emit a PipelineAdf draft:
  --record <name>            append this run's step to session <name> (live runs only)
  --record <name> --reset    clear session <name> before this run
  --emit-adf <name>          write active/shared/tmp/actuator-playground/<name>.adf.json
      [--name <slug>]        pipeline_id/name override (default: session name)
      [--out <path>]         output path override (repo-relative)
  Next step: pnpm pipeline:promote --input <adf>.json --source-is-public

Other flags: --json (machine output) --quiet --help
No flags:    interactive wizard

Examples:
  pnpm playground -- --list --search browser --json
  pnpm playground -- --actuator file-actuator --op read --describe --json
  pnpm playground -- --actuator file-actuator --op read --params '{"path":"package.json"}' --check
  pnpm playground -- --record login-flow --actuator browser-actuator --op goto --params '{"url":"https://example.com"}'
  pnpm playground -- --emit-adf login-flow`;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

function parseCliArgs(args: string[]) {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      parsed[key] = value;
    }
  }
  return parsed;
}

function tryCoerceValue(val: string): any {
  if (val.toLowerCase() === 'true') return true;
  if (val.toLowerCase() === 'false') return false;
  if (!isNaN(Number(val)) && val !== '') return Number(val);
  if (val.startsWith('{') || val.startsWith('[')) {
    try {
      return parseSafeJsonInput(val, 'actuator parameter');
    } catch (_) {
      // Fallback to string if parsing fails
    }
  }
  return val;
}

export function parsePlaygroundParams(raw: string, label = '--params'): Record<string, unknown> {
  return parseSafeJsonObjectInput(raw, label) || {};
}

/**
 * `--params @path/to/file.json` loads the parameter object from a repository
 * file — useful for payloads too large to paste inline. Anything else is
 * parsed as inline JSON.
 */
export function resolvePlaygroundParamsInput(raw: string): Record<string, unknown> {
  if (!raw.startsWith('@')) return parsePlaygroundParams(raw);
  const filePath = assertSafeRepositoryPath(pathResolver.rootResolve(raw.slice(1)));
  return readSafeJsonFile<Record<string, unknown>>(filePath, '--params file');
}

export function buildPlaygroundPayload(
  operation: string,
  params: Record<string, unknown>,
  flat = false
): Record<string, unknown> {
  if (flat) {
    // Flat contracts (build ops, `pipeline` envelopes) declare op fields at the
    // top level; keep the `params` bag nested otherwise.
    return { action: operation, op: operation, ...params };
  }
  return {
    action: operation,
    op: operation,
    params,
  };
}

/**
 * True when the contract schema declares op fields flat at the top level
 * (e.g. build-pipeline `{op, project_dir, ...}` or `pipeline` envelopes
 * `{action, steps, ...}`) instead of a nested `params` object. oneOf/anyOf
 * per-action schemas keep the nested convention.
 */
export function contractSchemaUsesFlatParams(contractSchemaPath?: string): boolean {
  if (!contractSchemaPath) return false;
  try {
    const raw = safeReadFile(pathResolver.rootResolve(contractSchemaPath));
    const schema = JSON.parse(String(raw));
    if (schema?.oneOf || schema?.anyOf) return false;
    const props = schema?.properties;
    if (!props || typeof props !== 'object') return false;
    if ('params' in props) return false;
    return 'steps' in props || 'op' in props;
  } catch {
    return false;
  }
}

/**
 * Contract schemas disagree on the discriminator key: newer authored schemas
 * require `{op, params}` while legacy handlers read `action`, and some schemas
 * (e.g. working-memory) declare op fields flat at the top level. Try the wire
 * payload first, then normalized variants, so the compatibility shim keys do
 * not fail strict `additionalProperties` schemas.
 */
export function buildContractValidationCandidates(
  payload: Record<string, unknown>
): Array<Record<string, unknown>> {
  const params =
    payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
      ? (payload.params as Record<string, unknown>)
      : {};
  const candidates: Array<Record<string, unknown>> = [payload];
  const push = (candidate: Record<string, unknown>) => {
    const key = JSON.stringify(candidate);
    if (!candidates.some((existing) => JSON.stringify(existing) === key)) {
      candidates.push(candidate);
    }
  };
  for (const [field, value] of [
    ['op', payload.op],
    ['action', payload.action],
  ] as const) {
    if (typeof value !== 'string' || value === '') continue;
    push({ [field]: value, params });
    push({ [field]: value, ...params });
    push({ [field]: value });
  }
  return candidates;
}

/**
 * Merge manifest capabilities with fine-grained describeOps from the
 * generated discovery index. Pipeline-style actuators (file/browser/media)
 * expose only `pipeline` in manifest.json while describeOps lists the real
 * single-op surface (e.g. file:read). Without this merge the playground
 * rejects valid ops with "Machine mode requires --op".
 */
export function loadDiscoveryOpsForActuator(actuatorId: string, dirId = ''): string[] {
  return loadDiscoveryOpDetailsForActuator(actuatorId, dirId).map((entry) => entry.op);
}

export function loadDiscoveryOpDetailsForActuator(
  actuatorId: string,
  dirId = ''
): ActuatorOpDiscoveryOperation[] {
  const catalog = loadActuatorOpDiscoveryAtPath();
  const match = catalog.actuators.find(
    (entry) =>
      entry?.n === actuatorId ||
      (dirId !== '' && (entry?.n === dirId || entry?.path?.endsWith(`/${dirId}`)))
  );
  return match?.ops || [];
}

export function lookupDiscoveryOpKind(actuatorId: string, op: string, dirId = ''): string | null {
  const details = loadDiscoveryOpDetailsForActuator(actuatorId, dirId);
  return details.find((entry) => entry.op === op)?.kind ?? null;
}

/**
 * Actuators whose CLI boundary accepts `{action:"pipeline", steps:[...]}`
 * (pure pipeline-driven like file/network/media, or mixed like browser/code).
 * A bare `{action:"read"}` fails there with "pure pipeline-driven" — wrap a
 * single describeOps selection into a one-step pipeline so playground try-out
 * matches the real ADF step shape. Actuators without a `pipeline` entry
 * (agent/secret/…) dispatch single actions directly and must NOT be wrapped.
 */
export function actuatorAcceptsPipeline(manifest: ActuatorManifestFile): boolean {
  return actuatorManifestAcceptsPipeline(manifest);
}
export function buildPipelineWrappedPayload(
  op: string,
  params: Record<string, unknown>,
  kind: string
): Record<string, unknown> {
  return buildSingleOpPipelinePayload(op, params, kind);
}

export function resolvePlaygroundCapabilities(
  manifest: ActuatorManifestFile,
  dirId = ''
): ActuatorManifestFile['capabilities'] {
  const base = Array.isArray(manifest.capabilities) ? [...manifest.capabilities] : [];
  const seen = new Set(base.map((capability) => capability.op));
  for (const op of loadDiscoveryOpsForActuator(manifest.actuator_id, dirId)) {
    if (seen.has(op)) continue;
    seen.add(op);
    base.push({ op, platforms: [] });
  }
  return base;
}

/**
 * Live secret:set with a value must go through `kyberion secret introduce` /
 * Concierge — playground may only dry-run / check that path.
 */
export function assertPlaygroundSecretMutationAllowed(args: {
  actuatorId: string;
  operation: string;
  params: Record<string, unknown>;
  dryRun?: boolean;
  check?: boolean;
}): void {
  const actuatorId = String(args.actuatorId || '').toLowerCase();
  const operation = String(args.operation || '').toLowerCase();
  if (actuatorId !== 'secret-actuator' || operation !== 'set') return;
  if (args.dryRun === true || args.check === true) return;
  if (typeof args.params?.value === 'string' && args.params.value.length > 0) {
    throw new Error(
      '[PLAYGROUND_SECRET_SET_BLOCKED] Live secret:set with a value is not allowed in playground. ' +
        'Use `pnpm kyberion secret introduce <serviceId> <secretKey>` or Concierge Introduce secret. ' +
        'Dry-run/check without applying a value remains available.'
    );
  }
}

// --- Session recording → ADF emit -------------------------------------
// `pnpm playground -- --record <name>` appends each successful live run to a
// session file; `--emit-adf <name>` converts the recorded steps into a
// PipelineAdf draft (`domain:op` + Typed Flow role) that `pnpm pipeline:promote`
// can lift into pipelines/. Session files and drafts stay on the scratch floor
// (active/shared/tmp/actuator-playground/) — review them before promoting.

const PLAYGROUND_SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** Param keys whose recorded values are replaced by {{placeholders}} on emit. */
const SENSITIVE_PARAM_KEY =
  /pass|secret|token|otp|credential|api[-_]?key|private[-_]?key|cookie|authorization/i;
/** Manifest-boundary ops that dispatch as ADF step ops without a registry row. */
const NON_REGISTRY_STEP_OPS = new Set(['pipeline']);

export interface PlaygroundRecordedStep {
  id: string;
  actuator_id: string;
  domain: string;
  op: string;
  kind: string;
  params: Record<string, unknown>;
  recorded_at: string;
}

interface PlaygroundSessionFile {
  session: string;
  created_at: string;
  steps: PlaygroundRecordedStep[];
}

/** ADF domain prefix for an actuator (`browser-actuator` → `browser`). */
export function resolveActuatorDomain(actuatorId: string): string {
  return actuatorId.replace(/-actuator$/u, '');
}

function playgroundScratchDir(scratchDir?: string): string {
  return scratchDir ?? pathResolver.sharedTmp('actuator-playground');
}

export function resolvePlaygroundSessionPath(session: string, scratchDir?: string): string {
  if (!PLAYGROUND_SESSION_NAME.test(session)) {
    throw new Error(`Invalid session name '${session}' (use letters, digits, ., _, -).`);
  }
  return assertSafeRepositoryPath(
    path.join(playgroundScratchDir(scratchDir), 'sessions', `${session}.json`),
    { allowMissingLeaf: true }
  );
}

function loadPlaygroundSession(
  session: string,
  scratchDir?: string
): { filePath: string; file: PlaygroundSessionFile } {
  const filePath = resolvePlaygroundSessionPath(session, scratchDir);
  const file = readJsonIfPresent<PlaygroundSessionFile>(filePath) ?? {
    session,
    created_at: nowIso(),
    steps: [],
  };
  if (!Array.isArray(file.steps)) file.steps = [];
  return { filePath, file };
}

function writePlaygroundJson(filePath: string, value: unknown): void {
  safeMkdir(path.dirname(filePath), { recursive: true });
  writeJson(filePath, value);
}

export function resetPlaygroundSession(session: string, scratchDir?: string): void {
  const { filePath } = loadPlaygroundSession(session, scratchDir);
  writePlaygroundJson(filePath, { session, created_at: nowIso(), steps: [] });
}

export function recordPlaygroundStep(
  session: string,
  entry: Omit<PlaygroundRecordedStep, 'id' | 'recorded_at'>,
  scratchDir?: string
): PlaygroundSessionFile {
  const { filePath, file } = loadPlaygroundSession(session, scratchDir);
  const ordinal = file.steps.length + 1;
  file.steps.push({
    ...entry,
    id: `step-${ordinal}-${entry.op}`,
    recorded_at: nowIso(),
  });
  writePlaygroundJson(filePath, file);
  return file;
}

function sanitizeRecordedParams(value: unknown, placeholders: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRecordedParams(item, placeholders));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' && SENSITIVE_PARAM_KEY.test(key)) {
        const name = key.replace(/[^a-zA-Z0-9_]/g, '_');
        placeholders.set(name, key);
        out[key] = `{{${name}}}`;
      } else {
        out[key] = sanitizeRecordedParams(item, placeholders);
      }
    }
    return out;
  }
  return value;
}

/**
 * Convert a recorded session into a PipelineAdf draft. Steps carry the Typed
 * Flow role mapped from the recorded op kind, and sensitive param values are
 * replaced by {{placeholders}} declared in `parameters`.
 */
export function buildSessionAdf(
  session: PlaygroundSessionFile,
  options: { name?: string } = {}
): { adf: PipelineAdf; redacted_keys: string[]; unverified_ops: string[] } {
  const placeholders = new Map<string, string>();
  const unverified = new Set<string>();
  const steps = session.steps.map((step) => {
    const qualifiedOp = `${step.domain}:${step.op}`;
    if (!NON_REGISTRY_STEP_OPS.has(step.op)) {
      try {
        determineActuatorStepType(step.domain, step.op);
      } catch {
        unverified.add(qualifiedOp);
      }
    }
    return {
      id: step.id,
      role: ROLE_FROM_TYPE[step.kind] ?? 'sink',
      op: qualifiedOp,
      params: sanitizeRecordedParams(step.params, placeholders) as Record<string, unknown>,
    };
  });
  const slug = slugify(options.name || session.session) || 'playground-session';
  const adf: Record<string, unknown> = {
    action: 'pipeline',
    pipeline_id: slug,
    name: slug,
    description:
      `Recorded from playground session '${session.session}' (${steps.length} step(s)). ` +
      `Review steps and params before promoting.`,
    steps,
  };
  if (session.steps.some((step) => step.domain === 'browser')) {
    adf.session_id = session.session;
  }
  if (placeholders.size > 0) {
    adf.parameters = Object.fromEntries(
      [...placeholders.keys()].map((key) => [
        key,
        {
          type: 'string',
          description: 'Redacted playground param value — supply at run time.',
        },
      ])
    );
  }
  return {
    adf: adf as unknown as PipelineAdf,
    redacted_keys: [...placeholders.keys()],
    unverified_ops: [...unverified],
  };
}

export function emitPlaygroundSessionAdf(args: {
  session: string;
  name?: string;
  out?: string;
  scratchDir?: string;
}): {
  output_path: string;
  steps: number;
  redacted_keys: string[];
  unverified_ops: string[];
  adf: PipelineAdf;
} {
  const { file } = loadPlaygroundSession(args.session, args.scratchDir);
  if (file.steps.length === 0) {
    throw new Error(
      `Playground session '${args.session}' has no recorded steps. ` +
        `Record with: pnpm playground -- --record ${args.session} --actuator <id> --op <op> --params '{...}'`
    );
  }
  const { adf, redacted_keys, unverified_ops } = buildSessionAdf(file, { name: args.name });
  validatePipelineAdf(adf);
  const outPath = args.out
    ? assertSafeRepositoryPath(pathResolver.rootResolve(args.out), { allowMissingLeaf: true })
    : assertSafeRepositoryPath(
        path.join(playgroundScratchDir(args.scratchDir), `${file.session}.adf.json`),
        { allowMissingLeaf: true }
      );
  writePlaygroundJson(outPath, adf);
  return { output_path: outPath, steps: file.steps.length, redacted_keys, unverified_ops, adf };
}

export function evaluatePlaygroundDryRun(args: {
  actuatorId: string;
  operation: string;
  payload: Record<string, unknown>;
  contractSchemaPath?: string;
  inputSchema?: Record<string, unknown>;
  params?: Record<string, unknown>;
  /** Discovery-registry kind; when absent the payload heuristic decides. */
  kind?: string;
  mode?: 'dry-run' | 'check';
}): Record<string, unknown> {
  const kind = (
    args.kind && (ACTUATOR_PIPELINE_STEP_TYPES as readonly string[]).includes(args.kind)
      ? args.kind
      : resolveCliActionKind(args.payload)
  ) as ActuatorPipelineStepType;
  const plan = planActuatorDryRun({ kind, dryRun: true });
  let validated = true;
  let error: string | undefined;
  const marker = args.inputSchema?.['x-kyberion-contract'];
  const authoredSchema =
    args.inputSchema && marker !== 'legacy-open' && marker !== 'inferred-legacy'
      ? args.inputSchema
      : undefined;
  if (authoredSchema) {
    try {
      const validate = createAjv().compile(authoredSchema);
      if (!validate(args.params)) {
        validated = false;
        error = (validate.errors || [])
          .map(
            (item) =>
              `${item.instancePath || '/'} ${item.message || 'is invalid'} ${JSON.stringify(item.params)}`
          )
          .join('; ');
      }
    } catch (err) {
      validated = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }
  if (args.contractSchemaPath) {
    try {
      const ajv = createAjv();
      const schemaPath = pathResolver.rootResolve(args.contractSchemaPath);
      const validate = compileSchemaFromPath(ajv, schemaPath);
      let matched = false;
      for (const candidate of buildContractValidationCandidates(args.payload)) {
        if (validate(candidate)) {
          matched = true;
          break;
        }
      }
      if (!matched) {
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
    mode: args.mode ?? 'dry-run',
    actuator_id: args.actuatorId,
    operation: args.operation,
    kind,
    dry_run: true,
    handler: plan.skipHandler ? 'skipped' : 'capture',
    validated,
    parameter_validation: authoredSchema ? 'authored-schema' : 'not-available',
    ...(error ? { error } : {}),
    payload: args.payload,
  };
}

export type PlaygroundExecuteActuator = (args: {
  execPath: string;
  inputPath: string;
  extraArgs: string[];
}) => string;

interface PlaygroundRunOptions {
  dryRun?: boolean;
  check?: boolean;
  json?: boolean;
  quiet?: boolean;
  print?: Print;
  /** Test seam: skip dist lookup. */
  resolveExecutable?: (actuatorId: string) => string | null;
  /** Test seam: intercept the compiled actuator process. */
  executeActuator?: PlaygroundExecuteActuator;
  /** Test seam: redirect the scratch dir used for session files and ADF drafts. */
  scratchDir?: string;
}

function defaultExecuteActuator(args: {
  execPath: string;
  inputPath: string;
  extraArgs: string[];
}): string {
  return safeExec('node', [args.execPath, '--input', args.inputPath, ...args.extraArgs], {
    cwd: pathResolver.rootDir(),
  });
}

export async function runPlayground(
  args: string[],
  options: PlaygroundRunOptions = {}
): Promise<Record<string, unknown> | undefined> {
  const cliParams = parseCliArgs(args);
  const emitAdfOnly = cliParams['emit-adf'] !== undefined;
  const discoveryOnly = cliParams.list !== undefined || cliParams.describe !== undefined;
  const machineOutput =
    discoveryOnly ||
    emitAdfOnly ||
    options.json === true ||
    options.dryRun === true ||
    options.check === true;
  const print = options.print ?? (() => undefined);
  if (cliParams.help !== undefined || args.includes('-h')) {
    rl.close();
    print(PLAYGROUND_USAGE);
    return { ok: true, mode: 'help' };
  }
  const emit = (...values: unknown[]): void => values.forEach((value) => print(value));
  const log = (...values: unknown[]) => {
    if (!machineOutput && !options.quiet) emit(...values);
  };
  const logError = (...values: unknown[]) => {
    if (!machineOutput && !options.quiet) emit(...values);
  };

  // --emit-adf needs no actuator, handler, or build — it rewrites a recorded
  // session file into a PipelineAdf draft on the scratch floor.
  if (emitAdfOnly) {
    rl.close();
    const session = cliParams['emit-adf'];
    if (session === 'true') {
      throw new ScriptExitError(1, '--emit-adf requires a session name.');
    }
    try {
      const emitted = emitPlaygroundSessionAdf({
        session,
        name: cliParams.name,
        out: cliParams.out,
        scratchDir: options.scratchDir,
      });
      const result = {
        ok: true,
        mode: 'emit-adf',
        session,
        steps: emitted.steps,
        redacted_keys: emitted.redacted_keys,
        unverified_ops: emitted.unverified_ops,
        output_path: emitted.output_path,
      };
      if (options.json) return result;
      emit(`Wrote ADF draft (${emitted.steps} step(s)): ${emitted.output_path}`);
      if (emitted.redacted_keys.length > 0) {
        emit(`Redacted sensitive params → {{placeholders}}: ${emitted.redacted_keys.join(', ')}`);
      }
      if (emitted.unverified_ops.length > 0) {
        emit(
          `⚠️  Ops not in the actuator op registry — verify they dispatch as ADF steps: ${emitted.unverified_ops.join(', ')}`
        );
      }
      emit(
        `Review the draft, then: pnpm pipeline:promote --input ${emitted.output_path} --source-is-public`
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ScriptExitError(1, message);
    }
  }

  // Fail fast on malformed session flags before any op runs.
  if (cliParams.reset !== undefined && cliParams.record === undefined) {
    rl.close();
    throw new ScriptExitError(1, '--reset requires --record <name>.');
  }
  if (cliParams.record !== undefined) {
    if (cliParams.record === 'true') {
      rl.close();
      throw new ScriptExitError(1, '--record requires a session name.');
    }
    try {
      resolvePlaygroundSessionPath(cliParams.record, options.scratchDir);
      if (cliParams.reset !== undefined) {
        resetPlaygroundSession(cliParams.record, options.scratchDir);
      }
    } catch (err) {
      rl.close();
      const message = err instanceof Error ? err.message : String(err);
      throw new ScriptExitError(1, message);
    }
  }

  log(chalk.bold.cyan('\n🛠️  [KYBERION] Actuator Playground CLI\n'));

  // 1. Scan available actuators
  const actuatorsDir = assertSafeRepositoryPath(pathResolver.rootResolve('libs/actuators'));
  const dirEntries = safeReaddir(actuatorsDir);
  const actuators: { id: string; manifestPath: string; manifest: ActuatorManifestFile }[] = [];

  for (const entry of dirEntries) {
    let manifestPath: string;
    try {
      manifestPath = assertSafeRepositoryPath(path.join(actuatorsDir, entry, 'manifest.json'), {
        allowMissingLeaf: false,
      });
    } catch {
      continue;
    }
    if (safeExistsSync(manifestPath) && safeLstat(manifestPath).isFile()) {
      try {
        const manifest = loadActuatorManifest(manifestPath);
        if (manifest && manifest.actuator_id) {
          actuators.push({
            id: entry,
            manifestPath,
            manifest,
          });
        }
      } catch (err: any) {
        // Skip invalid manifests
      }
    }
  }

  if (actuators.length === 0) {
    logError(chalk.red('❌ No valid actuators with manifest.json found in libs/actuators/'));
    rl.close();
    throw new ScriptExitError(1, 'No valid actuators with manifest.json found');
  }

  // 2. Parse CLI args for non-interactive mode
  let targetActuatorId = cliParams.actuator;
  let targetOp = cliParams.op;
  let rawParamsStr = cliParams.params;

  let selectedActuator = actuators.find(
    (a) => a.id === targetActuatorId || a.manifest.actuator_id === targetActuatorId
  );

  // Discovery never prompts, builds, writes scratch files or invokes a handler.
  if (discoveryOnly) {
    rl.close();
    if (targetActuatorId && !selectedActuator) {
      throw new ScriptExitError(1, `Unknown --actuator '${targetActuatorId}'. Use --list --json.`);
    }
    if (cliParams.describe !== undefined && (!selectedActuator || !targetOp)) {
      throw new ScriptExitError(
        1,
        '--describe requires --actuator and --op; use --list --json first.'
      );
    }
    const records = (selectedActuator ? [selectedActuator] : actuators)
      .map((actuator) => {
        const details = loadDiscoveryOpDetailsForActuator(
          actuator.manifest.actuator_id,
          actuator.id
        );
        const ops = resolvePlaygroundCapabilities(actuator.manifest, actuator.id)
          .filter((entry) => !targetOp || entry.op === targetOp)
          .filter(
            (entry) =>
              !cliParams.search ||
              `${actuator.manifest.actuator_id} ${entry.op}`
                .toLowerCase()
                .includes(cliParams.search.toLowerCase())
          )
          .map((entry) => {
            const detail = details.find((candidate) => candidate.op === entry.op);
            return {
              op: entry.op,
              ...(entry.description ? { description: entry.description } : {}),
              ...(cliParams.describe !== undefined ? detail : detail ? { kind: detail.kind } : {}),
            };
          });
        return {
          actuator_id: actuator.manifest.actuator_id,
          description: actuator.manifest.description,
          ops,
        };
      })
      .filter((entry) => entry.ops.length > 0);
    if (cliParams.describe !== undefined && records.length === 0) {
      throw new ScriptExitError(
        1,
        `Unknown --op '${targetOp}'. Use --actuator ${targetActuatorId} --list --json.`
      );
    }
    const result = {
      ok: true,
      mode: cliParams.describe !== undefined ? 'describe' : 'list',
      handler_invoked: false,
      actuators: records,
    };
    if (!options.json) emit(JSON.stringify(result, null, 2));
    return result;
  }

  // A supplied --actuator that matches nothing must not fall back silently to
  // the wizard or the generic machine-mode message — surface the name.
  if (!selectedActuator && targetActuatorId) {
    const available = actuators.map((a) => a.manifest.actuator_id).join(', ');
    if (machineOutput) {
      rl.close();
      throw new ScriptExitError(
        1,
        `Unknown --actuator '${targetActuatorId}'. Available: ${available}.`
      );
    }
    log(chalk.yellow(`⚠️  Unknown --actuator '${targetActuatorId}'. Pick one from the list.`));
  }

  // 3. Actuator Selection Wizard
  if (!selectedActuator) {
    if (machineOutput) {
      rl.close();
      throw new ScriptExitError(
        1,
        'Machine mode requires --actuator and --op; omit them only for interactive mode.'
      );
    }
    log(chalk.white('Available Actuators:'));
    actuators.forEach((act, idx) => {
      log(
        `  ${chalk.bold.cyan(idx + 1)}. ${chalk.bold(act.manifest.actuator_id)} (v${act.manifest.version})`
      );
      log(`     ${chalk.gray(act.manifest.description)}`);
    });

    const choiceStr = await question(chalk.bold.blue('\nSelect an Actuator by number or id: '));
    const idx = parseInt(choiceStr, 10) - 1;
    const pick =
      !isNaN(idx) && idx >= 0 && idx < actuators.length
        ? actuators[idx]
        : actuators.find((a) => a.id === choiceStr || a.manifest.actuator_id === choiceStr);
    if (!pick) {
      logError(chalk.red('\n❌ Invalid selection.'));
      rl.close();
      throw new ScriptExitError(1, 'Invalid actuator selection');
    }
    selectedActuator = pick;
  }

  const manifest = selectedActuator.manifest;
  log(chalk.green(`\n✓ Selected Actuator: ${chalk.bold(manifest.actuator_id)}`));

  // 4. Operation Selection Wizard
  // Manifest is coarse (pipeline-style actuators list only `pipeline`);
  // union with describeOps from the discovery index so single ops work.
  const ops = resolvePlaygroundCapabilities(manifest, selectedActuator.id);
  const opDetails = loadDiscoveryOpDetailsForActuator(manifest.actuator_id, selectedActuator.id);
  let selectedOpObj = ops.find((o) => o.op === targetOp);

  if (!selectedOpObj) {
    if (ops.length === 0) {
      logError(chalk.red(`\n❌ Actuator '${manifest.actuator_id}' defines no capabilities.`));
      rl.close();
      throw new ScriptExitError(1, `Actuator '${manifest.actuator_id}' defines no capabilities`);
    }
    if (machineOutput) {
      rl.close();
      if (!targetOp) {
        throw new ScriptExitError(1, 'Machine mode requires --op for the selected actuator.');
      }
      throw new ScriptExitError(
        1,
        `Unknown --op '${targetOp}' for '${manifest.actuator_id}'. ` +
          `Available: ${ops.map((o) => o.op).join(', ')}. ` +
          `Fine-grained ops come from knowledge/product/orchestration/actuator-op-discovery.json.`
      );
    }

    if (targetOp) {
      log(
        chalk.yellow(
          `⚠️  Unknown --op '${targetOp}' for '${manifest.actuator_id}'. Pick one from the list.`
        )
      );
    }
    log(chalk.white('\nAvailable Operations (ops):'));
    ops.forEach((opObj, idx) => {
      const kind = opDetails.find((entry) => entry.op === opObj.op)?.kind;
      const kindTag = kind ? chalk.gray(` [${kind}]`) : '';
      const desc = opObj.description ? ` - ${opObj.description}` : '';
      log(`  ${chalk.bold.cyan(idx + 1)}. ${chalk.bold(opObj.op)}${kindTag}${chalk.gray(desc)}`);
    });

    const choiceStr = await question(chalk.bold.blue('\nSelect an Operation by number or name: '));
    const idx = parseInt(choiceStr, 10) - 1;
    const pick =
      !isNaN(idx) && idx >= 0 && idx < ops.length ? ops[idx] : ops.find((o) => o.op === choiceStr);
    if (!pick) {
      logError(chalk.red('\n❌ Invalid selection.'));
      rl.close();
      throw new ScriptExitError(1, 'Invalid operation selection');
    }
    selectedOpObj = pick;
  }

  const op = selectedOpObj.op;
  const selectedOpDetail = opDetails.find((entry) => entry.op === op);
  log(chalk.green(`✓ Selected Operation: ${chalk.bold(op)}`));

  // 5. Parameter Gathering Wizard
  let paramsObject: Record<string, any> = {};

  // Surface the declared parameter surface before asking for values —
  // otherwise the wizard prompts blind key/value pairs.
  if (!machineOutput && !rawParamsStr) {
    const schema = selectedOpDetail?.input_schema;
    const properties =
      schema?.properties && typeof schema.properties === 'object'
        ? Object.keys(schema.properties as Record<string, unknown>)
        : [];
    const required = Array.isArray(schema?.required)
      ? (schema.required as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    const optional = properties.filter((name) => !required.includes(name));
    const example = selectedOpDetail?.examples?.[0];
    if (required.length > 0 || optional.length > 0 || example !== undefined) {
      log(chalk.white('\nParameters:'));
      if (required.length > 0) log(`  ${chalk.gray('required:')} ${required.join(', ')}`);
      if (optional.length > 0) log(`  ${chalk.gray('optional:')} ${optional.join(', ')}`);
      if (example !== undefined) log(`  ${chalk.gray('example:')} ${JSON.stringify(example)}`);
    }
  }

  if (rawParamsStr) {
    try {
      paramsObject = resolvePlaygroundParamsInput(rawParamsStr);
    } catch (err: any) {
      logError(chalk.red(`\n❌ Failed to load --params: ${err.message}`));
      rl.close();
      throw new ScriptExitError(1, `Failed to load --params: ${err.message}`);
    }
  } else if (!machineOutput) {
    log(chalk.white('\nHow would you like to provide the operation parameters?'));
    log(chalk.cyan('  1. Interactive Wizard (key-value prompting)'));
    log(chalk.cyan('  2. Paste Raw JSON block'));

    const methodChoice = await question(chalk.bold.blue('\nChoose method (1 or 2): '));

    if (methodChoice === '2') {
      log(
        chalk.yellow(
          '\nPaste the full JSON value for "params" (e.g. {"channel": "slack", "text": "hello"}), or @path to load a file:'
        )
      );
      const jsonStr = await question('> ');
      try {
        paramsObject = resolvePlaygroundParamsInput(jsonStr);
      } catch (err: any) {
        logError(chalk.red(`❌ Invalid params input: ${err.message}`));
        rl.close();
        throw new ScriptExitError(1, `Invalid params input: ${err.message}`);
      }
    } else {
      log(chalk.yellow('\nEnter parameter key-value pairs one by one. Leave key empty to finish.'));
      while (true) {
        const key = await question(chalk.bold.magenta('\nParameter Key: '));
        if (!key) break;
        const valStr = await question(chalk.bold.blue(`Value for '${key}': `));
        paramsObject[key] = tryCoerceValue(valStr);
      }
    }
  }

  // 6. Construct Payload
  // Include both 'op' and 'action' for seamless compatibility across different actuator conventions.
  // Discovery-only ops on actuators that accept `pipeline` are wrapped into
  // the same one-step pipeline ADF the runtime executes, so playground
  // try-out matches production. Actuators without a `pipeline` entry
  // (agent/secret/…) dispatch single actions directly and stay bare.
  const isManifestOp = (manifest.capabilities || []).some((entry) => entry.op === op);
  const detail = selectedOpDetail;
  const discoveryKind = detail?.kind ?? null;
  const isPipelineWrapped =
    !isManifestOp && discoveryKind !== null && actuatorAcceptsPipeline(manifest);
  const useFlatParams =
    !isPipelineWrapped && isManifestOp && contractSchemaUsesFlatParams(manifest.contract_schema);
  const payload = isPipelineWrapped
    ? buildPipelineWrappedPayload(op, paramsObject, discoveryKind as string)
    : buildPlaygroundPayload(op, paramsObject, useFlatParams);
  const resolvedKind =
    (discoveryKind as ActuatorPipelineStepType | null) ?? resolveCliActionKind(payload);
  const plan = evaluatePlaygroundDryRun({
    actuatorId: manifest.actuator_id,
    operation: op,
    payload,
    inputSchema: detail?.input_schema,
    params: paramsObject,
    kind: discoveryKind ?? undefined,
    contractSchemaPath: isManifestOp ? manifest.contract_schema : undefined,
    mode: options.check === true ? 'check' : 'dry-run',
  });
  if (plan.ok === false) {
    rl.close();
    if (options.check || options.dryRun) return { ...plan, handler_invoked: false };
    throw new ScriptExitError(
      1,
      `Invalid parameters for ${manifest.actuator_id}:${op}: ${plan.error}. Use --actuator ${manifest.actuator_id} --op ${op} --describe --json.`
    );
  }
  if (isPipelineWrapped && !machineOutput) {
    log(
      chalk.gray(
        `  Wrapped '${op}' into a one-step ${manifest.actuator_id} pipeline (same shape as ADF).`
      )
    );
  }

  try {
    assertPlaygroundSecretMutationAllowed({
      actuatorId: manifest.actuator_id,
      operation: op,
      params: paramsObject,
      dryRun: options.dryRun,
      check: options.check,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(chalk.red(`\n❌ ${message}`));
    rl.close();
    throw new ScriptExitError(1, message);
  }

  if (options.check === true || options.dryRun === true) {
    // Fine-grained params use their authored schema; the manifest schema
    // validates only operations declared at the CLI boundary.
    // `--check` is schema/plan only. Apply/transform/control `--dry-run` also
    // stay validate-only. Capture `--dry-run` falls through and invokes the
    // compiled actuator with `--dry-run` so the capture handler actually runs.
    if (options.check === true || plan.ok === false || plan.handler === 'skipped') {
      rl.close();
      return { ...plan, handler_invoked: false };
    }
  }

  // 7. Write to temp file inside active/shared/tmp/
  const tempDir = pathResolver.sharedTmp('actuator-playground');
  const tempPath = assertSafeRepositoryPath(
    path.join(tempDir, `input-${manifest.actuator_id}-${Date.now()}.json`),
    { allowMissingLeaf: true }
  );

  log(chalk.white(`\nWriting payload to temporary file: ${chalk.bold(tempPath)}...`));
  safeWriteFile(tempPath, JSON.stringify(payload, null, 2), { mkdir: true });

  // 8. Find executable path
  // Standard compile target paths
  const distDir = pathResolver.rootResolve('dist/libs/actuators');
  const execPath1 = assertSafeRepositoryPath(
    path.join(distDir, manifest.actuator_id, 'src/index.js'),
    { allowMissingLeaf: true }
  );
  const execPath2 = assertSafeRepositoryPath(path.join(distDir, manifest.actuator_id, 'index.js'), {
    allowMissingLeaf: true,
  });

  let execPath = options.resolveExecutable?.(manifest.actuator_id) ?? '';
  if (!execPath && safeExistsSync(execPath1)) {
    execPath = execPath1;
  } else if (!execPath && safeExistsSync(execPath2)) {
    execPath = execPath2;
  } else if (!execPath) {
    log(
      chalk.yellow(
        `\n⚠️  Could not find compiled JavaScript under dist/libs/actuators/${manifest.actuator_id}.`
      )
    );
    log(chalk.white('Attempting to compile actuators monorepo-wide first...'));
    try {
      safeExec('pnpm', ['run', 'build:actuators'], { cwd: pathResolver.rootDir() });
      if (safeExistsSync(execPath1)) {
        execPath = execPath1;
      } else if (safeExistsSync(execPath2)) {
        execPath = execPath2;
      }
    } catch (err: any) {
      logError(chalk.red(`❌ Compilation failed: ${err.message}`));
    }
  }

  if (!execPath) {
    logError(chalk.red(`\n❌ Executable not found. Make sure the actuator is built successfully.`));
    rl.close();
    throw new ScriptExitError(1, 'Actuator executable not found');
  }

  // 9. Execute Actuator (capture `--dry-run` still invokes the handler)
  const extraArgs = options.dryRun === true ? ['--dry-run'] : [];
  const executeActuator = options.executeActuator ?? defaultExecuteActuator;
  log(chalk.bold.yellow(`\n⚡ Executing [${manifest.actuator_id}] with command:`));
  log(
    chalk.gray(
      `node ${execPath} --input ${tempPath}${extraArgs.length ? ` ${extraArgs.join(' ')}` : ''}\n`
    )
  );

  try {
    const stdout = executeActuator({ execPath, inputPath: tempPath, extraArgs });
    log(chalk.bold.green('🎉 Execution completed successfully! Result output:'));
    log(chalk.white(stdout.trim()));
    let recorded: Record<string, unknown> | undefined;
    if (cliParams.record !== undefined && options.dryRun !== true) {
      const sessionFile = recordPlaygroundStep(
        cliParams.record,
        {
          actuator_id: manifest.actuator_id,
          domain: resolveActuatorDomain(manifest.actuator_id),
          op,
          kind: resolvedKind,
          params: paramsObject,
        },
        options.scratchDir
      );
      recorded = { session: cliParams.record, steps: sessionFile.steps.length };
      log(
        chalk.gray(
          `  Recorded step ${sessionFile.steps.length} into session '${cliParams.record}'. ` +
            `Export with: pnpm playground -- --emit-adf ${cliParams.record}`
        )
      );
    }
    rl.close();
    return {
      ok: true,
      mode: options.dryRun === true ? 'dry-run' : 'execute',
      actuator_id: manifest.actuator_id,
      operation: op,
      kind: resolvedKind,
      dry_run: options.dryRun === true,
      handler: resolvedKind,
      handler_invoked: true,
      input_path: tempPath,
      executable_path: execPath,
      stdout: stdout.trim(),
      ...(recorded ? { recorded } : {}),
    };
  } catch (err: any) {
    logError(chalk.bold.red('\n❌ Execution error encountered:'));
    logError(chalk.red(err.message));
    if (err.stdout) {
      logError(chalk.yellow('\nStdout:'));
      logError(chalk.white(err.stdout.toString().trim()));
    }
    if (err.stderr) {
      logError(chalk.yellow('\nStderr:'));
      logError(chalk.red(err.stderr.toString().trim()));
    }
    rl.close();
    return {
      ok: false,
      mode: options.dryRun === true ? 'dry-run' : 'execute',
      actuator_id: manifest.actuator_id,
      operation: op,
      handler_invoked: true,
      error: err.message,
      ...(err.stdout ? { stdout: String(err.stdout).trim() } : {}),
      ...(err.stderr ? { stderr: String(err.stderr).trim() } : {}),
    };
  }

  rl.close();
}

const script = defineScript({
  name: 'actuator:playground',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, quiet, print }) =>
    runPlayground(stripSharedScriptFlags(argv), { dryRun, check, json, quiet, print }).then(
      (result) => {
        if (result && (json || dryRun || check)) print(result);
        if (result?.ok === false)
          throw new ScriptExitError(
            1,
            String(result.error || 'Actuator operation failed'),
            json || dryRun || check
          );
        return result;
      }
    ),
});
if (
  isDirectScript(import.meta.url, 'actuator_playground.ts') ||
  isDirectScript(import.meta.url, 'actuator_playground.js')
) {
  void script();
}
