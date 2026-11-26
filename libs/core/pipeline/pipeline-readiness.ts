/**
 * `pnpm pipeline check <file>` — every gate a run would meet, answered before
 * the run (pipeline-run-manifest-model §5).
 *
 * Extends the static dry-run report with readiness checks (scope, trust,
 * model, secrets, effects, principal), each carrying the `next` command that
 * clears it. Never dispatches a step, installs a provider, reads a secret
 * value, spends a charter decision, or creates an approval request.
 */
import { determineActuatorStepType } from '../actuator/actuator-op-registry.js';
import {
  credentialBindingReadiness,
  type CredentialBindingReadiness,
} from '../foundation/credential-binding.js';
import {
  browserOperationRequiresAdmission,
  operationAuthorization,
  requiresApprovalAdmission,
} from '../foundation/authorization-registry.js';
import type { RunManifestRunUsage } from '../governance/accountability-charter-registry.js';
import { runManifestApprovalRunUsage } from '../governance/run-manifest-charter.js';
import { isBuiltinPipelineResource } from '../governance/trust-requiring-resources.js';
import * as pathResolver from '../path-resolver.js';
import {
  assertProjectTrustApproval,
  findValidProjectTrustApproval,
  findValidRunManifestTrustApproval,
} from '../project/project-trust.js';
import {
  bootstrapReasonNeedsModel,
  pipelineBootstrapNeeds,
} from '../reasoning/pipeline-bootstrap-needs.js';
import { currentScopeEnvelope, withScopeEnvelope } from '../scope-envelope.js';
import type { PipelineAdf, PipelineAdfStep } from './pipeline-contract.js';
import {
  assessPipelineDryRun,
  collectSteps,
  type PipelineDryRunCheck,
  type PipelineDryRunOptions,
  type PipelineDryRunReport,
} from './pipeline-dry-run.js';
import { normalizePipelineOp } from './pipeline-op-aliases.js';
import { resolveRunPrincipal, type RunPrincipal } from './run-principal.js';
import { deriveRunScope, runScopeEnvelope, type RunScope } from './run-scope.js';
import { secretExportVariables, type RunManifest } from './run-manifest.js';
import { BROWSER_NATIVE_FORMAT, type RunManifestSourceFormat } from './run-manifest-native.js';
import {
  classifyPipelineBrowserOptions,
  describeDroppedBrowserOption,
  pipelineUsesBrowser,
} from './pipeline-browser-options.js';
import {
  compilePipelineFileRunManifest,
  type RunManifestPipelineSource,
} from './run-manifest-session.js';
import {
  formatArgsSuggestion,
  locateStepByEntryId,
  suggestEvaluateStepArgs,
} from './run-manifest-args-suggest.js';
import { planPipelineFix } from './pipeline-fix.js';

/** Readiness check ids, in display order. */
export const READINESS_CHECK_IDS = [
  'scope',
  'trust',
  'model',
  'secrets',
  'effects',
  'browser',
  'principal',
] as const;

export interface PipelineReadinessInput {
  inputPath: string;
  /** The statically loaded pipeline; absent when it could not be loaded. */
  pipeline?: PipelineAdf & { pipeline_id?: string };
  /** Why the pipeline could not be loaded (contract / guardrail validation). */
  loadError?: string;
  /** Approval id the operator passed with --project-trust-approval. */
  projectTrustApprovalId?: string;
  /** The operator passed --delegated-trust (evaluated at run time only). */
  delegatedTrustRequested?: boolean;
  /** TTY presence as the runner resolves it (resolvePipelineHumanPresence). */
  hasHuman?: boolean;
  dryRun?: PipelineDryRunOptions;
  /**
   * The exact JSON text and the unexpanded validated pipeline the runner
   * would execute; compiles the Run Manifest the trust and effects checks
   * report on. Absent for workflow modules.
   */
  manifestSource?: {
    sourceText: string;
    pipeline: RunManifestPipelineSource;
    /** `browser_native`: a browser actuator native pipeline (run-manifest-native.ts). */
    format?: RunManifestSourceFormat;
  };
}

/** Test seams; production uses the real registries. */
export interface PipelineReadinessDeps {
  deriveScope?: (inputPath: string) => RunScope;
  findTrustApproval?: (inputPath: string) => string | null;
  /** A v2 approval bound to this manifest hash (findValidRunManifestTrustApproval). */
  findManifestApproval?: (inputPath: string, manifestHash: string) => string | null;
  verifyTrustApproval?: (approvalId: string, inputPath: string) => void;
  /** Today's (UTC) runs against the daily cap (runManifestApprovalRunUsage). */
  manifestRunUsage?: (
    approvalId: string,
    manifest: RunManifest
  ) => Pick<RunManifestRunUsage, 'runs_today' | 'runs_per_day'>;
  credentialReadiness?: () => CredentialBindingReadiness;
  resolvePrincipal?: (input: { hasHuman: boolean | undefined }) => RunPrincipal;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Split a `what — why | next: cmd` diagnostic into message and next. */
function splitDiagnostic(text: string): { message: string; next?: string } {
  const index = text.lastIndexOf(' | next: ');
  return index < 0
    ? { message: text }
    : { message: text.slice(0, index), next: text.slice(index + ' | next: '.length) };
}

function scopeCheck(scope: RunScope | undefined, error: unknown): PipelineDryRunCheck {
  if (!scope) {
    const split = splitDiagnostic(message(error));
    return {
      id: 'scope',
      status: 'blocked',
      message: split.message,
      next: split.next ?? 'move the pipeline under knowledge/confidential/<tenant>/',
    };
  }
  if (scope.tenant_slug)
    return {
      id: 'scope',
      status: 'pass',
      message: `tenant ${scope.tenant_slug} (${scope.tier}; derived from the file location)`,
    };
  return {
    id: 'scope',
    status: 'pass',
    message: `no tenant from the file location (${scope.tier}) — runs in the ambient scope${
      scope.ambient_tenant_slug ? ` (tenant ${scope.ambient_tenant_slug})` : ''
    }`,
  };
}

/** Whether a v2 (manifest) approval would pre-approve anything this run does. */
function manifestPreApproves(manifest: RunManifest | undefined): manifest is RunManifest {
  return Boolean(
    manifest?.scope.tenant_slug && manifest.requirements.effects.some((entry) => entry.bindable)
  );
}

function defaultManifestRunUsage(
  approvalId: string,
  manifest: RunManifest
): Pick<RunManifestRunUsage, 'runs_today' | 'runs_per_day'> {
  return runManifestApprovalRunUsage({ approvalRequestId: approvalId, manifest });
}

/**
 * A native browser pipeline runs through the browser actuator, which never
 * required file trust: an approval only pre-approves its external steps
 * (pipeline-run-manifest-model §3.5). v1 (file-only) approvals do not apply.
 */
function nativeTrustCheck(
  relative: string,
  request: string,
  manifest: RunManifest | undefined,
  manifestApproval: string | null,
  withManifest: (id: string, bound: RunManifest) => PipelineDryRunCheck
): PipelineDryRunCheck {
  const run = `pnpm kyberion browser run --adf ${relative}`;
  if (manifestApproval && manifest) {
    const bound = withManifest(manifestApproval, manifest);
    return { ...bound, next: bound.next ?? run };
  }
  if (!manifestPreApproves(manifest))
    return {
      id: 'trust',
      status: 'pass',
      message: 'native browser pipeline — runs without file trust; nothing to pre-approve',
      next: run,
    };
  return {
    id: 'trust',
    status: 'warning',
    message:
      'no approved manifest for the current content — the native browser pipeline runs, but every external step asks for its own approval',
    next: `${request}, then pnpm kyberion approvals --approve <request-id>`,
  };
}

function trustCheck(
  input: PipelineReadinessInput,
  deps: PipelineReadinessDeps,
  manifest: RunManifest | undefined
): PipelineDryRunCheck {
  const relative = pathResolver.toRepoRelative(pathResolver.rootResolve(input.inputPath));
  const request = `pnpm kyberion project-trust request ${relative}`;
  const run = (id: string) => `pnpm pipeline --input ${relative} --project-trust-approval ${id}`;
  if (isBuiltinPipelineResource(relative))
    return { id: 'trust', status: 'pass', message: 'repository-owned pipeline (built-in trust)' };
  // The runner binds the newest v2 approval of this exact manifest on its own.
  let manifestApproval: string | null = null;
  if (manifestPreApproves(manifest)) {
    try {
      manifestApproval = (deps.findManifestApproval ?? findValidRunManifestTrustApproval)(
        relative,
        manifest.manifest_hash
      );
    } catch {
      manifestApproval = null;
    }
  }
  const short = manifest ? manifest.manifest_hash.slice(0, 12) : '';
  const withoutManifest = (id: string): PipelineDryRunCheck =>
    manifestPreApproves(manifest)
      ? {
          id: 'trust',
          status: 'warning',
          message: `approved without manifest (${id}) — every external step will ask; re-request: ${request}`,
          next: request,
        }
      : {
          id: 'trust',
          status: 'pass',
          message: `approved for the current content (${id})`,
          next: run(id),
        };
  // A bound approval reports today's (UTC) runs against its daily cap.
  const withManifest = (id: string, bound: RunManifest): PipelineDryRunCheck => {
    let usage: Pick<RunManifestRunUsage, 'runs_today' | 'runs_per_day'> | undefined;
    try {
      usage = (deps.manifestRunUsage ?? defaultManifestRunUsage)(id, bound);
    } catch {
      usage = undefined;
    }
    const today = usage ? `; ${usage.runs_today}/${usage.runs_per_day} runs today` : '';
    if (usage && usage.runs_today >= usage.runs_per_day)
      return {
        id: 'trust',
        status: 'warning',
        message: `approved (manifest ${short}; ${id}${today}) — daily run cap reached; further runs today (UTC) ask for every external step`,
        next: `run again after 00:00 UTC, or re-approve with a higher cap: ${request} --runs-per-day <N>`,
      };
    return { id: 'trust', status: 'pass', message: `approved (manifest ${short}; ${id}${today})` };
  };
  if (input.manifestSource?.format === BROWSER_NATIVE_FORMAT)
    return nativeTrustCheck(relative, request, manifest, manifestApproval, withManifest);
  if (input.projectTrustApprovalId) {
    try {
      (deps.verifyTrustApproval ?? assertProjectTrustApproval)(
        input.projectTrustApprovalId,
        relative
      );
    } catch (error) {
      return {
        id: 'trust',
        status: 'blocked',
        message: `approval ${input.projectTrustApprovalId} does not cover this file — ${message(error)}`,
        next: request,
      };
    }
    return manifestApproval && manifest
      ? withManifest(manifestApproval, manifest)
      : withoutManifest(input.projectTrustApprovalId);
  }
  if (manifestApproval && manifest) {
    const bound = withManifest(manifestApproval, manifest);
    return { ...bound, next: bound.next ?? run(manifestApproval) };
  }
  let approvalId: string | null = null;
  try {
    approvalId = (deps.findTrustApproval ?? findValidProjectTrustApproval)(relative);
  } catch (error) {
    return {
      id: 'trust',
      status: 'blocked',
      message: `project-trust approvals could not be read — ${message(error)}`,
      next: request,
    };
  }
  if (approvalId) return withoutManifest(approvalId);
  if (input.delegatedTrustRequested)
    return {
      id: 'trust',
      status: 'warning',
      message:
        'charter delegation is decided at run time (it records a charter decision); check does not spend it',
      next: `pnpm pipeline --input ${relative} --delegated-trust`,
    };
  return {
    id: 'trust',
    status: 'blocked',
    message: 'not approved — a project-local pipeline needs a human project-trust approval',
    next: `${request}, then pnpm kyberion approvals --approve <request-id>`,
  };
}

function modelCheck(
  steps: readonly PipelineAdfStep[],
  scope: RunScope | undefined,
  deps: PipelineReadinessDeps
): PipelineDryRunCheck {
  const needs = pipelineBootstrapNeeds(steps, normalizePipelineOp);
  if (!needs.model)
    return { id: 'model', status: 'pass', message: 'not needed (deterministic steps only)' };
  const modelReasons = needs.reasons.filter(bootstrapReasonNeedsModel);
  // The display list is capped; the model need itself is decided uncapped.
  const reasons = modelReasons.length ? modelReasons.join(', ') : 'a model-calling step';
  let readiness: CredentialBindingReadiness;
  try {
    const probe = deps.credentialReadiness ?? credentialBindingReadiness;
    const envelope = scope
      ? runScopeEnvelope(scope, {
          parent: currentScopeEnvelope(),
          // Session ids are single path-free tokens; the check never persists this envelope.
          session_id: 'pipeline-check',
          purpose: `pipeline check ${scope.input_path}`,
        })
      : undefined;
    readiness = envelope ? withScopeEnvelope(envelope, probe) : probe();
  } catch (error) {
    return {
      id: 'model',
      status: 'blocked',
      message: `needed by ${reasons}; credential readiness could not be resolved — ${message(error)}`,
      next: 'resolve the scope check first',
    };
  }
  if (readiness.status === 'binding_required')
    return {
      id: 'model',
      status: 'blocked',
      message: `needed by ${reasons}; tenant ${readiness.identity.tenantSlug ?? '(personal claim)'} reasoning needs a task credential binding`,
      next: 'execute the pipeline as a claimed WorkItem through the agent execution port (dispatch mints the binding)',
    };
  return {
    id: 'model',
    status: 'pass',
    message: `needed by ${reasons}; ${
      readiness.status === 'bound' ? 'task credential binding present' : 'operator credentials'
    }`,
  };
}

function secretRef(step: PipelineAdfStep): string {
  const params = step.params || {};
  const service = typeof params.service === 'string' ? params.service : '?';
  const account = typeof params.account === 'string' ? params.account : '?';
  return `${service}/${account}`;
}

function secretsCheck(steps: readonly PipelineAdfStep[]): PipelineDryRunCheck {
  const refs = [
    ...new Set(
      steps.filter((step) => normalizePipelineOp(step.op) === 'secret:get').map(secretRef)
    ),
  ];
  if (refs.length === 0) return { id: 'secrets', status: 'pass', message: 'none referenced' };
  return {
    id: 'secrets',
    status: 'pass',
    message: `${refs.join(', ')} (references only — values are never read; existence is not checked)`,
  };
}

function requiresExternalAdmission(op: string): boolean {
  const separator = op.indexOf(':');
  if (separator < 1) return false;
  const domain = op.slice(0, separator);
  const action = op.slice(separator + 1);
  if (domain === 'browser') {
    try {
      return browserOperationRequiresAdmission(determineActuatorStepType(domain, action), action);
    } catch {
      return true;
    }
  }
  return requiresApprovalAdmission(operationAuthorization(op));
}

/** Fallback count when no Run Manifest could be compiled (workflow module, no scope). */
function effectsCountCheck(
  steps: readonly PipelineAdfStep[],
  relative: string
): PipelineDryRunCheck {
  const count = steps.filter((step) =>
    requiresExternalAdmission(normalizePipelineOp(step.op))
  ).length;
  if (count === 0)
    return { id: 'effects', status: 'pass', message: 'no step needs external-operation admission' };
  return {
    id: 'effects',
    status: 'warning',
    message: `${count} step(s) need external-operation admission; no run manifest could be compiled, so each asks for approval at run time`,
    next: `pnpm pipeline --input ${relative} from an interactive terminal`,
  };
}

/**
 * One line per templated page script: the ready-to-paste `script` + `args`
 * that make it pre-approvable, or why none could be generated.
 */
function templatedScriptSuggestions(manifest: RunManifest, steps: unknown): string[] {
  // Credentials (secret:get exports, {{env.X}}) are never moved into args.
  const secretVariables = secretExportVariables(steps);
  return manifest.requirements.effects
    .filter((entry) => entry.unbindable_reason === 'templated_script')
    .map((entry) => {
      const step = locateStepByEntryId(steps, entry.entry_id);
      return formatArgsSuggestion(
        entry.entry_id,
        step
          ? suggestEvaluateStepArgs(step, { secretVariables })
          : { ok: false, reason: 'the step could not be located' }
      );
    });
}

/** Run Manifest coverage: how many external steps one approval pre-approves, and why the rest ask. */
function effectsCheck(manifest: RunManifest, steps: unknown): PipelineDryRunCheck {
  const effects = manifest.requirements.effects;
  if (effects.length === 0 && manifest.complete)
    return { id: 'effects', status: 'pass', message: 'no step needs external-operation admission' };
  const bindable = effects.filter((entry) => entry.bindable).length;
  const parts = [`${effects.length} external step(s), ${bindable} pre-approvable`];
  const unbindable = effects.filter((entry) => !entry.bindable);
  if (unbindable.length)
    parts.push(
      `per-step approval: ${unbindable
        .map(
          (entry) =>
            `${entry.entry_id} ${entry.operation_id} (${entry.unbindable_reason ?? 'unbindable'})`
        )
        .join(', ')}`
    );
  if (!manifest.complete) parts.push(`not covered: ${manifest.incomplete_reasons.join('; ')}`);
  if (!manifest.scope.tenant_slug && bindable > 0)
    parts.push('pre-approval needs a tenant-scoped pipeline');
  const covered = bindable === effects.length && manifest.complete && manifest.scope.tenant_slug;
  const suggestions = [
    ...templatedScriptSuggestions(manifest, steps),
    // Native runs: the confined path that makes a file-writing step pre-approvable.
    ...effects.flatMap((entry) =>
      entry.write
        ? [
            `step ${entry.entry_id}: writes ${entry.write.path} outside the run's partition — set its path to ${entry.write.suggested_path} to pre-approve it`,
          ]
        : []
    ),
  ];
  return {
    id: 'effects',
    status: covered ? 'pass' : 'warning',
    message: parts.join('; '),
    ...(covered
      ? {}
      : {
          next: 'keep URLs literal, page scripts static (pass run-time values through evaluate args) and step files inside the run partition to make a step pre-approvable',
        }),
    ...(suggestions.length ? { details: suggestions } : {}),
  };
}

/**
 * Browser pipelines only: the declared browser options the run will not apply
 * (launch overrides, a profile or recording outside the file's partition).
 * The run drops them with a warning; this row shows it before the run.
 */
function browserOptionsCheck(
  pipeline: { options?: unknown; steps?: unknown },
  scope: RunScope | undefined
): PipelineDryRunCheck | undefined {
  if (!pipelineUsesBrowser(pipeline.steps)) return undefined;
  const { dropped } = classifyPipelineBrowserOptions(pipeline.options, scope);
  if (dropped.length === 0)
    return { id: 'browser', status: 'pass', message: 'every declared browser option applies' };
  return {
    id: 'browser',
    status: 'warning',
    message: `${dropped.length} declared option(s) will not be applied: ${dropped
      .map(describeDroppedBrowserOption)
      .join('; ')}`,
    next: dropped[0].next,
  };
}

/**
 * When `pnpm pipeline fix` has a mechanical rewrite for the effects or the
 * browser row, that row's next step names it (the planner is the same one the
 * command runs; a file it cannot plan keeps the generic advice).
 */
function pointAtPipelineFix(
  checks: PipelineDryRunCheck[],
  scope: RunScope | undefined,
  sourceText: string | undefined
): void {
  if (!scope || sourceText === undefined) return;
  let fixes: ReturnType<typeof planPipelineFix>['fixes'];
  try {
    const plan = planPipelineFix({ sourceText, scope });
    if (plan.refusal) return;
    fixes = plan.fixes;
  } catch {
    return;
  }
  const next = `pnpm pipeline fix ${scope.input_path} (dry run; --write applies it)`;
  const steps = fixes.filter((fix) => fix.kind !== 'user_data_dir').length;
  for (const check of checks) {
    if (check.id === 'effects' && steps > 0) check.next = `${next} — rewrites ${steps} step(s)`;
    if (check.id === 'browser' && fixes.some((fix) => fix.kind === 'user_data_dir'))
      check.next = `${next} — moves options.user_data_dir into the profile partition`;
  }
}

function principalCheck(
  hasHuman: boolean | undefined,
  deps: PipelineReadinessDeps
): PipelineDryRunCheck {
  const principal = (deps.resolvePrincipal ?? resolveRunPrincipal)({ hasHuman });
  if (principal.mode === 'attended')
    return {
      id: 'principal',
      status: 'pass',
      message: `attended (${principal.memberId}) — pre-approval applies only when this member approved the manifest`,
    };
  return {
    id: 'principal',
    status: 'warning',
    message: `unattended (${principal.reason}) — steps outside an approved manifest will suspend`,
    next: principal.reason.startsWith('agent-driven process')
      ? 'run it yourself from a plain terminal — an agent session is never attended'
      : hasHuman === true
        ? 'register the owner member: pnpm onboard'
        : 'run from an interactive terminal',
  };
}

function verdictOf(checks: readonly PipelineDryRunCheck[]): PipelineDryRunReport['verdict'] {
  if (checks.some((check) => check.status === 'blocked')) return 'blocked';
  return checks.some((check) => check.status === 'warning') ? 'warning' : 'ready';
}

/**
 * Readiness report: the dry-run report with the readiness checks first.
 * `side_effects` stays `none`.
 */
export function assessPipelineReadiness(
  input: PipelineReadinessInput,
  deps: PipelineReadinessDeps = {}
): PipelineDryRunReport {
  const relative = pathResolver.toRepoRelative(pathResolver.rootResolve(input.inputPath));
  let scope: RunScope | undefined;
  let scopeError: unknown;
  try {
    scope = (deps.deriveScope ?? deriveRunScope)(input.inputPath);
  } catch (error) {
    scopeError = error;
  }
  const steps = input.pipeline ? collectSteps(input.pipeline.steps || []) : [];
  let manifest: RunManifest | undefined;
  if (scope && input.manifestSource) {
    try {
      manifest = compilePipelineFileRunManifest({ scope, ...input.manifestSource });
    } catch {
      manifest = undefined;
    }
  }
  const readiness: PipelineDryRunCheck[] = [
    scopeCheck(scope, scopeError),
    trustCheck(input, deps, manifest),
  ];
  let base: PipelineDryRunReport;
  if (input.pipeline) {
    readiness.push(
      modelCheck(input.pipeline.steps || [], scope, deps),
      secretsCheck(steps),
      manifest
        ? effectsCheck(manifest, input.manifestSource?.pipeline.steps)
        : effectsCountCheck(steps, relative),
      ...[browserOptionsCheck(input.pipeline, scope)].filter(
        (check): check is PipelineDryRunCheck => check !== undefined
      ),
      principalCheck(input.hasHuman, deps)
    );
    pointAtPipelineFix(readiness, scope, input.manifestSource?.sourceText);
    base = assessPipelineDryRun(input.pipeline, input.dryRun);
  } else {
    readiness.push(principalCheck(input.hasHuman, deps));
    base = {
      version: '1.0',
      pipeline_id: relative,
      verdict: 'blocked',
      side_effects: 'none',
      checks: [
        {
          id: 'contract-validation',
          status: 'blocked',
          message: input.loadError ?? 'pipeline could not be loaded',
          next: 'fix the pipeline ADF/guardrail validation errors and rerun the check',
        },
      ],
      next_actions: [],
    };
  }
  const checks = [...readiness, ...base.checks];
  const nextActions: string[] = [];
  for (const check of readiness)
    if (check.next && !nextActions.includes(check.next)) nextActions.push(check.next);
  for (const action of base.next_actions)
    if (!nextActions.includes(action)) nextActions.push(action);
  return {
    ...base,
    verdict: verdictOf(checks),
    checks,
    next_actions: nextActions,
  };
}

const STATUS_MARK: Record<PipelineDryRunCheck['status'], string> = {
  pass: '✓',
  warning: '!',
  blocked: '✗',
};

/** Concise human table: readiness checks, then non-passing dry-run checks. */
export function formatPipelineReadinessReport(report: PipelineDryRunReport): string[] {
  const readinessIds = new Set<string>(READINESS_CHECK_IDS);
  const width = Math.max(...READINESS_CHECK_IDS.map((id) => id.length), 'capability'.length);
  const lines = [`[pipeline-check] ${report.verdict}: ${report.pipeline_id}`];
  const row = (check: PipelineDryRunCheck) => {
    lines.push(` ${STATUS_MARK[check.status]} ${check.id.padEnd(width)}  ${check.message}`);
    if (check.next) lines.push(` ${' '.repeat(width + 4)}next: ${check.next}`);
    for (const detail of check.details ?? []) lines.push(` ${' '.repeat(width + 4)}${detail}`);
  };
  for (const check of report.checks) if (readinessIds.has(check.id)) row(check);
  const staticChecks = report.checks.filter((check) => !readinessIds.has(check.id));
  for (const check of staticChecks) if (check.status !== 'pass') row(check);
  const passed = staticChecks.filter((check) => check.status === 'pass').length;
  if (passed > 0) lines.push(` ✓ ${'static'.padEnd(width)}  ${passed} contract check(s) pass`);
  const staticNext = report.next_actions.filter(
    (action) => !report.checks.some((check) => readinessIds.has(check.id) && check.next === action)
  );
  for (const action of staticNext) lines.push(` next: ${action}`);
  return lines;
}
