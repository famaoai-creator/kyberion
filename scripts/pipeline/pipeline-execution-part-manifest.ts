/**
 * Run scope, run requirements (model bootstrap), Run Manifest binding and
 * `pipeline check` wiring of the pipeline runner
 * (pipeline-run-manifest-model.md §3.4, §4, §5). Shared by the CLI (`main`)
 * and the library entry (`executePipelineFile`).
 */
import { logger } from '@agent/core/core';
import { currentScopeEnvelope, withScopeEnvelope } from '@agent/core/scope-envelope';
import type { ReasoningPayloadScope } from '@agent/core/reasoning/reasoning-egress-scope';
import type { PipelineAdf, PipelineAdfStep } from '@agent/core/pipeline/pipeline-contract';
import { pipelineBootstrapNeeds } from '@agent/core/reasoning/pipeline-bootstrap-needs';
import type { RunScope } from '@agent/core/pipeline/run-manifest';
import {
  withoutRunManifestBinding,
  withRunManifestBinding,
  type RunManifestBindingInput,
} from '@agent/core/governance/external-operation-runtime';
import { readTextFile } from '@agent/core/foundation';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { pathResolver } from '@agent/core/path-resolver';
import { ScriptExitError } from '../lib/harness.js';
import {
  expandPipelineIncludesForDryRun,
  readValidatedWorkflowAdf,
} from '../refactor/adf-input.js';
import {
  normalizePipelineOp,
  registeredEnv,
  resolvePipelineHumanPresence,
} from './pipeline-execution-part-bootstrap.js';

const PAYLOAD_TIER_RANK = { public: 0, confidential: 1, personal: 2 } as const;

/**
 * Payload tier/tenant for a run: the mission tier, raised to the tier of a
 * location-derived run scope, and the derived tenant over the ambient stance.
 */
export function runScopePayload(
  missionTier: string,
  runScope: RunScope | undefined
): { tier: ReasoningPayloadScope['tier']; tenant_slug?: string } {
  let tier: ReasoningPayloadScope['tier'] =
    missionTier === 'personal'
      ? 'personal'
      : missionTier === 'confidential'
        ? 'confidential'
        : 'public';
  const derived = runScope?.source === 'location' ? runScope : undefined;
  if (derived && PAYLOAD_TIER_RANK[derived.tier] > PAYLOAD_TIER_RANK[tier]) tier = derived.tier;
  const tenant = derived?.tenant_slug ?? (registeredEnv('KYBERION_STANCE')?.trim() || undefined);
  return { tier, ...(tenant ? { tenant_slug: tenant } : {}) };
}

/**
 * Derive the run scope from the file location and run `body` inside the
 * envelope it needs (a minted tenant envelope, a narrowed parent, or the
 * current one). A nested run may only narrow the active envelope.
 */
export async function withDerivedRunScope<T>(
  inputPath: string,
  runId: string,
  body: (runScope: RunScope) => Promise<T>
): Promise<T> {
  const { deriveRunScope, runScopeEnvelope } = await import('@agent/core/pipeline/run-manifest');
  const runScope = deriveRunScope(inputPath);
  const envelope = runScopeEnvelope(runScope, {
    parent: currentScopeEnvelope(),
    session_id: `pipeline:${runId}`,
    purpose: `pipeline ${runScope.input_path}`,
  });
  const execute = () => body(runScope);
  return envelope ? withScopeEnvelope(envelope, execute) : execute();
}

/**
 * Run start: compile the manifest of the exact loaded source and decide the
 * run's manifest binding (pipeline-run-manifest-model §3.3). Logs one line —
 * the coverage, or why the run is unbound — and never fails the run.
 */
export async function openPipelineRunManifest(input: {
  runScope: RunScope | undefined;
  sourceText: string | undefined;
  pipeline: { steps?: unknown; context?: unknown };
  hasHuman: boolean | undefined;
  runId: string;
  resumed: boolean;
}): Promise<RunManifestBindingInput | undefined> {
  if (!input.runScope) return undefined;
  const { openRunManifestSession } = await import('@agent/core/pipeline/run-manifest');
  const session = openRunManifestSession({
    scope: input.runScope,
    sourceText: input.sourceText,
    pipeline: input.pipeline,
    hasHuman: input.hasHuman,
    runId: input.runId,
    resumed: input.resumed,
  });
  logger[session.level](`   [PIPELINE] ${session.message}`);
  return session.binding;
}

export function bindRunManifest<T>(binding: RunManifestBindingInput | undefined, body: () => T): T {
  return binding ? withRunManifestBinding(binding, body) : body();
}

/** A nested run is not covered by its parent's manifest: it never inherits the binding. */
export function nestedPipelineRun<T>(body: () => T): T {
  return withoutRunManifestBinding(body);
}

/**
 * A browser actuator native pipeline file (`{action:'pipeline', steps:[{type,
 * op:'goto'}]}`) is not an ADF: its runner is the browser actuator. The check
 * reads it as authored — the ADF-shaped `browser:*` view for the static rows,
 * the exact text for its native Run Manifest. Never executed here.
 */
async function loadNativeBrowserPipelineForCheck(inputPath: string): Promise<
  | {
      pipeline: PipelineAdf;
      manifestSource: { sourceText: string; pipeline: PipelineAdf; format: 'browser_native' };
    }
  | undefined
> {
  const { isNativeBrowserPipelineDocument, nativeBrowserManifestSteps, BROWSER_NATIVE_FORMAT } =
    await import('@agent/core/pipeline/run-manifest');
  let sourceText: string;
  let parsed: unknown;
  try {
    sourceText = String(readTextFile(pathResolver.rootResolve(inputPath)));
    parsed = parseSafeJsonInput(sourceText, 'pipeline file');
  } catch {
    // Unreadable or not JSON: the ADF loader reports it.
    return undefined;
  }
  if (!isNativeBrowserPipelineDocument(parsed)) return undefined;
  const native = parsed as PipelineAdf;
  return {
    pipeline: { ...native, steps: nativeBrowserManifestSteps(native.steps) } as PipelineAdf,
    manifestSource: { sourceText, pipeline: native, format: BROWSER_NATIVE_FORMAT },
  };
}

/**
 * Load a pipeline for static inspection only. A project-local JSON pipeline is
 * parsed and validated before trust so the check can report every gate; it is
 * never executed here. Workflow modules (.ts/.js) are never imported pre-trust.
 */
async function loadPipelineForCheck(
  inputPath: string,
  trustResolved: boolean,
  projectTrustApprovalId: string | undefined
): Promise<{
  pipeline?: PipelineAdf;
  loadError?: string;
  manifestSource?: { sourceText: string; pipeline: PipelineAdf; format?: 'browser_native' };
}> {
  const isModule = /\.(ts|js|mjs|cjs)$/u.test(inputPath);
  if (!isModule) {
    const native = await loadNativeBrowserPipelineForCheck(inputPath);
    if (native) return native;
  }
  const load = async (trusted: boolean, approvalId?: string) => {
    let sourceText: string | undefined;
    const pipeline = await readValidatedWorkflowAdf<PipelineAdf>(inputPath, {
      trustResolved: trusted,
      projectTrustApprovalId: approvalId,
      // The exact bytes the runner would snapshot: the Run Manifest is
      // compiled from them and the UNEXPANDED steps, as at run start.
      ...(!isModule
        ? {
            onValidatedInput: (_loaded: unknown, source: string) => {
              sourceText = source;
            },
          }
        : {}),
    });
    return {
      pipeline: await expandPipelineIncludesForDryRun(pipeline, {
        trustResolved: trusted,
        projectTrustApprovalId: approvalId,
      }),
      ...(sourceText !== undefined ? { manifestSource: { sourceText, pipeline } } : {}),
    };
  };
  try {
    return await load(trustResolved, projectTrustApprovalId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('[TRUST_REQUIRED]') || isModule) return { loadError: message };
  }
  try {
    return await load(true);
  } catch (error) {
    return { loadError: error instanceof Error ? error.message : String(error) };
  }
}

/** `pnpm pipeline check <file>`: every run gate, without running a step. */
export async function runPipelineCheck(input: {
  inputPath: string;
  trustResolved: boolean;
  projectTrustApprovalId?: string;
  delegatedTrustRequested: boolean;
  json: boolean;
  /** Print each templated evaluate script's args rewrite, per step (never writes the file). */
  suggestArgs?: boolean;
  print: (value: unknown) => void;
}): Promise<void> {
  const loaded = await loadPipelineForCheck(
    input.inputPath,
    input.trustResolved,
    input.projectTrustApprovalId
  );
  const {
    assessPipelineReadiness,
    formatPipelineReadinessReport,
    formatArgsSuggestion,
    suggestArgsForPipelineDocument,
  } = await import('@agent/core/pipeline/run-manifest');
  if (input.suggestArgs) {
    let document: unknown;
    try {
      document = loaded.manifestSource ? JSON.parse(loaded.manifestSource.sourceText) : undefined;
    } catch {
      document = undefined;
    }
    if (document === undefined)
      throw new Error(
        `[PIPELINE_SUGGEST_ARGS] ${input.inputPath} could not be read as a JSON pipeline — ${
          loaded.loadError ?? 'workflow modules are not rewritten'
        } | next: pnpm pipeline check ${input.inputPath}`
      );
    // Per-step snippets only: re-serializing the parsed file would silently
    // change what JSON.parse cannot keep (big integers, duplicate keys,
    // formatting), and the author pastes each change into the file by hand.
    const { results } = suggestArgsForPipelineDocument(document);
    if (input.json) input.print(results);
    else if (results.length === 0)
      input.print(`[pipeline-check] no templated page script in ${input.inputPath}`);
    else
      for (const result of results)
        input.print(formatArgsSuggestion(result.step_path, result.suggestion));
    return;
  }
  const report = assessPipelineReadiness({
    inputPath: input.inputPath,
    ...(loaded.pipeline ? { pipeline: loaded.pipeline } : { loadError: loaded.loadError }),
    ...(loaded.manifestSource ? { manifestSource: loaded.manifestSource } : {}),
    projectTrustApprovalId: input.projectTrustApprovalId,
    delegatedTrustRequested: input.delegatedTrustRequested,
    hasHuman: resolvePipelineHumanPresence(),
  });
  if (input.json) input.print(report);
  else for (const line of formatPipelineReadinessReport(report)) input.print(line);
  if (report.verdict === 'blocked') throw new ScriptExitError(1, '', true, report);
}

/** Install reasoning backends when a step needs them; a model need requires credentials. */
export async function installReasoningBackendsForSteps(
  steps: readonly PipelineAdfStep[]
): Promise<boolean> {
  const needs = pipelineBootstrapNeeds(steps, normalizePipelineOp);
  if (!needs.required) {
    logger.debug(
      '[pipeline] reasoning bootstrap skipped; no step requires reasoning, speech, or secrets'
    );
    return false;
  }
  logger.debug(`[pipeline] reasoning bootstrap required: ${needs.reasons.join(', ')}`);
  const { installReasoningBackends } = await import('@agent/core/reasoning/reasoning-bootstrap');
  // Playground / actuator-only drafts under a persisted tenant scope often
  // "require" bootstrap only because unknown domain:op steps are classified
  // conservatively — they do not need a model. When no reason is a reasoning /
  // wisdom / voice / core:* step, degrade to the stub chain instead of
  // demanding a WorkItem credential binding just to run vcs:log / file:read.
  // `secret:*` reads the keychain under secret-guard and never needs a model.
  // `needs.model` is decided over every step, never the capped reason list.
  const needsTenantCredentials = needs.model;
  try {
    installReasoningBackends();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!needsTenantCredentials && message.includes('CREDENTIAL_BINDING_REQUIRED')) {
      logger.info(
        '[pipeline] tenant credential binding absent — actuator-only draft continues on the stub reasoning chain'
      );
      installReasoningBackends({ credentialRequirement: 'degrading' });
      return false;
    }
    throw error;
  }
  return true;
}
