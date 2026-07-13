import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, validateUrl } from './secure-io.js';
import {
  evaluateShellCommandPolicy,
  loadShellCommandPolicy,
  type ShellCommandPolicyFile,
} from './shell-command-policy.js';
import { evaluateEgressPolicy } from './egress-policy.js';
import type { PipelineAdf, PipelineAdfStep, StepHook } from './pipeline-contract.js';

export interface AdfGuardrailFinding {
  code: string;
  severity: 'error' | 'warn';
  message: string;
  path: string;
}

export interface AdfGuardrailReport {
  ok: boolean;
  findings: AdfGuardrailFinding[];
}

interface AdfExecutionPolicy {
  limits: {
    max_steps: number;
    max_hooks_per_step: number;
    max_foreach_items: number;
    max_branch_depth: number;
  };
  network: {
    allow_local_network: boolean;
  };
}

const DEFAULT_POLICY: AdfExecutionPolicy = {
  limits: {
    max_steps: 500,
    max_hooks_per_step: 8,
    max_foreach_items: 100,
    max_branch_depth: 16,
  },
  network: {
    allow_local_network: false,
  },
};

const POLICY_PATH = pathResolver.knowledge('product/governance/adf-execution-policy.json');

let cachedPolicy: AdfExecutionPolicy | null = null;

export function resetAdfGuardrailPolicyCache(): void {
  cachedPolicy = null;
}

function loadAdfExecutionPolicy(): AdfExecutionPolicy {
  if (cachedPolicy) return cachedPolicy;

  if (!safeExistsSync(POLICY_PATH)) {
    cachedPolicy = DEFAULT_POLICY;
    return cachedPolicy;
  }

  try {
    const parsed = JSON.parse(
      safeReadFile(POLICY_PATH, { encoding: 'utf8' }) as string
    ) as Partial<AdfExecutionPolicy>;
    cachedPolicy = {
      limits: {
        max_steps: coercePositiveInt(parsed?.limits?.max_steps, DEFAULT_POLICY.limits.max_steps),
        max_hooks_per_step: coercePositiveInt(
          parsed?.limits?.max_hooks_per_step,
          DEFAULT_POLICY.limits.max_hooks_per_step
        ),
        max_foreach_items: coercePositiveInt(
          parsed?.limits?.max_foreach_items,
          DEFAULT_POLICY.limits.max_foreach_items
        ),
        max_branch_depth: coercePositiveInt(
          parsed?.limits?.max_branch_depth,
          DEFAULT_POLICY.limits.max_branch_depth
        ),
      },
      network: {
        allow_local_network: parsed?.network?.allow_local_network === true,
      },
    };
  } catch {
    cachedPolicy = DEFAULT_POLICY;
  }

  return cachedPolicy;
}

function getShellPolicy(): ShellCommandPolicyFile {
  return loadShellCommandPolicy();
}

export function validatePipelineGuardrails(
  pipeline: PipelineAdf,
  sourcePath = 'pipeline'
): AdfGuardrailReport {
  const findings: AdfGuardrailFinding[] = [];
  const policy = loadAdfExecutionPolicy();
  let totalSteps = 0;

  const rawMaxSteps = pipeline.options?.max_steps;
  const explicitMaxSteps = typeof rawMaxSteps === 'number' && Number.isFinite(rawMaxSteps);
  const maxSteps = explicitMaxSteps ? Math.floor(rawMaxSteps) : policy.limits.max_steps;
  if (explicitMaxSteps && maxSteps < 1) {
    findings.push({
      code: 'invalid-max-steps',
      severity: 'error',
      message: `options.max_steps must be a positive integer; got ${pipeline.options?.max_steps}`,
      path: `${sourcePath}.options.max_steps`,
    });
  }
  if (maxSteps > policy.limits.max_steps) {
    findings.push({
      code: 'max-steps-policy',
      severity: 'error',
      message: `options.max_steps (${maxSteps}) exceeds governance limit (${policy.limits.max_steps})`,
      path: `${sourcePath}.options.max_steps`,
    });
  }

  visitSteps(pipeline.steps, `${sourcePath}.steps`, 0);

  return {
    ok: findings.every((finding) => finding.severity !== 'error'),
    findings,
  };

  function visitSteps(steps: PipelineAdfStep[], basePath: string, depth: number): void {
    if (!Array.isArray(steps)) return;

    if (depth > policy.limits.max_branch_depth) {
      findings.push({
        code: 'branch-depth-exceeded',
        severity: 'error',
        message: `Nested pipeline depth (${depth}) exceeds governance limit (${policy.limits.max_branch_depth})`,
        path: basePath,
      });
      return;
    }

    let sawDistillOp = false;
    for (const [index, step] of steps.entries()) {
      totalSteps += 1;
      const stepPath = `${basePath}[${index}]`;
      if (totalSteps > maxSteps) {
        findings.push({
          code: 'step-budget-exceeded',
          severity: 'error',
          message: `Pipeline step count (${totalSteps}) exceeds max_steps (${maxSteps})`,
          path: stepPath,
        });
      }

      // LC-05: semantic-op placement lint (see
      // knowledge/product/governance/llm-invocation-rubric.md). Warnings only —
      // authors may have a reason, but the default shape is distill → decide,
      // selection over generation.
      const opName = String(step.op || '');
      if (opName.includes('distill')) sawDistillOp = true;
      if (opName === 'llm_decide' || opName.endsWith(':llm_decide')) {
        const params = (step.params ?? {}) as Record<string, unknown>;
        if (!sawDistillOp && params.observation == null && params.from == null) {
          findings.push({
            code: 'llm-decide-without-distill',
            severity: 'warn',
            message:
              'llm_decide has no preceding distill op and no explicit observation/from — the rubric expects a deterministic distillation before a semantic decision',
            path: stepPath,
          });
        }
        if (!Array.isArray(params.options) && params.on_degraded == null) {
          findings.push({
            code: 'llm-decide-without-fallback',
            severity: 'warn',
            message:
              'generation-mode llm_decide (no options) without on_degraded — prefer selection mode, or declare how degradation is handled',
            path: stepPath,
          });
        }
      }

      inspectStep(step, stepPath, depth);
    }
  }

  function inspectStep(step: PipelineAdfStep, stepPath: string, depth: number): void {
    const hooks = [
      ...(step.hooks?.before ?? []).map((hook, hookIndex) => ({
        hook,
        phase: 'before' as const,
        hookIndex,
      })),
      ...(step.hooks?.after ?? []).map((hook, hookIndex) => ({
        hook,
        phase: 'after' as const,
        hookIndex,
      })),
    ];

    if (hooks.length > policy.limits.max_hooks_per_step) {
      findings.push({
        code: 'hook-budget-exceeded',
        severity: 'error',
        message: `Step has ${hooks.length} hooks; governance limit is ${policy.limits.max_hooks_per_step}`,
        path: `${stepPath}.hooks`,
      });
    }

    for (const { hook, phase, hookIndex } of hooks) {
      inspectHook(hook, `${stepPath}.hooks.${phase}[${hookIndex}]`);
    }

    if (step.op === 'core:if') {
      const params = step.params as Record<string, unknown> | undefined;
      const thenBranch = Array.isArray(params?.then)
        ? (params?.then as PipelineAdfStep[])
        : undefined;
      const elseBranch = Array.isArray(params?.else)
        ? (params?.else as PipelineAdfStep[])
        : undefined;
      if (thenBranch) visitSteps(thenBranch, `${stepPath}.params.then`, depth + 1);
      if (elseBranch) visitSteps(elseBranch, `${stepPath}.params.else`, depth + 1);
    }

    if (
      step.op === 'core:foreach' ||
      step.op === 'core:parallel_foreach' ||
      step.op === 'core:accumulate'
    ) {
      const params = step.params as Record<string, unknown> | undefined;
      const items = params?.items;
      if (Array.isArray(items) && items.length > policy.limits.max_foreach_items) {
        findings.push({
          code: 'foreach-items-exceeded',
          severity: 'error',
          message: `foreach items (${items.length}) exceed governance limit (${policy.limits.max_foreach_items})`,
          path: `${stepPath}.params.items`,
        });
      }
      const body = Array.isArray(params?.do) ? (params?.do as PipelineAdfStep[]) : undefined;
      if (body) visitSteps(body, `${stepPath}.params.do`, depth + 1);
    }

    if (
      step.op === 'core:while' ||
      step.op === 'core:loop_until' ||
      step.op === 'core:retry_until_quality'
    ) {
      const params = step.params as Record<string, unknown> | undefined;
      const body = Array.isArray(params?.pipeline)
        ? (params?.pipeline as PipelineAdfStep[])
        : undefined;
      if (body) visitSteps(body, `${stepPath}.params.pipeline`, depth + 1);
    }

    const nestedPipeline = extractNestedPipeline(step);
    if (nestedPipeline) {
      visitSteps(nestedPipeline, `${stepPath}.params.pipeline`, depth + 1);
    }

    const fallback = step.on_error?.fallback;
    if (Array.isArray(fallback)) {
      visitSteps(fallback, `${stepPath}.on_error.fallback`, depth + 1);
    }
  }

  function inspectHook(hook: StepHook, hookPath: string): void {
    if (hook.type === 'command') {
      const verdict = evaluateShellCommandPolicy(String(hook.cmd ?? ''), getShellPolicy());
      if (verdict.verdict !== 'allow') {
        findings.push({
          code: verdict.verdict === 'deny' ? 'command-denied' : 'command-requires-approval',
          severity: 'error',
          message: verdict.reason,
          path: `${hookPath}.cmd`,
        });
      }
      return;
    }

    if (hook.type === 'http') {
      const url = String(hook.url ?? '');
      if (!url.includes('{{')) {
        try {
          validateUrl(url, { allowLocalNetwork: policy.network.allow_local_network });
          const egressDecision = evaluateEgressPolicy(url);
          if (egressDecision.verdict !== 'allow') {
            findings.push({
              code: egressDecision.verdict === 'deny' ? 'http-egress-denied' : 'http-egress-review',
              severity: 'error',
              message: egressDecision.reason,
              path: `${hookPath}.url`,
            });
          }
        } catch (err: any) {
          findings.push({
            code: 'http-url-invalid',
            severity: 'error',
            message: err?.message || `Invalid URL: ${url}`,
            path: `${hookPath}.url`,
          });
        }
      }
    }
  }

  function extractNestedPipeline(step: PipelineAdfStep): PipelineAdfStep[] | undefined {
    const params = step.params as Record<string, unknown> | undefined;
    if (!params) return undefined;
    const nested = params.pipeline;
    return Array.isArray(nested) ? (nested as PipelineAdfStep[]) : undefined;
  }
}

function coercePositiveInt(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? Math.floor(value) : Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}
