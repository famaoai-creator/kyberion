import { readJson, parseSafeJsonInput, parseSafeJsonObjectValue } from '@agent/core/foundation';
import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
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
} from '@agent/core/secure-io';
import { retry } from '@agent/core/async-utils';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import * as pathResolver from '@agent/core/path-resolver';
import {
  evaluateCondition,
  resolveWriteArtifactSpec,
  resolveRequiredStringParam,
} from '@agent/core/src/logic-utils';
import { validateOpInput } from '@agent/core/op-input-contracts';
import { processUntrustedContent } from '@agent/core/untrusted-content';
import { skipAdfStep } from '@agent/core/adf-engine';
import { buildUnknownActuatorOpError } from '@agent/core/actuator-op-registry';
import { runAdfActuatorPipeline } from '@agent/core/actuator-sdk';
import {
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from '@agent/core/execution-bounds';
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
  const MAX_STEPS = options.max_steps || DEFAULT_MAX_PIPELINE_STEPS;
  const TIMEOUT = options.timeout_ms || DEFAULT_PIPELINE_TIMEOUT_MS;

  let ctx = { ...initialCtx, root: rootDir };

  const contextPath = initialCtx.context_path
    ? resolveFilePath(String(initialCtx.context_path), true)
    : undefined;
  if (contextPath && safeExistsSync(contextPath)) {
    const saved = await retry(
      async () => readJson<Record<string, unknown>>(contextPath),
      buildRetryOptions()
    );
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
        async () => safeReadFile(resolveFilePath(String(filePath)), { encoding: 'utf8' }),
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
        async () => safeReadFile(resolveFilePath(String(filePath)), { encoding: 'utf8' }),
        buildRetryOptions()
      );
      const parsed = parseSafeJsonInput(String(rawText), 'file read_json input');
      return {
        ...ctx,
        [params.export_as || 'last_capture_data']: parsed,
      };
    }
    case 'list':
      return {
        ...ctx,
        [params.export_as || 'file_list']: await retry(
          async () => safeReaddir(resolveFilePath(String(resolve(params.path)))),
          buildRetryOptions()
        ),
      };
    case 'stat':
      const s = await retry(
        async () => safeStat(resolveFilePath(String(resolve(params.path)))),
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
          async () => safeExistsSync(resolveFilePath(String(resolve(params.path)), true)),
          buildRetryOptions()
        ),
      };
    case 'search': {
      const pattern = resolve(params.pattern);
      const targetPath = resolveFilePath(String(resolve(params.path)));
      const rgOutput = await retry(
        async () => safeExec('rg', ['--json', String(pattern), targetPath], { encoding: 'utf8' }),
        buildRetryOptions()
      );
      const results = rgOutput
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseSafeJsonInput(line, 'file search result'));
      return { ...ctx, [params.export_as || 'search_results']: results };
    }
    case 'tail': {
      const filePath = resolve(params.path);
      const tailPath = resolveFilePath(String(filePath));
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
        [params.export_as || 'last_capture_data']: parseSafeJsonInput(
          String(ctx[params.from || 'last_capture']),
          'file json_parse input'
        ),
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
      const out = resolveFilePath(String(spec.path), true);
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
      const out = resolveFilePath(
        resolveRequiredStringParam(params, ['path'], resolve, 'append'),
        true
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
  const argv = await createStandardYargs(process.argv)
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  const inputContent = safeReadFile(resolveFilePath(String(argv.input)), {
    encoding: 'utf8',
  }) as string;
  const result = await handleAction(
    parseSafeJsonObjectValue(
      parseSafeJsonInput(inputContent, 'file action input'),
      'file action input'
    ) as unknown as FileAction
  );
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}
