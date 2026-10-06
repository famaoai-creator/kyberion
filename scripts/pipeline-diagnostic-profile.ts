import { assertBuiltinOnlyWorkerEventStream } from '@agent/core/workforce/worker-event-stream';
import { getScenarioOpOverride } from '@agent/core/actuator/actuator-op-registry';
import { assertBuiltinOnlyOpPreflight } from '@agent/core/pipeline/op-preflight-defaults';
/** Bounded receipt execution through the canonical pipeline engine. */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import {
  fireLifecycleHooks,
  getDefaultLifecycleHookEngine,
  LIFECYCLE_HOOK_EVENTS,
  type LifecycleHookEvent,
  type LifecycleHookPayload,
  type LifecycleHookOutcome,
} from '@agent/core/lifecycle-hook-engine';
import {
  assertFrontDeskReceiptPipeline,
  FRONT_DESK_RECEIPT_PIPELINE,
} from '@agent/core/surface/front-desk-execution-contract';
import type { PipelineAdfStep } from '@agent/core/pipeline/pipeline-contract';

export type PipelineExecutionMode = 'front_desk_diagnostic';
export const DIAGNOSTIC_OPERATOR_GUIDANCE =
  'Diagnostic stopped without automatic repair. Ask the operator to inspect the failure and use the normal governed recovery flow.';

export function assertDiagnosticPipelineProfile(
  mode: PipelineExecutionMode | undefined,
  pipelinePath: string | undefined,
  steps: readonly PipelineAdfStep[]
): void {
  if (mode === undefined) return;
  if (
    mode !== 'front_desk_diagnostic' ||
    !pipelinePath ||
    path.resolve(pathResolver.rootDir(), pipelinePath) !==
      pathResolver.rootResolve(FRONT_DESK_RECEIPT_PIPELINE)
  )
    throw new Error('Invalid bounded diagnostic pipeline execution mode');
  assertFrontDeskReceiptPipeline(
    JSON.stringify({
      action: 'pipeline',
      pipeline_id: 'front-desk-request-receipt',
      version: '1.0.0',
      steps,
    })
  );
}

/** Never omit a configured guard to force a diagnostic through: refuse the run. */
export function assertDiagnosticHooksAbsent(): void {
  assertBuiltinOnlyOpPreflight();
  assertBuiltinOnlyWorkerEventStream();
  if (getScenarioOpOverride())
    throw new Error('Diagnostic scenario overrides require normal governed execution');
  const engine = getDefaultLifecycleHookEngine();
  if (
    engine.isHalted ||
    LIFECYCLE_HOOK_EVENTS.some((event) => engine.hookCountFor(event) > 0) ||
    safeExistsSync(pathResolver.rootResolve('knowledge/product/governance/lifecycle-hooks.json'))
  )
    throw new Error(
      '[DIAGNOSTIC_HOOKS_UNSUPPORTED] Extensible lifecycle hooks or a security halt require normal governed execution. ' +
        DIAGNOSTIC_OPERATOR_GUIDANCE
    );
}

export async function firePipelineLifecycleHooks(
  mode: PipelineExecutionMode | undefined,
  event: LifecycleHookEvent,
  payload: LifecycleHookPayload
): Promise<LifecycleHookOutcome> {
  if (mode === undefined)
    return fireLifecycleHooks(getDefaultLifecycleHookEngine(), event, payload);
  if (mode !== 'front_desk_diagnostic')
    throw new Error('Invalid bounded diagnostic pipeline execution mode');
  assertDiagnosticHooksAbsent();
  return {
    blocked: false,
    decision: 'allow',
    asked: false,
    reasons: [],
    additionalContext: [],
    resultPatch: {},
    failedHooks: [],
  };
}
