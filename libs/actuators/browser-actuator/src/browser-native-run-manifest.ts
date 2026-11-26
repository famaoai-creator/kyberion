/**
 * Run Manifest binding for native browser pipeline files
 * (pipeline-run-manifest-model.md §3.5).
 *
 * A native file (`{action:'pipeline', steps:[{type, op:'goto', ...}]}`) is run
 * by the browser actuator itself, so the actuator is its runner: at run start
 * it derives the scope from the file location, compiles the file's manifest
 * and binds the run to an approved manifest charter exactly as the pipeline
 * runner does for an ADF (`openRunManifestSession`). Its own step loop then
 * marks every step — nested `if` / `while` bodies and `on_error` fallbacks
 * included — with the entry id the compiler assigned and the authored params.
 *
 * Nothing here weakens a gate: an unapproved, changed or unscoped file runs
 * exactly as before (no binding, no option rewriting, every external step
 * asks), and a dispatch the file does not author never inherits an entry.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { logger } from '@agent/core/core';
import { isRecord } from '@agent/core/foundation';
import { withPipelineRunSession } from '@agent/core/actuator/actuator-sdk';
import type { AdfStep } from '@agent/core/pipeline/adf-engine';
import { canonicalActuatorAction } from '@agent/core/pipeline/pipeline-op-aliases';
import { currentScopeEnvelope, withScopeEnvelope } from '@agent/core/scope-envelope';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import {
  BROWSER_NATIVE_FORMAT,
  NATIVE_BROWSER_BODY_KEYS,
  classifyPipelineBrowserOptions,
  deriveRunScope,
  describeDroppedBrowserOption,
  isNativeBrowserPipelineDocument,
  NATIVE_WRITE_FILE_OPERATION,
  nativeRunReadRoots,
  nativeRunWriteRoots,
  nativeWritePath,
  nativeBrowserOp,
  openRunManifestSession,
  runScopeEnvelope,
  runtimeShapedAuthoredParams,
  type RunManifestSession,
  type RunManifestSessionInput,
  type RunScope,
} from '@agent/core/pipeline/run-manifest';
import { runExternalOperation } from '@agent/core/governance/external-operation';
import { isDelegableExternalOperation } from '@agent/core/governance/external-operation-target';
import { resolveScopeContext } from '@agent/core/scope-context';
import {
  currentRunManifestBinding,
  currentRunManifestStep,
  withoutRunManifestStep,
  withRunManifestBinding,
  withRunManifestStep,
  withRuntimeExternalOperationAuthority,
} from '@agent/core/governance/external-operation-runtime';

/** The exact native file being run. */
export interface NativeBrowserPipelineFile {
  /** Repository path of the file (relative or absolute). */
  inputPath: string;
  /** The exact text the pipeline below was parsed from. */
  sourceText: string;
  /** The parsed file. */
  pipeline: Record<string, unknown>;
}

export interface NativeBrowserRunOptions {
  /** Terminal presence of the entry (terminalHumanPresence / a library claim). */
  hasHuman: boolean | undefined;
  /**
   * Entry flags over the file's options (`--headed`). Classified like the
   * file's own options: only allowlisted, partition-confined values apply.
   */
  optionOverrides?: Record<string, unknown>;
  /** Test seams. */
  deps?: {
    runId?: string;
    deriveScope?: (inputPath: string) => RunScope;
    openSession?: (input: RunManifestSessionInput) => RunManifestSession;
  };
}

interface NativeRunState {
  readonly runId: string;
  readonly hasHuman: boolean;
  /** Browser options the bound run applies (classified, partition-confined). */
  readonly options: Record<string, unknown>;
  readonly sessionId?: string;
  /** The run's location-derived scope: step-authored file paths stay in its partition. */
  readonly scope: { tier: string; tenant_slug?: string };
  /** Set by the first executePipeline of the run: only the file's own steps are tagged. */
  claimed: boolean;
}

const nativeRun = new AsyncLocalStorage<NativeRunState>();

/**
 * Run one native pipeline file through `run` (the actuator's existing
 * dispatch), bound to its approved Run Manifest when there is one. Never
 * fails the run for a missing binding: the reason is logged in one line and
 * the run proceeds exactly as an unbound run always has. `run` learns whether
 * the run is bound (`bound: true` only inside the binding).
 */
export async function runNativeBrowserPipelineFile<T>(
  file: NativeBrowserPipelineFile,
  run: (bound: boolean) => Promise<T>,
  options: NativeBrowserRunOptions
): Promise<T> {
  const runId = options.deps?.runId ?? `browser-${randomUUID()}`;
  // The predicate approval and `pipeline check` use: a file they read as an
  // ADF is never bound to a native manifest here.
  if (!isNativeBrowserPipelineDocument(file.pipeline)) {
    logger.info(
      `[BROWSER] run manifest: not bound — ${file.inputPath} is not a native browser pipeline (every op is browser:-qualified or a step has no type), so its approval is an ADF approval | next: run it with pnpm pipeline --input ${file.inputPath}, or use bare op names; every external step asks for its own approval`
    );
    return run(false);
  }
  let scope: RunScope;
  try {
    scope = (options.deps?.deriveScope ?? deriveRunScope)(file.inputPath);
  } catch (error) {
    logger.info(
      `[BROWSER] run manifest: not bound — ${error instanceof Error ? error.message : String(error)}; every external step asks for its own approval`
    );
    return run(false);
  }
  let envelope: ReturnType<typeof runScopeEnvelope>;
  try {
    envelope = runScopeEnvelope(scope, {
      parent: currentScopeEnvelope(),
      session_id: `browser:${runId}`,
      purpose: `browser pipeline ${scope.input_path}`,
    });
  } catch (error) {
    logger.info(
      `[BROWSER] run manifest: not bound — ${error instanceof Error ? error.message : String(error)}; every external step asks for its own approval`
    );
    return run(false);
  }
  const inScope = <R>(body: () => R): R => (envelope ? withScopeEnvelope(envelope, body) : body());
  const session = inScope(() =>
    (options.deps?.openSession ?? openRunManifestSession)({
      scope,
      sourceText: file.sourceText,
      pipeline: file.pipeline,
      hasHuman: options.hasHuman,
      runId,
      format: BROWSER_NATIVE_FORMAT,
    })
  );
  logger[session.level](`[BROWSER] ${session.message}`);
  const binding = session.binding;
  // Unbound — or bound but admitting nothing (principal not approved): today's
  // run, untouched (no envelope, no identity switch, no option rewriting).
  if (!binding || session.admitting !== true) return run(false);

  const declared = {
    ...(isRecord(file.pipeline.options) ? file.pipeline.options : {}),
    ...(options.optionOverrides ?? {}),
  };
  const sessionId =
    typeof file.pipeline.session_id === 'string' && file.pipeline.session_id
      ? file.pipeline.session_id
      : undefined;
  const classified = classifyPipelineBrowserOptions(declared, scope, {
    sessionId: sessionId ?? 'default',
  });
  for (const entry of classified.dropped)
    logger.warn(`[BROWSER] ${describeDroppedBrowserOption(entry)}`);
  const state: NativeRunState = {
    runId,
    hasHuman: options.hasHuman === true,
    options: classified.applied,
    ...(sessionId ? { sessionId } : {}),
    scope: { tier: scope.tier, ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}) },
    claimed: false,
  };
  // The run dispatches under the entry's narrow identity (surface_runtime for
  // `browser run --adf`); the gate reads and records this run's own tenant
  // governance state through the session's exact gate store, nothing wider.
  const withGateStore = session.withGateStore ?? (<R>(body: () => R): R => body());
  return inScope(() =>
    withRunManifestBinding(binding, () =>
      withGateStore(() =>
        withPipelineRunSession(
          {
            session_id: sessionId,
            options: declared,
            scope: {
              tier: scope.tier,
              ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
            },
          },
          () => nativeRun.run(state, () => run(true))
        )
      )
    )
  );
}

function within(relative: string, root: string): boolean {
  return relative === root || relative.startsWith(`${root}/`);
}

/** The one path a human approved this step to write (browser:write_file). */
const approvedWrite = new AsyncLocalStorage<string>();

/**
 * A step-authored write path (screenshot, session handoff, exported spec or
 * ADF) inside a manifest-bound native run. The entry's identity
 * (`surface_runtime` for `browser run --adf`, the process identity for the
 * actuator's `--input`) may write far more than the run needs, so the step's
 * files stay in the run's own partition (plus the default screenshot
 * directory) — or at the exact path a human approved for this step. Anything else stops the run: the compiler judged the step
 * confined, so a resolved path outside is defense in depth. Outside a bound
 * run: unchanged.
 */
export function confineNativeRunWritePath(absolute: string): string {
  const state = nativeRun.getStore();
  if (!state) return absolute;
  // The repository boundary refuses any symbolic link on the path (leaf
  // included), so the lexical check below is also the real location.
  assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
  const relative = pathResolver.toRepoRelative(absolute);
  if (approvedWrite.getStore() === relative) return absolute;
  const roots = nativeRunWriteRoots(state.scope);
  if (roots.some((root) => within(relative, root))) return absolute;
  throw new Error(
    `[BROWSER_RUN_PATH_CONFINED] ${relative} is outside the run's partition — a pre-approved run writes step files only under ${roots.join(', ')} | next: set the step path under ${roots[1]}/`
  );
}

/**
 * Run a step's handler; when the bound run's manifest flagged this step as
 * writing outside the partition (`browser:write_file`, write_path_unconfined),
 * the write first goes through its own per-step approval of the exact
 * resolved path, and only that path is then writable. `params` are the
 * engine-resolved params the handler receives.
 */
export function withNativeWriteApproval<T>(
  op: string,
  params: unknown,
  execute: () => Promise<T>
): Promise<T> {
  const state = nativeRun.getStore();
  const step = currentRunManifestStep();
  const binding = currentRunManifestBinding();
  if (!state || !step || !binding) return execute();
  const flagged = binding.manifest.requirements.effects.some(
    (entry) => entry.entry_id === step.entryId && entry.operation_id === NATIVE_WRITE_FILE_OPERATION
  );
  const resolved = isRecord(params) ? params : {};
  const write = flagged
    ? nativeWritePath(op, resolved, state.scope, state.sessionId ?? 'default')
    : undefined;
  if (!write) return execute();
  const relative = pathResolver.toRepoRelative(pathResolver.rootResolve(write.path));
  return runExternalOperation(
    {
      operationId: NATIVE_WRITE_FILE_OPERATION,
      tenantSlug: (currentScopeEnvelope()?.identity ?? resolveScopeContext()).tenant_slug,
      effect: { op: nativeBrowserOp(op), path: relative, requested_params: resolved },
      requiresApproval: true,
      delegable: isDelegableExternalOperation(NATIVE_WRITE_FILE_OPERATION),
    },
    () => approvedWrite.run(relative, execute),
    () => 'succeeded'
  );
}

/**
 * A step-supplied file a bound native run reads into the browser
 * (`import_session_handoff`: cookies, storage and extra HTTP headers for every
 * origin). Under a binding it must come from the run's own partitions: its
 * browser profile partition (`runtime/browser/profiles/<tier>/<tenant>`) or its
 * scratch / artifact `browser/` directory — never another tenant's. Checked
 * before the file is looked at; symbolic links on the path are refused.
 * Outside a bound run: unchanged.
 */
export function confineNativeRunReadPath(absolute: string): string {
  const state = nativeRun.getStore();
  if (!state) return absolute;
  assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
  const relative = pathResolver.toRepoRelative(absolute);
  const roots = nativeRunReadRoots(state.scope);
  if (roots.some((root) => within(relative, root))) return absolute;
  throw new Error(
    `[BROWSER_RUN_PATH_CONFINED] ${relative} is outside the run's partition — a pre-approved run reads session handoffs only under ${roots.join(', ')} | next: export the handoff under ${roots[1]}/`
  );
}

/** The operator-continue file a bound run polls: the browser runtime directory only. */
export function confineNativeRunContinueFile(absolute: string): string {
  if (!nativeRun.getStore()) return absolute;
  const relative = pathResolver.toRepoRelative(absolute);
  const root = pathResolver.toRepoRelative(pathResolver.shared('runtime/browser'));
  if (within(relative, root)) return absolute;
  throw new Error(
    `[BROWSER_RUN_PATH_CONFINED] continue_file ${relative} is outside ${root}/ — a pre-approved run reads it only there | next: omit continue_file or place it under ${root}/`
  );
}

/** The bound native run a browser pipeline execution belongs to. */
export interface NativeBrowserRunClaim {
  /** Options and session the bound run applies instead of the dispatched input's. */
  options: Record<string, unknown>;
  sessionId?: string;
  /** Tag the file's steps with their manifest entry ids. */
  tagSteps: <S>(steps: readonly S[]) => S[];
  /** Engine `withStep`: each step dispatch under its manifest entry. */
  withStep: <R>(step: AdfStep, dispatch: () => Promise<R>) => Promise<R>;
}

/**
 * Called once per browser pipeline execution. The first execution inside a
 * bound native run claims it (those are the file's own steps); any later or
 * nested execution in the same run gets `nested: true` and must run with no
 * manifest step, so it never inherits an enclosing step's entry.
 */
export function claimNativeBrowserRun(): { claim?: NativeBrowserRunClaim; nested: boolean } {
  const state = nativeRun.getStore();
  if (!state) return { nested: false };
  if (state.claimed) return { nested: true };
  state.claimed = true;
  return {
    nested: false,
    claim: {
      options: structuredClone(state.options),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      tagSteps: (steps) => tagNativeBrowserSteps(steps),
      withStep: nativeBrowserStepScope(state),
    },
  };
}

const NATIVE_STEP = Symbol('kyberion.browser.native-manifest-step');

interface NativeStepTag {
  entryId: string;
  stepId: string;
  /** The step's authored params (before any template resolution). */
  params: Record<string, unknown>;
}

export function nativeBrowserStepTag(step: unknown): NativeStepTag | undefined {
  return isRecord(step)
    ? ((step as Record<symbol, unknown>)[NATIVE_STEP] as NativeStepTag | undefined)
    : undefined;
}

/**
 * Copies of the steps tagged with the compiler's entry ids (`3`,
 * `2.then.0`, `4.pipeline.1`, `5.on_error.fallback.0`). Symbol-keyed: spread
 * carries the tag, JSON (journals, action input, page data) cannot.
 */
export function tagNativeBrowserSteps<S>(steps: readonly S[], prefix = ''): S[] {
  return steps.map((step, index) => {
    if (!isRecord(step) || typeof step.op !== 'string') return step;
    const entryId = prefix ? `${prefix}.${index}` : String(index);
    const params = isRecord(step.params) ? step.params : undefined;
    let taggedParams: Record<string, unknown> | undefined;
    for (const key of NATIVE_BROWSER_BODY_KEYS[nativeBrowserOp(step.op)] ?? []) {
      const body = params?.[key];
      if (!Array.isArray(body)) continue;
      taggedParams ??= { ...params };
      taggedParams[key] = tagNativeBrowserSteps(body, `${entryId}.${key}`);
    }
    const onError = isRecord(step.on_error) ? step.on_error : undefined;
    const tagged: Record<string | symbol, unknown> = {
      ...step,
      ...(taggedParams ? { params: taggedParams } : {}),
      ...(onError && Array.isArray(onError.fallback)
        ? {
            on_error: {
              ...onError,
              fallback: tagNativeBrowserSteps(onError.fallback, `${entryId}.on_error.fallback`),
            },
          }
        : {}),
    };
    tagged[NATIVE_STEP] = {
      entryId,
      stepId: typeof step.id === 'string' && step.id ? step.id : entryId,
      params: params ?? {},
    } satisfies NativeStepTag;
    return tagged as S;
  });
}

/** Ops whose dispatch only runs a nested body; their steps carry their own entries. */
const BODY_RUNNERS = new Set([...Object.keys(NATIVE_BROWSER_BODY_KEYS), 'ref']);

function nativeBrowserStepScope(state: NativeRunState) {
  return <R>(step: AdfStep, dispatch: () => Promise<R>): Promise<R> => {
    const tag = nativeBrowserStepTag(step);
    // A step the file does not author here (a `ref` body) never inherits one.
    if (!tag) return withoutRunManifestStep(dispatch);
    const op = nativeBrowserOp(step.op);
    const operationId = `browser:${canonicalActuatorAction('browser', op)}`;
    const marked = () =>
      withRunManifestStep(
        {
          entryId: tag.entryId,
          authoredParams: runtimeShapedAuthoredParams(
            operationId,
            { params: tag.params },
            BROWSER_NATIVE_FORMAT
          ),
        },
        dispatch
      );
    if (BODY_RUNNERS.has(op)) return marked();
    // The same per-step authority the pipeline runner installs: the
    // manifest charter is consulted here, and anything it does not admit
    // asks for its own approval for this run and step.
    return withRuntimeExternalOperationAuthority(
      { runId: state.runId, stepId: tag.stepId, hasHuman: state.hasHuman },
      marked
    );
  };
}
