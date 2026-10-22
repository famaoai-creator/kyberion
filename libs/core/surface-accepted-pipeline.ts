/**
 * Accepted-pipeline fast path for surface conversations: when the resolved
 * intent is a pipeline with an accepted binding for the viewer's scope, run
 * that pipeline directly instead of going through intent compilation.
 */
import {
  resolveAcceptedPipelineBinding,
  type AcceptedPipelineBinding,
} from './accepted-pipeline-bindings.js';
import type {
  SurfaceConversationInput,
  SurfaceConversationResult,
} from './surface/channel-surface-types.js';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { resolveScopeContext } from './scope-context.js';
import { safeExec } from './secure-io.js';
import { emptySurfaceResult, formatExecutionReceipt } from './surface/surface-runtime-helpers.js';
import { buildOrganizationWorkLoopSummary } from './workforce/work-design.js';

type AcceptedBindingPacket = Parameters<typeof resolveAcceptedPipelineBinding>[0]['packet'];

export function resolveAcceptedSurfaceBindingContext(scope: SurfaceConversationInput['scope']): {
  scope: ReturnType<typeof resolveScopeContext>;
  viewerScopeAuthorized: boolean;
} {
  if (!scope) {
    return {
      scope: resolveScopeContext({ tier: 'public' }),
      viewerScopeAuthorized: false,
    };
  }
  return {
    scope: resolveScopeContext({
      tier: scope.tier || 'public',
      tenant_slug: scope.tenant_slug,
      organization_id: scope.organization_id,
      project_id: scope.project_id,
    }),
    viewerScopeAuthorized:
      scope.tier === 'confidential' || scope.tier === 'personal'
        ? Boolean(scope.tenant_slug)
        : true,
  };
}

export function executeAcceptedSurfacePipeline(
  binding: AcceptedPipelineBinding,
  input: SurfaceConversationInput,
  intentId: string,
  execute: typeof safeExec = safeExec
): SurfaceConversationResult {
  const intentContext = {
    intent_goal: {
      intent_id: intentId,
      source_text: input.surfaceText || input.query,
    },
    ...(input.scope ? { surface_scope: input.scope } : {}),
  };
  const output = execute(
    'node',
    [
      'dist/scripts/run_pipeline.js',
      '--input',
      binding.pipeline_ref,
      '--fail-on-suspend',
      '--context',
      JSON.stringify(intentContext),
    ],
    { cwd: pathResolver.rootDir() }
  );
  const suspended = /\[PIPELINE\]\s+Suspended:|Awaiting decision/u.test(output);
  const failed = /❌\s+\[PIPELINE\]\s+Failed/u.test(output);
  const status = suspended ? 'suspended' : failed ? 'failed' : 'completed';
  return emptySurfaceResult(
    [
      `${status === 'completed' ? 'Executed' : status === 'suspended' ? 'Suspended' : 'Failed'} accepted pipeline: ${binding.pipeline_ref}`,
      '',
      formatExecutionReceipt({
        intentId,
        shape: 'pipeline',
        command: `node dist/scripts/run_pipeline.js --input ${binding.pipeline_ref}`,
        status: status === 'completed' ? 'ok' : 'error',
      }),
      '',
      output.trim() || '(no output)',
    ].join('\n')
  );
}

/**
 * Returns the surface result of the accepted pipeline, or null when the
 * packet has no accepted binding and the caller should continue routing.
 */
export function runAcceptedSurfacePipelineRoute(
  input: SurfaceConversationInput,
  packet: AcceptedBindingPacket,
  utterance: string
): SurfaceConversationResult | null {
  const intentId = packet.selected_intent_id;
  if (packet.selected_resolution?.shape !== 'pipeline' || !intentId) return null;
  const workScope = buildOrganizationWorkLoopSummary({
    intentId,
    shape: packet.selected_resolution?.shape,
    utterance,
    tier: input.scope?.tier,
    projectId: input.scope?.project_id,
  });
  const context = resolveAcceptedSurfaceBindingContext(input.scope);
  const binding = resolveAcceptedPipelineBinding({
    packet,
    scope: context.scope,
    governance: {
      execution_shape: workScope.work_scope_decision?.execution_shape,
      requires_approval: workScope.authority.requires_approval,
      active_mission: Boolean(input.missionId),
      viewer_scope_authorized: context.viewerScopeAuthorized,
    },
  });
  if (!binding) return null;
  try {
    return executeAcceptedSurfacePipeline(binding, input, intentId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[surface-runtime] accepted pipeline route failed: ${message}`);
    return emptySurfaceResult(
      [
        `Accepted pipeline failed: ${binding.pipeline_ref}`,
        '',
        formatExecutionReceipt({
          intentId,
          shape: 'pipeline',
          command: `node dist/scripts/run_pipeline.js --input ${binding.pipeline_ref}`,
          status: 'error',
        }),
      ].join('\n')
    );
  }
}
