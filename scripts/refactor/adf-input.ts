import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { rootResolve } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { validatePipelineAdf } from '@agent/core/pipeline-contract';
import { validatePipelineGuardrails } from '@agent/core/adf-guardrails';
import { tryRepairJson } from '@agent/core/json-repair';

export function resolveAdfInputPath(inputPath: string): string {
  return rootResolve(inputPath);
}

export function readJsonInput<T = any>(inputPath: string): T {
  const content = safeReadFile(resolveAdfInputPath(inputPath), { encoding: 'utf8' }) as string;
  return JSON.parse(content) as T;
}

function isWorkflowModulePath(inputPath: string): boolean {
  const lower = inputPath.toLowerCase();
  return (
    lower.endsWith('.ts') ||
    lower.endsWith('.js') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  );
}

function resolvePipelineFragmentPath(ref: string): string {
  if (path.isAbsolute(ref)) {
    throw new Error(`core:include: absolute paths are not allowed: ${ref}`);
  }
  const normalized = ref.startsWith('./') ? ref.slice(2) : ref;
  const pipelinesDir = path.join(rootResolve('.'));
  const relativeRef = normalized.startsWith('pipelines/')
    ? normalized.slice('pipelines/'.length)
    : normalized;
  const resolved = path.resolve(path.join(pipelinesDir, 'pipelines'), relativeRef);
  const relative = path.relative(path.join(pipelinesDir, 'pipelines'), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`core:include: path must be within pipelines/: ${ref}`);
  }
  return resolved;
}

function parsePipelineFragment(raw: string, ref: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    const repaired = tryRepairJson(raw);
    if (repaired !== null) return repaired;
    throw new Error(`core:include: fragment at ${ref} contains invalid JSON`);
  }
}

/**
 * Expand statically-addressable core:include nodes for preflight only.
 * Runtime execution keeps the original include node so context interpolation
 * and the existing include result contract remain unchanged. Dynamic refs are
 * intentionally left for runtime resolution; static refs must be visible to
 * schema/guardrail/graph lint before any actuator runs.
 */
export function expandPipelineIncludesForGuardrails<T extends { steps?: unknown[] }>(
  pipeline: T
): T {
  const expandSteps = (steps: unknown[], includeStack: ReadonlySet<string>): unknown[] =>
    steps.flatMap((rawStep) => {
      if (!rawStep || typeof rawStep !== 'object') return [rawStep];
      const step = rawStep as Record<string, any>;
      const params = (step.params ?? {}) as Record<string, any>;
      const isInclude = step.op === 'core:include' || step.op === 'include';
      const ref = typeof params.fragment === 'string' ? params.fragment : params.path;
      if (isInclude && typeof ref === 'string' && ref.trim() && !ref.includes('{{')) {
        const fragmentPath = resolvePipelineFragmentPath(ref.trim());
        if (!safeExistsSync(fragmentPath)) {
          throw new Error(`core:include: fragment not found: ${ref} (resolved: ${fragmentPath})`);
        }
        if (includeStack.has(fragmentPath)) {
          throw new Error(
            `core:include: circular reference detected — ${ref} is already in the include chain`
          );
        }
        const fragment = parsePipelineFragment(
          String(safeReadFile(fragmentPath, { encoding: 'utf8' })),
          ref
        );
        if (!Array.isArray(fragment?.steps)) {
          throw new Error(`core:include: fragment ${ref} must contain a steps array`);
        }
        return expandSteps(fragment.steps, new Set([...includeStack, fragmentPath]));
      }

      const expandedParams = { ...params };
      for (const key of ['then', 'else', 'do', 'calls', 'pipeline', 'steps']) {
        if (Array.isArray(expandedParams[key])) {
          expandedParams[key] = expandSteps(expandedParams[key], includeStack);
        }
      }
      const fallback = step.on_error?.fallback;
      return [
        {
          ...step,
          params: expandedParams,
          ...(Array.isArray(fallback)
            ? { on_error: { ...step.on_error, fallback: expandSteps(fallback, includeStack) } }
            : {}),
        },
      ];
    });

  return {
    ...pipeline,
    steps: Array.isArray(pipeline.steps) ? expandSteps(pipeline.steps, new Set()) : pipeline.steps,
  } as T;
}

async function readWorkflowModuleInput<T = any>(inputPath: string): Promise<T> {
  const moduleUrl = pathToFileURL(resolveAdfInputPath(inputPath)).href;
  const loaded = await import(moduleUrl);
  const candidate = loaded.default ?? loaded.workflow ?? loaded.pipeline ?? loaded.adf;
  return (candidate ?? loaded) as T;
}

export function readValidatedPipelineAdf<T = any>(inputPath: string): T {
  const pipeline = validatePipelineAdf(readJsonInput(inputPath));
  const expanded = expandPipelineIncludesForGuardrails(pipeline);
  const guardrails = validatePipelineGuardrails(expanded as any, inputPath);
  if (!guardrails.ok) {
    const details = guardrails.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => `${finding.path} ${finding.message}`)
      .join('; ');
    throw new Error(`Invalid pipeline ADF guardrails: ${details}`);
  }
  return pipeline as T;
}

export async function readValidatedWorkflowAdf<T = any>(inputPath: string): Promise<T> {
  const raw = isWorkflowModulePath(inputPath)
    ? await readWorkflowModuleInput<T>(inputPath)
    : readJsonInput<T>(inputPath);
  const pipeline = validatePipelineAdf(raw);
  const expanded = expandPipelineIncludesForGuardrails(pipeline);
  const guardrails = validatePipelineGuardrails(expanded as any, inputPath);
  if (!guardrails.ok) {
    const details = guardrails.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => `${finding.path} ${finding.message}`)
      .join('; ');
    throw new Error(`Invalid pipeline ADF guardrails: ${details}`);
  }
  return pipeline as T;
}
