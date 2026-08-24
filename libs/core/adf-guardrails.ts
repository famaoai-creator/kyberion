import { pathResolver } from './path-resolver.js';
import { safeExistsSync, validateUrl } from './secure-io.js';
import { readJson } from './foundation/json.js';
import {
  evaluateShellCommandPolicy,
  loadShellCommandPolicy,
  type ShellCommandPolicyFile,
} from './shell-command-policy.js';
import { evaluateEgressPolicy } from './egress-policy.js';
import type { PipelineAdf, PipelineAdfStep, StepHook } from './pipeline-contract.js';
import { deriveExecutionGraph } from './graph-scheduler.js';
import { resolveMaxRouteHops } from './judge-route.js';

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
    max_transform_script_chars: number;
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
    max_transform_script_chars: 400,
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
    const parsed = readJson<Partial<AdfExecutionPolicy>>(POLICY_PATH);
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
        max_transform_script_chars: coercePositiveInt(
          parsed?.limits?.max_transform_script_chars,
          DEFAULT_POLICY.limits.max_transform_script_chars
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

/**
 * PI-19 / DH-14: commands that can mutate another co-executing session's
 * working tree are never safe as an unqualified ADF shell step. Read-only
 * git commands and explicit-path add/commit/push commands remain available;
 * broad reset/checkout/clean/stash/force operations must use a separately
 * governed recovery surface.
 */
export function forbiddenGitCoexecutionMutation(command: string): string | undefined {
  const checks: Array<[RegExp, string]> = [
    [/\bgit\s+reset\s+[^;&|]*--hard\b/iu, 'git reset --hard'],
    [/\bgit\s+checkout\s+(?:--\s*)?\.\s*(?:$|[;&|])/iu, 'git checkout .'],
    [/\bgit\s+clean\s+-[^\s;&|]*f[^\s;&|]*/iu, 'git clean -f*'],
    [/\bgit\s+stash(?:\s|$)/iu, 'git stash'],
    [/\bgit\s+add\s+(?:--all|-A|\.)\s*(?:$|[;&|])/iu, 'git add -A/.'],
    [/\bgit\s+commit\b[^;&|]*--no-verify\b/iu, 'git commit --no-verify'],
    [/\bgit\s+push\b[^;&|]*(?:--force\b|-f\b)/iu, 'git push --force'],
  ];
  return checks.find(([pattern]) => pattern.test(command))?.[1];
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

  // GE-07: graph structure is linted before any actuator can run.
  const graph = deriveExecutionGraph(pipeline.steps);
  for (const error of graph.errors) {
    findings.push({
      code:
        error.code === 'cycle'
          ? 'graph-cycle'
          : error.code === 'missing-dependency'
            ? 'graph-missing-dependency'
            : error.code === 'missing-channel'
              ? 'graph-missing-channel'
              : error.code === 'duplicate-id'
                ? 'graph-duplicate-id'
                : 'graph-id-required-for-dependency',
      severity: error.code === 'missing-channel' ? 'warn' : 'error',
      message: error.message,
      path: sourcePath,
    });
  }
  for (const node of graph.graph.nodes) {
    if (node.index > 0 && node.incoming.length === 0) {
      findings.push({
        code: 'graph-unreachable-node',
        severity: 'warn',
        message: `Graph node "${node.id}" has no incoming edge and may be unreachable from the pipeline entry.`,
        path: `${sourcePath}.steps[${node.index}]`,
      });
    }
    if (node.incoming.length > 1 && !(node.value as PipelineAdfStep).merge) {
      findings.push({
        code: 'graph-unmerged-fanin',
        severity: 'warn',
        message: `Graph node "${node.id}" has ${node.incoming.length} incoming edges; declare merge: collect|namespace|last.`,
        path: `${sourcePath}.steps[${node.index}]`,
      });
    }
  }

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
      if (opName === 'system:shell' || opName === 'system:exec') {
        const params = (step.params ?? {}) as Record<string, unknown>;
        const command = [params.cmd, params.command, params.shell_command].find(
          (value): value is string => typeof value === 'string' && value.trim().length > 0
        );
        if (command) {
          const forbidden = forbiddenGitCoexecutionMutation(command);
          if (forbidden) {
            findings.push({
              code: 'git-coexecution-mutation-forbidden',
              severity: 'error',
              message: `${forbidden} is forbidden in an ADF shell step because it can mutate another session's worktree; use a governed explicit-path/recovery surface.`,
              path: `${stepPath}.params.cmd`,
            });
          }
          if (
            /(?:^|[;&|]\s*|\s)(?:node\s+dist\/|npx\s+tsx\b|pnpm\s+(?:exec|dlx)\b)/iu.test(
              command
            ) ||
            /dist\/libs\/actuators\//iu.test(command)
          ) {
            findings.push({
              code: 'script-wrapper-forbidden',
              severity: 'error',
              message:
                'ADF shell steps must not wrap scripts or actuators; use a typed operation or core:include.',
              path: `${stepPath}.params.cmd`,
            });
          }
        }
      }
      if (opName === 'core:include' || opName === 'include') {
        const includeParams = (step.params ?? {}) as Record<string, unknown>;
        const includeRef = includeParams.fragment ?? includeParams.path;
        if (
          typeof includeRef !== 'string' ||
          includeRef.trim().length === 0 ||
          includeRef.includes('{{')
        ) {
          findings.push({
            code: 'include-ref-dynamic',
            severity: 'warn',
            message:
              'core:include uses a dynamic or empty fragment reference; nested guardrails and graph lint will run only after runtime resolution.',
            path: `${stepPath}.params.fragment`,
          });
        }
      }
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

      // LE-04: logic-layering lint. core:transform JS-in-a-string is an escape
      // hatch for small glue; substantial logic belongs in a typed actuator op
      // (docs/developer/improvement-plans-2026-07/LAYERED_EXECUTION_PLAN_2026-07-15.ja.md).
      if (opName === 'core:transform') {
        const params = (step.params ?? {}) as Record<string, unknown>;
        const script = typeof params.script === 'string' ? params.script : '';
        if (script.length > policy.limits.max_transform_script_chars) {
          findings.push({
            code: 'transform-script-oversized',
            severity: 'error',
            message: `core:transform script is ${script.length} chars (limit ${policy.limits.max_transform_script_chars}) — move this logic into a typed actuator op instead of JS-in-a-string`,
            path: stepPath,
          });
        }
      }

      for (const condition of [
        (step.params as Record<string, unknown> | undefined)?.condition,
        (step.params as Record<string, unknown> | undefined)?.when,
        (step.params as Record<string, unknown> | undefined)?.until,
        (step as any).when,
      ]) {
        if (typeof condition === 'string' && looksLikeExpression(condition)) {
          findings.push({
            code: 'condition-looks-like-expression',
            severity: 'error',
            message:
              'String conditions must be paths or structured conditions; expression syntax is not evaluated.',
            path: `${stepPath}.params.condition`,
          });
        }
      }

      // TAKT Wave 1: validate judge_route targets before any actuator runs.
      // The model can propose a label, but it cannot invent a step id or an
      // unbounded back-edge.
      if (opName === 'core:judge_route' || opName === 'judge_route') {
        const params = (step.params ?? {}) as Record<string, unknown>;
        const routes = Array.isArray(params.routes) ? params.routes : [];
        const knownIds = new Set(
          steps
            .map((candidate) => candidate.id)
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        );
        if (routes.length === 0) {
          findings.push({
            code: 'judge-route-without-routes',
            severity: 'error',
            message: 'judge_route requires a non-empty params.routes array.',
            path: `${stepPath}.params.routes`,
          });
        }
        const noMatch = params.on_no_match;
        if (noMatch !== undefined && !['abort', 'complete', 'continue'].includes(String(noMatch))) {
          findings.push({
            code: 'judge-route-invalid-no-match',
            severity: 'error',
            message: 'judge_route on_no_match must be abort, complete, or continue.',
            path: `${stepPath}.params.on_no_match`,
          });
        }
        for (const [routeIndex, rawRoute] of routes.entries()) {
          if (!rawRoute || typeof rawRoute !== 'object') {
            findings.push({
              code: 'judge-route-invalid-route',
              severity: 'error',
              message: `judge_route route ${routeIndex + 1} must be an object.`,
              path: `${stepPath}.params.routes[${routeIndex}]`,
            });
            continue;
          }
          const next = String((rawRoute as Record<string, unknown>).next || '').trim();
          if (!next) {
            findings.push({
              code: 'judge-route-missing-target',
              severity: 'error',
              message: `judge_route route ${routeIndex + 1} must declare next.`,
              path: `${stepPath}.params.routes[${routeIndex}].next`,
            });
            continue;
          }
          if (!['COMPLETE', 'ABORT'].includes(next) && !knownIds.has(next)) {
            findings.push({
              code: 'judge-route-unknown-target',
              severity: 'error',
              message: `judge_route references unknown target step "${next}".`,
              path: `${stepPath}.params.routes[${routeIndex}].next`,
            });
          }
          const targetIndex = steps.findIndex((candidate) => candidate.id === next);
          if (targetIndex >= 0 && targetIndex <= index) {
            findings.push({
              code: 'judge-route-back-edge',
              severity: 'error',
              message: `judge_route has a back-edge to "${next}"; linear execution cannot safely rewind, so the route must target a later step or a terminal.`,
              path: `${stepPath}.params.routes[${routeIndex}].next`,
            });
          }
        }
        if (params.max_route_hops === undefined) {
          findings.push({
            code: 'loop-max-iterations-omitted',
            severity: 'warn',
            message: `judge_route max_route_hops omitted; defaulting to ${resolveMaxRouteHops(steps.length)}.`,
            path: `${stepPath}.params.max_route_hops`,
          });
        } else if (
          typeof params.max_route_hops !== 'number' ||
          !Number.isInteger(params.max_route_hops) ||
          params.max_route_hops < 1
        ) {
          findings.push({
            code: 'judge-route-invalid-hop-limit',
            severity: 'error',
            message: 'judge_route max_route_hops must be a positive integer.',
            path: `${stepPath}.params.max_route_hops`,
          });
        }
        if (String(noMatch || '') === 'continue') {
          findings.push({
            code: 'judge-route-continue-without-match',
            severity: 'warn',
            message:
              'judge_route on_no_match=continue leaves the next step unchanged; use abort unless intentional.',
            path: `${stepPath}.params.on_no_match`,
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
      step.op === 'core:accumulate' ||
      step.op === 'core:team_lead'
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
      if (step.op === 'core:team_lead') {
        const concurrency = params?.max_concurrency ?? params?.concurrency;
        if (typeof concurrency === 'number' && concurrency > 3) {
          findings.push({
            code: 'team-lead-concurrency-exceeded',
            severity: 'error',
            message: `team_lead max_concurrency (${concurrency}) exceeds governance limit (3)`,
            path: `${stepPath}.params.max_concurrency`,
          });
        }
      }
    }

    if (step.op === 'core:parallel_calls') {
      const params = step.params as Record<string, unknown> | undefined;
      const calls = Array.isArray(params?.calls) ? (params.calls as PipelineAdfStep[]) : undefined;
      if (calls) visitSteps(calls, `${stepPath}.params.calls`, depth + 1);
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
      if (params?.max_iterations === undefined && params?.maxIterations === undefined) {
        findings.push({
          code: 'graph-loop-without-bound',
          severity: 'error',
          message: 'Loop nodes must declare max_iterations.',
          path: `${stepPath}.params`,
        });
      }
    }

    const nestedPipeline = extractNestedPipeline(step);
    if (nestedPipeline) {
      visitSteps(nestedPipeline, `${stepPath}.params.pipeline`, depth + 1);
    }

    // LE-05 (AR-08 blind spot): media:pipeline embeds a nested steps array that
    // the schema does not see — walk it so budgets/lints apply there too.
    if (step.op === 'media:pipeline') {
      const params = step.params as Record<string, unknown> | undefined;
      const embedded = Array.isArray(params?.steps)
        ? (params?.steps as PipelineAdfStep[])
        : undefined;
      if (embedded) visitSteps(embedded, `${stepPath}.params.steps`, depth + 1);
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

  function looksLikeExpression(value: string): boolean {
    return /[<>]=?|={2,3}|&&|\|\||\.length\b|\b(?:and|or)\b/u.test(value);
  }
}

function coercePositiveInt(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? Math.floor(value) : Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}
