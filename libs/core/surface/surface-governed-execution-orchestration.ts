import { pathResolver } from '../path-resolver.js';
import { safeExec } from '../secure-io.js';
import { t } from '../localization/t.js';
import { currentScope } from '../scope-context.js';
import {
  execMissionControllerChild,
  missionControllerHandoffEnv,
} from '../mission/mission-controller-start-input.js';
import { resolveSurfaceIntent } from '../intent/router-contract.js';
import { selectContractCandidates } from '../intent/intent-contract-learning.js';
import {
  assertScopedSurfaceCapabilitySupported,
  SurfaceConversationCapabilityError,
} from './surface-conversation-runtime-context.js';
import type { SurfaceRuntimeRouteContext } from './surface-runtime-router.js';
import { emptySurfaceResult, formatExecutionReceipt } from './surface-runtime-helpers.js';
import type { SurfaceConversationResult } from './channel-surface-types.js';
import * as surfaceRuntimeData from './surface-runtime-conversation-data.js';

export async function handleGovernedExecutionHint(
  context: SurfaceRuntimeRouteContext
): Promise<SurfaceConversationResult> {
  assertScopedSurfaceCapabilitySupported(context.input, 'governed_cli_execution');
  const resolved =
    context.resolvedIntent ||
    resolveSurfaceIntent(context.input.surfaceText || context.structuredQuery, {
      tier: context.input.scope?.tier,
      tenantId: context.input.scope?.tenant_slug,
      packet: context.resolutionPacket,
    });
  const intentId = resolved.intentId;
  const candidates = intentId ? selectContractCandidates(intentId, 3, currentScope()) : [];
  const routingDecisionArgs = context.compiledFlow?.routingDecision
    ? ['--routing-decision', JSON.stringify(context.compiledFlow.routingDecision)]
    : [];
  const missionScope = context.input.scope;
  const missionTier = missionScope?.tier ?? (missionScope?.tenant_slug ? 'confidential' : 'public');
  const missionScopeArgs = [
    '--tier',
    missionTier,
    ...(missionScope?.tenant_slug ? ['--tenant-slug', missionScope.tenant_slug] : []),
    ...(missionScope?.organization_id ? ['--organization-id', missionScope.organization_id] : []),
    ...(missionScope?.project_id ? ['--project-id', missionScope.project_id] : []),
  ];
  const promoteToMission = async (): Promise<SurfaceConversationResult> => {
    const governancePayload = surfaceRuntimeData.buildWorkScopeGovernancePayload(context);
    const missionId = `MSN-${Date.now().toString(36).toUpperCase()}`;
    const command = `node dist/scripts/mission_controller.js create ${missionId} --tier ${missionTier}`;
    let output = '';
    try {
      output = execMissionControllerChild(
        [
          'create',
          missionId,
          ...missionScopeArgs,
          ...surfaceRuntimeData.buildIntentGoalHandoffArgs(context, missionId),
          ...(governancePayload ? ['--routing-decision', JSON.stringify(governancePayload)] : []),
        ],
        {
          cwd: pathResolver.rootDir(),
          ...(missionScope ? { env: missionControllerHandoffEnv(missionTier, missionScope) } : {}),
        }
      );
      if (intentId) {
        surfaceRuntimeData.recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: 'mission',
          contract_ref: { kind: 'mission_command', ref: 'mission_controller create' },
          success: true,
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
    } catch (error: any) {
      if (error instanceof SurfaceConversationCapabilityError) throw error;
      if (intentId) {
        surfaceRuntimeData.recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: 'mission',
          contract_ref: { kind: 'mission_command', ref: 'mission_controller create' },
          success: false,
          error: error?.message || String(error),
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      throw error;
    }
    return emptySurfaceResult(
      [
        t('bridge:mission_promoted_for_approval', { missionId }),
        '',
        formatExecutionReceipt({
          intentId: resolved.intentId,
          shape: 'mission',
          command,
          status: 'ok',
          candidateSelection: candidates,
          governance: surfaceRuntimeData.buildWorkScopeGovernanceReceipt(context),
        }),
        '',
        output.trim() || '(no output)',
      ].join('\n')
    );
  };
  if (surfaceRuntimeData.shouldPromoteToMission(context)) return promoteToMission();

  const direct = surfaceRuntimeData.directIntentCommand(resolved.intentId);
  if (direct) {
    const command = `${direct.command} ${direct.args.join(' ')}`;
    try {
      const output = safeExec(direct.command, direct.args, { cwd: pathResolver.rootDir() });
      if (intentId) {
        surfaceRuntimeData.recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'task_session',
          contract_ref: { kind: 'task_session_policy', ref: command },
          success: true,
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      return emptySurfaceResult(
        [
          `Executed intent command: ${resolved.intentId}`,
          '',
          formatExecutionReceipt({
            intentId: resolved.intentId,
            shape: resolved.shape,
            command,
            status: 'ok',
            candidateSelection: candidates,
            governance: surfaceRuntimeData.buildWorkScopeGovernanceReceipt(context),
          }),
          '',
          output.trim() || '(no output)',
        ].join('\n')
      );
    } catch (error: any) {
      if (error instanceof SurfaceConversationCapabilityError) throw error;
      if (intentId) {
        surfaceRuntimeData.recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'task_session',
          contract_ref: { kind: 'task_session_policy', ref: command },
          success: false,
          error: error?.message || String(error),
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      throw error;
    }
  }

  if (resolved.pipelineId) {
    // Bare IDs resolve to pipelines/; path-prefixed IDs (containing '/') are used as-is from repo root.
    const pipelinePath = resolved.pipelineId.includes('/')
      ? `${resolved.pipelineId}.json`
      : `pipelines/${resolved.pipelineId}.json`;
    const command = `node dist/scripts/run_pipeline.js --input ${pipelinePath}`;
    const intentContextArgs = surfaceRuntimeData.buildPipelineIntentContextArgs(context);
    let output = '';
    try {
      output = safeExec(
        'node',
        ['dist/scripts/run_pipeline.js', '--input', pipelinePath, ...intentContextArgs],
        {
          cwd: pathResolver.rootDir(),
        }
      );
      if (intentId) {
        surfaceRuntimeData.recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'pipeline',
          contract_ref: { kind: 'pipeline', ref: resolved.pipelineId },
          success: true,
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
    } catch (error: any) {
      if (error instanceof SurfaceConversationCapabilityError) throw error;
      if (intentId) {
        surfaceRuntimeData.recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'pipeline',
          contract_ref: { kind: 'pipeline', ref: resolved.pipelineId },
          success: false,
          error: error?.message || String(error),
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      throw error;
    }
    return emptySurfaceResult(
      [
        `Executed pipeline: ${resolved.pipelineId}`,
        '',
        formatExecutionReceipt({
          intentId: resolved.intentId,
          shape: resolved.shape,
          command,
          status: 'ok',
          candidateSelection: candidates,
          governance: surfaceRuntimeData.buildWorkScopeGovernanceReceipt(context),
        }),
        '',
        output.trim() || '(no output)',
      ].join('\n')
    );
  }

  if (!resolved.missionAction) {
    throw new Error('governed execution hint not found');
  }

  if (resolved.missionAction === 'create') {
    const missionId = `MSN-${Date.now().toString(36).toUpperCase()}`;
    const command = `node dist/scripts/mission_controller.js create ${missionId} --tier ${missionTier}`;
    let output = '';
    try {
      output = execMissionControllerChild(
        [
          'create',
          missionId,
          ...missionScopeArgs,
          ...surfaceRuntimeData.buildIntentGoalHandoffArgs(context, missionId),
          ...routingDecisionArgs,
        ],
        {
          cwd: pathResolver.rootDir(),
          ...(missionScope ? { env: missionControllerHandoffEnv(missionTier, missionScope) } : {}),
        }
      );
      if (intentId) {
        surfaceRuntimeData.recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'mission',
          contract_ref: { kind: 'mission_command', ref: 'mission_controller create' },
          success: true,
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
    } catch (error: any) {
      if (error instanceof SurfaceConversationCapabilityError) throw error;
      if (intentId) {
        surfaceRuntimeData.recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'mission',
          contract_ref: { kind: 'mission_command', ref: 'mission_controller create' },
          success: false,
          error: error?.message || String(error),
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      throw error;
    }
    return emptySurfaceResult(
      [
        t('bridge:mission_created_for_approval', { missionId }),
        '',
        formatExecutionReceipt({
          intentId: resolved.intentId,
          shape: resolved.shape,
          command,
          status: 'ok',
          candidateSelection: candidates,
        }),
        '',
        output.trim() || '(no output)',
      ].join('\n')
    );
  }

  const missionId = surfaceRuntimeData.ensureMissionId(context);
  const missionCommandByAction: Record<string, string[] | undefined> = {
    classify: ['classify', missionId],
    workflow: ['workflow-select', missionId],
    inspect_state: ['status', missionId],
    compose_team: ['team', missionId],
    prewarm_team: ['prewarm', missionId],
    delegate_task: [
      'delegate',
      missionId,
      'generalist',
      context.input.surfaceText || context.structuredQuery,
    ],
    review_output: [
      'review-worker-output',
      missionId,
      'verified',
      'worker output reviewed from surface intent',
    ],
    handoff: ['handoff', missionId, 'surface_operator', 'handoff requested from surface intent'],
    distill: ['distill', missionId],
    close: ['finish', missionId],
  };
  const mapped = missionCommandByAction[resolved.missionAction];
  if (!mapped) {
    return emptySurfaceResult(
      surfaceRuntimeData.missionActionGuidance(resolved.missionAction, missionId)
    );
  }
  const command = `node dist/scripts/mission_controller.js ${mapped.join(' ')}`;
  let output = '';
  try {
    output = execMissionControllerChild([...mapped, ...routingDecisionArgs], {
      cwd: pathResolver.rootDir(),
    });
    if (intentId) {
      surfaceRuntimeData.recordLearningOutcomeSafely({
        intent_id: intentId,
        execution_shape: resolved.shape || 'mission',
        contract_ref: {
          kind: 'mission_command',
          ref: `mission_controller ${resolved.missionAction}`,
        },
        success: true,
        context_fingerprint: {
          execution_shape: resolved.shape,
          surface: context.input.surface || 'unknown',
        },
      });
    }
  } catch (error: any) {
    if (error instanceof SurfaceConversationCapabilityError) throw error;
    if (intentId) {
      surfaceRuntimeData.recordLearningOutcomeSafely({
        intent_id: intentId,
        execution_shape: resolved.shape || 'mission',
        contract_ref: {
          kind: 'mission_command',
          ref: `mission_controller ${resolved.missionAction}`,
        },
        success: false,
        error: error?.message || String(error),
        context_fingerprint: {
          execution_shape: resolved.shape,
          surface: context.input.surface || 'unknown',
        },
      });
    }
    throw error;
  }
  return emptySurfaceResult(
    [
      `Executed mission action: ${resolved.missionAction} (${missionId})`,
      '',
      formatExecutionReceipt({
        intentId: resolved.intentId,
        shape: resolved.shape,
        command,
        status: 'ok',
        candidateSelection: candidates,
        governance: surfaceRuntimeData.buildWorkScopeGovernanceReceipt(context),
      }),
      '',
      output.trim() || '(no output)',
    ].join('\n')
  );
}
