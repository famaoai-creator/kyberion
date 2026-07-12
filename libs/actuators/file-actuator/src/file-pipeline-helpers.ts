import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeExec,
  safeStat,
  safeReaddir,
  safeAppendFileSync,
  safeCopyFileSync,
  safeMoveSync,
  safeRmSync,
  retry,
  classifyError,
  pathResolver,
  resolveVars,
  evaluateCondition,
  resolveWriteArtifactSpec,
  resolveRequiredStringParam,
  validateOpInput,
  processUntrustedContent,
  executeAdfSteps,
  skipAdfStep,
  buildUnknownActuatorOpError,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/file-actuator/manifest.json');
const DEFAULT_FILE_RETRY = {
  maxRetries: 2,
  initialDelayMs: 150,
  maxDelayMs: 1200,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | null = null;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(FILE_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
  } catch {
    cachedRecoveryPolicy = {};
  }
  return cachedRecoveryPolicy;
}

function buildRetryOptions() {
  const policy = loadRecoveryPolicy();
  const retry = isPlainObject(policy.retry) ? policy.retry : DEFAULT_FILE_RETRY;
  const retryableCategories = new Set<string>(
    Array.isArray(policy.retryable_categories) ? policy.retryable_categories.map(String) : []
  );
  return {
    ...DEFAULT_FILE_RETRY,
    ...retry,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      return retryableCategories.size > 0
        ? retryableCategories.has(classification.category)
        : classification.category === 'resource_unavailable' ||
            classification.category === 'timeout';
    },
  };
}

function buildUnknownFileOpMessage(op: string): string {
  return buildUnknownActuatorOpError('file', op).message;
}

/**
 * File-Actuator v2.1.1 [RESILIENT PIPELINE]
 * Strictly compliant with Layer 2 (Shield).
 * A pure ADF-driven engine for filesystem operations with Control Flow and Safety Guards.
 * Restored specialized ops: tail, append, exists, copy, move.
 */

interface FileAction {
  action: 'pipeline';
  steps: Array<{ type: 'capture' | 'transform' | 'apply' | 'control'; op: string; params: any }>;
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
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
  steps: Array<{ type: 'capture' | 'transform' | 'apply' | 'control'; op: string; params: any }>,
  initialCtx: any = {},
  options: any = {}
) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, root: rootDir };

  if (initialCtx.context_path && safeExistsSync(path.resolve(rootDir, initialCtx.context_path))) {
    const saved = await retry(
      async () =>
        JSON.parse(
          safeReadFile(path.resolve(rootDir, initialCtx.context_path), {
            encoding: 'utf8',
          }) as string
        ),
      buildRetryOptions()
    );
    ctx = { ...ctx, ...saved };
  }
  const result = await executeAdfSteps(
    steps,
    ctx,
    {
      maxSteps: MAX_STEPS,
      timeoutMs: TIMEOUT,
    },
    {
      capture: opCapture,
      transform: opTransform,
      apply: opApply,
      control: async (op, params, currentCtx, runSteps, resolve) =>
        await opControl(op, params, currentCtx, runSteps, resolve),
    }
  );

  ctx = result.context;

  if (initialCtx.context_path) {
    await retry(async () => {
      safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
      return undefined;
    }, buildRetryOptions());
  }

  return result;
}

async function opControl(
  op: string,
  params: any,
  ctx: any,
  runSteps: (steps: any[], seedCtx?: any) => Promise<any>,
  _resolve: (value: any) => any
) {
  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const res = await runSteps(params.then, ctx);
        if (res.status === 'failed') {
          throw new Error(
            res.results.find((result: any) => result.status === 'failed')?.error ||
              'nested pipeline failed'
          );
        }
        return res.context;
      } else if (params.else) {
        const res = await runSteps(params.else, ctx);
        if (res.status === 'failed') {
          throw new Error(
            res.results.find((result: any) => result.status === 'failed')?.error ||
              'nested pipeline failed'
          );
        }
        return res.context;
      }
      return skipAdfStep(
        ctx,
        'core:if condition evaluated to false and no else branch was provided'
      );

    case 'while':
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      let executed = false;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        executed = true;
        const res = await runSteps(params.pipeline, ctx);
        if (res.status === 'failed') {
          throw new Error(
            res.results.find((result: any) => result.status === 'failed')?.error ||
              'nested pipeline failed'
          );
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

async function opCapture(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  const validation = validateOpInput('file', op, params);
  if (!validation.valid) {
    throw new Error(
      `[INVALID_OP_INPUT] ${op}: ${'errors' in validation ? validation.errors.join('; ') : ''}`
    );
  }
  switch (op) {
    case 'read':
    case 'read_file': {
      const filePath = resolve(params.path);
      const rawText = await retry(
        async () => safeReadFile(path.resolve(rootDir, filePath), { encoding: 'utf8' }),
        buildRetryOptions()
      );
      const wrappedText =
        typeof rawText === 'string'
          ? processUntrustedContent(rawText, `file:${filePath}`).wrapped
          : rawText;
      return {
        ...ctx,
        [params.export_as || 'last_capture']: wrappedText,
      };
    }
    case 'read_json': {
      const filePath = resolve(params.path);
      const rawText = await retry(
        async () => safeReadFile(path.resolve(rootDir, filePath), { encoding: 'utf8' }),
        buildRetryOptions()
      );
      const parsed = JSON.parse(String(rawText));
      return {
        ...ctx,
        [params.export_as || 'last_capture_data']: parsed,
      };
    }
    case 'list':
      return {
        ...ctx,
        [params.export_as || 'file_list']: await retry(
          async () => safeReaddir(path.resolve(rootDir, resolve(params.path))),
          buildRetryOptions()
        ),
      };
    case 'stat':
      const s = await retry(
        async () => safeStat(path.resolve(rootDir, resolve(params.path))),
        buildRetryOptions()
      );
      return {
        ...ctx,
        [params.export_as || 'last_stat']: {
          size: s.size,
          mtime: s.mtime,
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
        },
      };
    case 'exists':
      return {
        ...ctx,
        [params.export_as || 'exists']: await retry(
          async () => safeExistsSync(path.resolve(rootDir, resolve(params.path))),
          buildRetryOptions()
        ),
      };
    case 'search': {
      const pattern = resolve(params.pattern);
      const targetPath = path.resolve(rootDir, resolve(params.path));
      const rgOutput = await retry(
        async () => safeExec('rg', ['--json', String(pattern), targetPath], { encoding: 'utf8' }),
        buildRetryOptions()
      );
      return { ...ctx, [params.export_as || 'search_results']: JSON.parse(rgOutput) };
    }
    case 'tail': {
      const filePath = resolve(params.path);
      const tailPath = path.resolve(rootDir, filePath);
      const stats = await retry(async () => safeStat(tailPath), buildRetryOptions());
      const posKey = params.pos_key || 'last_pos';
      const lastPos = ctx[posKey] || 0;
      const fullText = await retry(
        async () => safeReadFile(tailPath, { encoding: 'utf8' }) as string,
        buildRetryOptions()
      );
      const newText = fullText.substring(lastPos);
      const wrappedText =
        typeof newText === 'string'
          ? processUntrustedContent(newText, `file:${filePath}`).wrapped
          : newText;
      return { ...ctx, [params.export_as || 'last_capture']: wrappedText, [posKey]: stats.size };
    }
    default:
      throw new Error(buildUnknownFileOpMessage(op));
  }
}

async function opTransform(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  switch (op) {
    case 'regex_replace':
      return {
        ...ctx,
        [params.export_as || 'last_transform']: String(
          ctx[params.from || 'last_capture'] || ''
        ).replace(new RegExp(params.pattern, 'g'), resolve(params.template)),
      };
    case 'json_parse':
      return {
        ...ctx,
        [params.export_as || 'last_capture_data']: JSON.parse(ctx[params.from || 'last_capture']),
      };
    case 'path_join':
      return {
        ...ctx,
        [params.export_as]: path.join(...params.parts.map((p: string) => resolve(p))),
      };
    default:
      throw new Error(buildUnknownFileOpMessage(op));
  }
}

async function opApply(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  const validation = validateOpInput('file', op, params);
  if (!validation.valid) {
    throw new Error(
      `[INVALID_OP_INPUT] ${op}: ${'errors' in validation ? validation.errors.join('; ') : ''}`
    );
  }
  switch (op) {
    case 'write': {
      const out = path.resolve(
        rootDir,
        resolveRequiredStringParam(params, ['path'], resolve, 'write')
      );
      const content =
        ctx[params.from || 'last_transform'] ||
        ctx[params.from || 'last_capture'] ||
        resolve(params.content);
      await retry(async () => {
        safeWriteFile(out, content);
        return undefined;
      }, buildRetryOptions());
      break;
    }
    case 'write_file':
    case 'write_artifact': {
      const spec = resolveWriteArtifactSpec(params, ctx, resolve);
      const out = path.resolve(rootDir, spec.path);
      const content =
        typeof spec.content === 'string'
          ? spec.content
          : spec.content === undefined
            ? ''
            : JSON.stringify(spec.content, null, 2);
      if (!safeExistsSync(path.dirname(out))) safeMkdir(path.dirname(out), { recursive: true });
      await retry(async () => {
        safeWriteFile(out, content);
        return undefined;
      }, buildRetryOptions());
      break;
    }
    case 'append': {
      const out = path.resolve(
        rootDir,
        resolveRequiredStringParam(params, ['path'], resolve, 'append')
      );
      const content =
        ctx[params.from || 'last_transform'] ||
        ctx[params.from || 'last_capture'] ||
        resolve(params.content);
      const payload = content + (params.newline !== false ? '\n' : '');
      await retry(async () => {
        safeAppendFileSync(out, payload);
        return undefined;
      }, buildRetryOptions());
      break;
    }
    case 'delete': {
      const target = path.resolve(
        rootDir,
        resolveRequiredStringParam(params, ['path'], resolve, 'delete')
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
          path.resolve(rootDir, resolveRequiredStringParam(params, ['path'], resolve, 'mkdir')),
          { recursive: true }
        );
        return undefined;
      }, buildRetryOptions());
      break;
    case 'copy': {
      const src = path.resolve(
        rootDir,
        resolveRequiredStringParam(params, ['from'], resolve, 'copy')
      );
      const dest = path.resolve(
        rootDir,
        resolveRequiredStringParam(params, ['to'], resolve, 'copy')
      );
      await retry(async () => {
        if (!safeExistsSync(path.dirname(dest))) safeMkdir(path.dirname(dest), { recursive: true });
        safeCopyFileSync(src, dest);
        return undefined;
      }, buildRetryOptions());
      break;
    }
    case 'move': {
      const src = path.resolve(
        rootDir,
        resolveRequiredStringParam(params, ['from'], resolve, 'move')
      );
      const dest = path.resolve(
        rootDir,
        resolveRequiredStringParam(params, ['to'], resolve, 'move')
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
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  const inputContent = safeReadFile(path.resolve(pathResolver.rootDir(), argv.input as string), {
    encoding: 'utf8',
  }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1); // eslint-disable-line no-restricted-properties -- CLI entry guard
  });
}
