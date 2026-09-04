import {
  isRecord,
  nowIso,
  parseSafeJsonInput,
  parseSafeJsonObjectValue,
} from '@agent/core/foundation';
import type { AdfEngineContext, AdfRunResult, AdfStep } from '@agent/core/adf-engine';
import { distillHttpResponse } from '@agent/core/observation-distill';
import { executeLlmDecideOp } from '@agent/core/semantic-decide';
import { logger } from '@agent/core/core';
import { secureFetch } from '@agent/core/network';
import {
  safeReadFile,
  assertSafeRepositoryPath,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeLstat,
  safeExec,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  resolveVars,
  evaluateCondition,
  getPathValue,
  resolveWriteArtifactSpec,
} from '@agent/core/src/logic-utils';
import { retry } from '@agent/core/async-utils';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { buildUnknownActuatorOpError } from '@agent/core/actuator-op-registry';
import { runAdfActuatorPipeline } from '@agent/core/actuator-sdk';
import {
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from '@agent/core/execution-bounds';
import { getRegisteredEnv } from '@agent/core/foundation';
import * as path from 'node:path';
import { sendA2AMessage, pollA2AInbox } from './a2a-transport.js';

/**
 * Network-Actuator v2.2.0 [A2A TRANSPORT ENABLED]
 * Pure ADF-driven engine for all network and A2A interactions.
 */
const ALLOW_UNSAFE_SHELL =
  getRegisteredEnv<boolean>('KYBERION_ALLOW_UNSAFE_SHELL', { defaultValue: false }) === true;
const NETWORK_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/network-actuator/manifest.json'
);
const DEFAULT_RETRY_POLICY = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

function assertUnsafeShellAllowed() {
  if (!ALLOW_UNSAFE_SHELL) {
    throw new Error(
      '[SECURITY] Shell execution disabled. Set KYBERION_ALLOW_UNSAFE_SHELL=true to enable.'
    );
  }
}

const buildNetworkRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: NETWORK_MANIFEST_PATH,
  defaults: DEFAULT_RETRY_POLICY,
  fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

type NetworkPipelineParams = Record<string, unknown>;
type NetworkPipelineContext = AdfEngineContext;
type NetworkPipelineOptions = { max_steps?: number; timeout_ms?: number };
type NetworkPipelineStep = Omit<AdfStep, 'params'> & { params: NetworkPipelineParams };

function buildRetryOptions(stepParams: NetworkPipelineParams) {
  const explicitRetry =
    stepParams && typeof stepParams.retry === 'object' && !Array.isArray(stepParams.retry)
      ? { ...(stepParams.retry as Record<string, unknown>) }
      : ({} satisfies Record<string, unknown>);
  if (stepParams?.max_retries !== undefined)
    explicitRetry.maxRetries = Number(stepParams.max_retries);
  if (stepParams?.retry_delay_ms !== undefined)
    explicitRetry.initialDelayMs = Number(stepParams.retry_delay_ms);
  return buildNetworkRetryOptions(explicitRetry);
}

function buildUnknownNetworkOpError(op: string): Error {
  return buildUnknownActuatorOpError('network', op);
}

function resolveNetworkPath(ref: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), { allowMissingLeaf });
}

function isExistingRegularFile(filePath: string): boolean {
  if (!safeExistsSync(filePath)) return false;
  try {
    return safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

function readNetworkContext(filePath: string): Record<string, unknown> {
  if (!isExistingRegularFile(filePath)) {
    throw new Error(`network context must be an existing regular file: ${filePath}`);
  }
  return parseSafeJsonObjectValue(
    parseSafeJsonInput(
      String(safeReadFile(filePath, { encoding: 'utf8' }) || ''),
      'network context'
    ),
    'network context'
  );
}

export type PipelineStep = NetworkPipelineStep;

export interface NetworkAction {
  action: 'pipeline';
  steps: PipelineStep[];
  context?: NetworkPipelineContext;
  options?: NetworkPipelineOptions;
}

function requireParams(value: unknown, label: string): NetworkPipelineParams {
  if (!isRecord(value)) throw new Error(`${label} params must be an object`);
  return value;
}

function readStringParam(params: NetworkPipelineParams, key: string, fallback = ''): string {
  const value = params[key];
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function readNumberParam(params: NetworkPipelineParams, key: string, fallback: number): number {
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

function exportKey(params: NetworkPipelineParams, fallback: string): string {
  return readStringParam(params, 'export_as', fallback) || fallback;
}

function contextKey(params: NetworkPipelineParams, fallback: string): string {
  return readStringParam(params, 'from', fallback) || fallback;
}

function nestedFailure(result: AdfRunResult<NetworkPipelineContext>): string {
  return (
    result.results.find((entry) => entry.status === 'failed')?.error || 'nested pipeline failed'
  );
}

function readHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, String(entry ?? '')])
  );
}

export async function handleAction(input: NetworkAction) {
  if (input.action !== 'pipeline') {
    throw new Error(
      `Unsupported action: ${input.action}. Network-Actuator v2.2 is pure pipeline-driven.`
    );
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

// AR-01 Task 2: the hand-rolled step loop is replaced by the canonical
// shared ADF engine, so control-op / vars / condition semantics and
// step budgets match every other runner. One deliberate semantic change:
// nested control failures now propagate instead of being silently absorbed
// (the old loop took res.context regardless of nested status — AR-06's
// no-silent-failure rule says that was a bug, not a feature).
async function executePipeline(
  steps: PipelineStep[],
  initialCtx: NetworkPipelineContext = {},
  options: NetworkPipelineOptions = {}
) {
  const MAX_STEPS = options.max_steps || DEFAULT_MAX_PIPELINE_STEPS;
  const TIMEOUT = options.timeout_ms || DEFAULT_PIPELINE_TIMEOUT_MS;

  let ctx: NetworkPipelineContext = { ...initialCtx, timestamp: nowIso() };

  const contextPath = initialCtx.context_path
    ? resolveNetworkPath(String(initialCtx.context_path))
    : undefined;
  if (contextPath && safeExistsSync(contextPath)) {
    const saved = readNetworkContext(contextPath);
    ctx = { ...ctx, ...saved };
  }

  const result = await runAdfActuatorPipeline({
    actuatorId: 'network',
    steps,
    context: ctx,
    options: { maxSteps: MAX_STEPS, timeoutMs: TIMEOUT },
    handlers: {
      capture: opCapture,
      transform: opTransform,
      apply: async (op, params, currentCtx) => {
        await opApply(op, params, currentCtx);
        return currentCtx;
      },
      control: opControl,
    },
  });
  ctx = result.context;

  if (initialCtx.context_path) {
    safeWriteFile(
      resolveNetworkPath(String(initialCtx.context_path)),
      JSON.stringify(ctx, null, 2)
    );
  }

  return result;
}

async function opControl(
  op: string,
  rawParams: unknown,
  ctx: NetworkPipelineContext,
  runSteps: (
    steps: AdfStep[],
    seedCtx?: NetworkPipelineContext
  ) => Promise<AdfRunResult<NetworkPipelineContext>>,
  _resolve: (value: unknown) => unknown
) {
  const params = requireParams(rawParams, `network:${op}`);
  const runNested = async (steps: unknown, seedCtx: NetworkPipelineContext) => {
    const res = await runSteps(readNestedSteps(steps, `network:${op} nested steps`), seedCtx);
    if (res.status === 'failed') {
      throw new Error(nestedFailure(res));
    }
    return res.context;
  };

  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        return await runNested(params.then, ctx);
      } else if (params.else) {
        return await runNested(params.else, ctx);
      }
      return ctx;

    case 'while': {
      let iterations = 0;
      const maxIter = readNumberParam(params, 'max_iterations', 100);
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        ctx = await runNested(params.pipeline, ctx);
        iterations++;
      }
      return ctx;
    }

    default:
      throw buildUnknownNetworkOpError(op);
  }
}

async function opCapture(op: string, rawParams: unknown, ctx: NetworkPipelineContext) {
  const params = requireParams(rawParams, `network:${op}`);
  switch (op) {
    case 'fetch':
      const response = await retry(async () => {
        return await secureFetch({
          method: readStringParam(params, 'method', 'GET'),
          url: resolveVars(params.url, ctx),
          headers: readHeaders(params.headers),
          data: params.data,
          params: params.query,
          timeout: readNumberParam(params, 'timeout', 20000),
        });
      }, buildRetryOptions(params));
      return { ...ctx, [exportKey(params, 'last_capture')]: response };

    case 'shell':
      assertUnsafeShellAllowed();
      const cmd = String(resolveVars(params.cmd, ctx) ?? '');
      return { ...ctx, [exportKey(params, 'last_capture')]: safeExec(cmd).trim() };

    case 'a2a_poll':
      const messages = await pollA2AInbox();
      return { ...ctx, [exportKey(params, 'inbox_messages')]: messages };

    default:
      throw buildUnknownNetworkOpError(op);
  }
}

async function opTransform(op: string, rawParams: unknown, ctx: NetworkPipelineContext) {
  const params = requireParams(rawParams, `network:${op}`);
  switch (op) {
    case 'json_query':
      const data = ctx[contextKey(params, 'last_capture')];
      const result = getPathValue(data, readStringParam(params, 'path'));
      return { ...ctx, [exportKey(params, 'last_capture')]: result };

    case 'distill_response': {
      // AR-07: deterministic distillation of a fetched response (JSON shape /
      // HTML title+links / text preview, bounded) so llm_decide never sees
      // the raw body.
      const source = ctx[contextKey(params, 'last_capture')];
      const distillate = distillHttpResponse(source, {
        maxPreviewChars: readNumberParam(params, 'max_preview_chars', 2000),
        maxJsonKeys: readNumberParam(params, 'max_json_keys', 30),
        maxLinks: readNumberParam(params, 'max_links', 15),
      });
      return { ...ctx, [exportKey(params, 'response_distillate')]: distillate };
    }

    case 'llm_decide': {
      // AR-07: one in-loop decision about the distilled response.
      return executeLlmDecideOp({
        params,
        ctx,
        resolve: (value: unknown) => (typeof value === 'string' ? resolveVars(value, ctx) : value),
        defaultFromKey: 'response_distillate',
      });
    }

    case 'regex_extract':
      const input = String(ctx[contextKey(params, 'last_capture')] || '');
      const match = input.match(new RegExp(readStringParam(params, 'pattern'), 'm'));
      return { ...ctx, [exportKey(params, 'last_capture')]: match ? match[1] || match[0] : null };

    default:
      throw buildUnknownNetworkOpError(op);
  }
}

async function opApply(op: string, rawParams: unknown, ctx: NetworkPipelineContext) {
  const params = requireParams(rawParams, `network:${op}`);
  switch (op) {
    case 'write_file':
    case 'write_artifact':
      const spec = resolveWriteArtifactSpec(params, ctx, (value) => resolveVars(value, ctx));
      const outPath = resolveNetworkPath(String(spec.path));
      const content =
        typeof spec.content === 'string'
          ? spec.content
          : spec.content === undefined
            ? ''
            : JSON.stringify(spec.content, null, 2);
      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });
      safeWriteFile(outPath, content);
      break;

    case 'a2a_send':
      const message = resolveVars(params.message, ctx);
      await sendA2AMessage(message, {
        method: readStringParam(params, 'method', 'local') === 'local' ? 'local' : 'local',
        encrypt: params.encrypt !== false,
        target_public_key: params.target_public_key
          ? resolveNetworkPath(String(resolveVars(params.target_public_key, ctx)))
          : undefined,
      });
      break;

    case 'log':
      logger.info(`[NETWORK_LOG] ${resolveVars(params.message || 'Action completed', ctx)}`);
      break;
  }
}
