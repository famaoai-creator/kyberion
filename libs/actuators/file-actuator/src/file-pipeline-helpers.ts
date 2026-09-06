import {
  isRecord,
  parseSafeJsonInput,
  parseSafeJsonObjectValue,
  readJson,
} from '@agent/core/foundation';
import type { AdfEngineContext, AdfRunResult, AdfStep } from '@agent/core/adf-engine';
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeLstat,
  safeExec,
  safeStat,
  safeReaddir,
  safeAppendFileSync,
  safeCopyFileSync,
  safeMoveSync,
  safeRmSync,
} from '@agent/core/secure-io';
import { retry } from '@agent/core/async-utils';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import * as pathResolver from '@agent/core/path-resolver';
import {
  evaluateCondition,
  resolveWriteArtifactSpec,
  resolveRequiredStringParam,
} from '@agent/core/logic-utils';
import { validateOpInput } from '@agent/core/op-input-contracts';
import { processUntrustedContent } from '@agent/core/untrusted-content';
import { skipAdfStep } from '@agent/core/adf-engine';
import { buildUnknownActuatorOpError } from '@agent/core/actuator-op-registry';
import { runAdfActuatorPipeline } from '@agent/core/actuator-sdk';
import {
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from '@agent/core/execution-bounds';
import {
  createStandardYargs,
  currentProcessArgv,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import * as path from 'node:path';
import { isDirectEntry } from '@agent/core/direct-entry';

const FILE_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/file-actuator/manifest.json');
const DEFAULT_FILE_RETRY = {
  maxRetries: 2,
  initialDelayMs: 150,
  maxDelayMs: 1200,
  factor: 2,
  jitter: true,
};

const buildRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: FILE_MANIFEST_PATH,
  defaults: DEFAULT_FILE_RETRY,
  fallbackCategories: ['resource_unavailable', 'timeout'],
});

function resolveFilePath(value: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(path.resolve(pathResolver.rootDir(), value), {
    allowMissingLeaf,
  });
}

function buildUnknownFileOpMessage(op: string): string {
  return buildUnknownActuatorOpError('file', op).message;
}

function isExistingRegularFile(filePath: string): boolean {
  if (!safeExistsSync(filePath)) return false;
  try {
    return safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

function readFileContext(filePath: string): Record<string, unknown> {
  if (!isExistingRegularFile(filePath)) {
    throw new Error(`file context must be an existing regular file: ${filePath}`);
  }
  return parseSafeJsonObjectValue(readJson(filePath), 'file context');
}

/**
 * File-Actuator v2.1.1 [RESILIENT PIPELINE]
 * Strictly compliant with Layer 2 (Shield).
 * A pure ADF-driven engine for filesystem operations with Control Flow and Safety Guards.
 * Restored specialized ops: tail, append, exists, copy, move.
 */

type FilePipelineParams = Record<string, unknown>;
type FilePipelineContext = AdfEngineContext;
type FilePipelineOptions = { max_steps?: number; timeout_ms?: number };
type FilePipelineStep = Omit<AdfStep, 'params'> & { params: FilePipelineParams };

interface FileAction {
  action: 'pipeline';
  steps: FilePipelineStep[];
  context?: FilePipelineContext;
  options?: FilePipelineOptions;
}

function requireParams(value: unknown, label: string): FilePipelineParams {
  if (!isRecord(value)) throw new Error(`${label} params must be an object`);
  return value;
}

function readStringParam(params: FilePipelineParams, key: string, fallback = ''): string {
  const value = params[key];
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function readNumberParam(params: FilePipelineParams, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readNestedSteps(value: unknown, label: string): AdfStep[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.op !== 'string' ||
      !['capture', 'transform', 'apply', 'control'].includes(String(entry.type))
    ) {
      throw new Error(`${label}[${index}] must be an ADF step`);
    }
    return entry as unknown as AdfStep;
  });
}

function resolvedString(
  value: unknown,
  resolve: (value: unknown) => unknown,
  fallback = ''
): string {
  const resolved = resolve(value);
  return typeof resolved === 'string' ? resolved : resolved == null ? fallback : String(resolved);
}

function exportKey(params: FilePipelineParams, fallback: string): string {
  return readStringParam(params, 'export_as', fallback) || fallback;
}

function contextKey(params: FilePipelineParams, fallback: string): string {
  return readStringParam(params, 'from', fallback) || fallback;
}

function toFileData(value: unknown): string | Buffer {
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value;
  return value == null ? '' : JSON.stringify(value);
}

function nestedFailure(result: AdfRunResult<FilePipelineContext>): string {
  return (
    result.results.find((entry) => entry.status === 'failed')?.error || 'nested pipeline failed'
  );
}

export async function handleAction(input: FileAction) {
  if (input.action !== 'pipeline') {
    throw new Error(
      `Unsupported action: ${input.action}. File-Actuator v2.1 is pure pipeline-driven.`
    );
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

async function executePipeline(
  steps: FilePipelineStep[],
  initialCtx: FilePipelineContext = {},
  options: FilePipelineOptions = {}
) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || DEFAULT_MAX_PIPELINE_STEPS;
  const TIMEOUT = options.timeout_ms || DEFAULT_PIPELINE_TIMEOUT_MS;

  let ctx: FilePipelineContext = { ...initialCtx, root: rootDir };

  const contextPath = initialCtx.context_path
    ? resolveFilePath(String(initialCtx.context_path), true)
    : undefined;
  if (contextPath && safeExistsSync(contextPath)) {
    const saved = await retry(async () => readFileContext(contextPath), buildRetryOptions());
    ctx = { ...ctx, ...saved };
  }
  const result = await runAdfActuatorPipeline({
    actuatorId: 'file',
    steps,
    context: ctx,
    options: {
      maxSteps: MAX_STEPS,
      timeoutMs: TIMEOUT,
    },
    handlers: {
      capture: opCapture,
      transform: opTransform,
      apply: opApply,
      control: async (op, params, currentCtx, runSteps, resolve) =>
        await opControl(op, params, currentCtx, runSteps, resolve),
    },
  });

  ctx = result.context;

  if (initialCtx.context_path) {
    await retry(async () => {
      safeWriteFile(
        resolveFilePath(String(initialCtx.context_path), true),
        JSON.stringify(ctx, null, 2)
      );
      return undefined;
    }, buildRetryOptions());
  }

  return result;
}

async function opControl(
  op: string,
  rawParams: unknown,
  ctx: FilePipelineContext,
  runSteps: (
    steps: AdfStep[],
    seedCtx?: FilePipelineContext
  ) => Promise<AdfRunResult<FilePipelineContext>>,
  _resolve: (value: unknown) => unknown
) {
  const params = requireParams(rawParams, `file:${op}`);
  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const res = await runSteps(readNestedSteps(params.then, 'file:if then'), ctx);
        if (res.status === 'failed') {
          throw new Error(nestedFailure(res));
        }
        return res.context;
      } else if (params.else) {
        const res = await runSteps(readNestedSteps(params.else, 'file:if else'), ctx);
        if (res.status === 'failed') {
          throw new Error(nestedFailure(res));
        }
        return res.context;
      }
      return skipAdfStep(
        ctx,
        'core:if condition evaluated to false and no else branch was provided'
      );

    case 'while':
      let iterations = 0;
      const maxIter = readNumberParam(params, 'max_iterations', 100);
      let executed = false;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        executed = true;
        const res = await runSteps(readNestedSteps(params.pipeline, 'file:while pipeline'), ctx);
        if (res.status === 'failed') {
          throw new Error(nestedFailure(res));
        }
        ctx = res.context;
        iterations++;
      }
      return executed
        ? ctx
        : skipAdfStep(ctx, 'core:while condition evaluated to false before execution');

    default:
      throw new Error(buildUnknownFileOpMessage(op));
  }
}

async function opCapture(
  op: string,
  rawParams: unknown,
  ctx: FilePipelineContext,
  resolve: (value: unknown) => unknown
) {
  const params = requireParams(rawParams, `file:${op}`);
  const validation = validateOpInput('file', op, params);
  if (!validation.valid) {
    throw new Error(
      `[INVALID_OP_INPUT] ${op}: ${'errors' in validation ? validation.errors.join('; ') : ''}`
    );
  }
  switch (op) {
    case 'read':
    case 'read_file': {
      const filePath = resolvedString(params.path, resolve);
      const rawText = await retry(
        async () => safeReadFile(resolveFilePath(String(filePath)), { encoding: 'utf8' }),
        buildRetryOptions()
      );
      const wrappedText =
        typeof rawText === 'string'
          ? processUntrustedContent(rawText, `file:${filePath}`).wrapped
          : rawText;
      return {
        ...ctx,
        [exportKey(params, 'last_capture')]: wrappedText,
      };
    }
    case 'read_json': {
      const filePath = resolvedString(params.path, resolve);
      const parsed = await retry(
        async () => readJson<unknown>(resolveFilePath(String(filePath))),
        buildRetryOptions()
      );
      return {
        ...ctx,
        [exportKey(params, 'last_capture_data')]: parsed,
      };
    }
    case 'list':
      return {
        ...ctx,
        [exportKey(params, 'file_list')]: await retry(
          async () => safeReaddir(resolveFilePath(resolvedString(params.path, resolve))),
          buildRetryOptions()
        ),
      };
    case 'stat':
      const s = await retry(
        async () => safeStat(resolveFilePath(resolvedString(params.path, resolve))),
        buildRetryOptions()
      );
      return {
        ...ctx,
        [exportKey(params, 'last_stat')]: {
          size: s.size,
          mtime: s.mtime,
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
        },
      };
    case 'exists':
      return {
        ...ctx,
        [exportKey(params, 'exists')]: await retry(
          async () => safeExistsSync(resolveFilePath(resolvedString(params.path, resolve), true)),
          buildRetryOptions()
        ),
      };
    case 'search': {
      const pattern = resolvedString(params.pattern, resolve);
      const targetPath = resolveFilePath(resolvedString(params.path, resolve));
      const rgOutput = await retry(
        async () => safeExec('rg', ['--json', String(pattern), targetPath], { encoding: 'utf8' }),
        buildRetryOptions()
      );
      const results = rgOutput
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseSafeJsonInput(line, 'file search result'));
      return { ...ctx, [exportKey(params, 'search_results')]: results };
    }
    case 'tail': {
      const filePath = resolvedString(params.path, resolve);
      const tailPath = resolveFilePath(String(filePath));
      const stats = await retry(async () => safeStat(tailPath), buildRetryOptions());
      const posKey = readStringParam(params, 'pos_key', 'last_pos') || 'last_pos';
      const lastPosValue = ctx[posKey];
      const lastPos =
        typeof lastPosValue === 'number' && Number.isFinite(lastPosValue)
          ? lastPosValue
          : Number(lastPosValue) || 0;
      const fullText = await retry(
        async () => safeReadFile(tailPath, { encoding: 'utf8' }) as string,
        buildRetryOptions()
      );
      const newText = fullText.substring(lastPos);
      const wrappedText =
        typeof newText === 'string'
          ? processUntrustedContent(newText, `file:${filePath}`).wrapped
          : newText;
      return { ...ctx, [exportKey(params, 'last_capture')]: wrappedText, [posKey]: stats.size };
    }
    default:
      throw new Error(buildUnknownFileOpMessage(op));
  }
}

async function opTransform(
  op: string,
  rawParams: unknown,
  ctx: FilePipelineContext,
  resolve: (value: unknown) => unknown
) {
  const params = requireParams(rawParams, `file:${op}`);
  switch (op) {
    case 'regex_replace':
      return {
        ...ctx,
        [exportKey(params, 'last_transform')]: String(
          ctx[contextKey(params, 'last_capture')] || ''
        ).replace(
          new RegExp(readStringParam(params, 'pattern')),
          resolvedString(params.template, resolve)
        ),
      };
    case 'json_parse':
      return {
        ...ctx,
        [exportKey(params, 'last_capture_data')]: parseSafeJsonInput(
          String(ctx[contextKey(params, 'last_capture')]),
          'file json_parse input'
        ),
      };
    case 'path_join':
      return {
        ...ctx,
        [exportKey(params, 'last_transform')]: path.join(
          ...(Array.isArray(params.parts) ? params.parts : []).map((part) =>
            resolvedString(part, resolve)
          )
        ),
      };
    default:
      throw new Error(buildUnknownFileOpMessage(op));
  }
}

async function opApply(
  op: string,
  rawParams: unknown,
  ctx: FilePipelineContext,
  resolve: (value: unknown) => unknown
) {
  const params = requireParams(rawParams, `file:${op}`);
  const validation = validateOpInput('file', op, params);
  if (!validation.valid) {
    throw new Error(
      `[INVALID_OP_INPUT] ${op}: ${'errors' in validation ? validation.errors.join('; ') : ''}`
    );
  }
  switch (op) {
    case 'write': {
      const out = resolveFilePath(
        resolveRequiredStringParam(params, ['path'], resolve, 'write'),
        true
      );
      const content =
        ctx[contextKey(params, 'last_transform')] ||
        ctx[contextKey(params, 'last_capture')] ||
        resolve(params.content);
      await retry(async () => {
        safeWriteFile(out, toFileData(content));
        return undefined;
      }, buildRetryOptions());
      break;
    }
    case 'write_file':
    case 'write_artifact': {
      const spec = resolveWriteArtifactSpec(params, ctx, resolve);
      const out = resolveFilePath(String(spec.path), true);
      const content =
        typeof spec.content === 'string'
          ? spec.content
          : spec.content === undefined
            ? ''
            : JSON.stringify(spec.content, null, 2);
      if (!safeExistsSync(path.dirname(out))) safeMkdir(path.dirname(out), { recursive: true });
      await retry(async () => {
        safeWriteFile(out, toFileData(content));
        return undefined;
      }, buildRetryOptions());
      break;
    }
    case 'append': {
      const out = resolveFilePath(
        resolveRequiredStringParam(params, ['path'], resolve, 'append'),
        true
      );
      const content =
        ctx[contextKey(params, 'last_transform')] ||
        ctx[contextKey(params, 'last_capture')] ||
        resolve(params.content);
      const payload = `${toFileData(content)}${params.newline !== false ? '\n' : ''}`;
      await retry(async () => {
        safeAppendFileSync(out, payload);
        return undefined;
      }, buildRetryOptions());
      break;
    }
    case 'delete': {
      const target = resolveFilePath(
        resolveRequiredStringParam(params, ['path'], resolve, 'delete'),
        true
      );
      await retry(async () => {
        safeRmSync(target, { recursive: true, force: true });
        return undefined;
      }, buildRetryOptions());
      break;
    }
    case 'mkdir':
      await retry(async () => {
        safeMkdir(
          resolveFilePath(resolveRequiredStringParam(params, ['path'], resolve, 'mkdir'), true),
          { recursive: true }
        );
        return undefined;
      }, buildRetryOptions());
      break;
    case 'copy': {
      const src = resolveFilePath(resolveRequiredStringParam(params, ['from'], resolve, 'copy'));
      const dest = resolveFilePath(
        resolveRequiredStringParam(params, ['to'], resolve, 'copy'),
        true
      );
      await retry(async () => {
        if (!safeExistsSync(path.dirname(dest))) safeMkdir(path.dirname(dest), { recursive: true });
        safeCopyFileSync(src, dest);
        return undefined;
      }, buildRetryOptions());
      break;
    }
    case 'move': {
      const src = resolveFilePath(resolveRequiredStringParam(params, ['from'], resolve, 'move'));
      const dest = resolveFilePath(
        resolveRequiredStringParam(params, ['to'], resolve, 'move'),
        true
      );
      await retry(async () => {
        if (!safeExistsSync(path.dirname(dest))) safeMkdir(path.dirname(dest), { recursive: true });
        safeMoveSync(src, dest);
        return undefined;
      }, buildRetryOptions());
      break;
    }
    default:
      throw new Error(buildUnknownFileOpMessage(op));
  }
}

const main = async () => {
  const argv = await createStandardYargs(currentProcessArgv())
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  const result = await handleAction(
    parseSafeJsonObjectValue(
      readJson<unknown>(resolveFilePath(String(argv.input)), { label: 'file action input' }),
      'file action input'
    ) as unknown as FileAction
  );
  console.log(JSON.stringify(result, null, 2));
};

if (isDirectEntry(import.meta.url, 'libs/actuators/file-actuator/src/file-pipeline-helpers.ts')) {
  void runActuatorCliEntryPoint(main, 'file-actuator');
}
