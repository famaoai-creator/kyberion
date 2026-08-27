import { randomUUID } from 'node:crypto';
import { getRegisteredEnvText } from './foundation/env.js';
import { deriveSurfaceSessionId } from './orchestrator-session.js';
import { missionSteeringRouteHandler } from './surface-mission-steering.js';

import { pathResolver } from './path-resolver.js';
import { safeExec } from './secure-io.js';
import { resolveLocale } from './locale.js';
import { normalizeLocale, type SupportedLocale } from './locale-normalize.js';
import { a2aBridge } from './a2a-bridge.js';
import type { A2AMessage } from './a2a-bridge.js';
import { getAgentManifest, resolveAgentSelectionHints } from './agent-manifest.js';
import { ensureAgentRuntime, getAgentRuntimeHandle } from './agent-runtime-supervisor.js';
import {
  createSupervisorBackedAgentHandle,
  ensureAgentRuntimeViaDaemon,
  toSupervisorEnsurePayload,
} from './agent-runtime-supervisor-client.js';
import {
  compileUserIntentFlow,
  formatClarificationPacketConcise,
  isSimpleGreetingText,
} from './intent-contract.js';
import { logger } from './core.js';
import { recordReasoningTierDeclaration } from './reasoning-tier-declaration.js';
import type { AgentHandle } from './agent-lifecycle.js';
import { triggerBackgroundReviewFork } from './background-review-runner.js';
import { repairSurfaceUxContractText, validateSurfaceUxContract } from './surface-ux-contract.js';
import {
  buildMissionTeamView,
  loadMissionTeamPlan,
  resolveMissionTeamReceiver,
} from './mission-team-plan-composer.js';
import { buildSurfaceConversationInput } from './surface-interaction-model.js';
import { classifyTaskSessionIntent, getActiveTaskSession } from './task-session.js';
import { loadPendingIntent, savePendingIntent } from './pending-intent-store.js';
import { currentScope } from './scope-context.js';
import {
  deriveSlackExecutionModeFromProviderPolicy,
  deriveSurfaceIntentLabelFromProviderPolicy,
  shouldForceSurfaceDelegationFromProviderPolicy,
} from './surface-provider-policy.js';
import { extractSurfaceBlocks } from './surface-response-blocks.js';
import {
  buildDelegationFallbackText,
  deriveSurfaceDelegationReceiver,
  normalizeSurfaceDelegationReceiver,
  parseSlackSurfacePrompt,
  resolveSurfaceConversationReceiver,
  shouldCompileSurfaceIntent,
  surfaceChannelFromAgentId,
  surfaceRoutingText,
  type SurfaceDelegationReceiver,
  type SurfaceRuntimeRouteContext,
} from './surface-runtime-router.js';
import { resolveSurfaceIntent } from './router-contract.js';
import {
  resolveIntentResolutionContract,
  type IntentResolutionContract,
} from './intent-resolution-contract.js';
import { selectContractCandidates } from './intent-contract-learning.js';
import {
  attachRoutingDecision,
  buildDelegatedSurfaceConversationResult,
  buildDelegationSummaryContext,
  buildDelegationSummaryInstruction,
  emptySurfaceResult,
  formatExecutionReceipt,
  resolvedSurfaceIntent,
  structuredSurfaceQueryText,
} from './surface-runtime-helpers.js';

export {
  buildDelegationSummaryContext,
  buildDelegationSummaryInstruction,
  extractFollowUpRequests,
} from './surface-runtime-helpers.js';

import type {
  NerveRoutingProposal,
  ParsedSlackSurfacePrompt,
  SurfaceDelegationResult,
  SlackExecutionMode,
  SlackSurfaceInput,
  SurfaceConversationInput,
  SurfaceConversationMessageInput,
  SurfaceConversationResult,
} from './channel-surface-types.js';
import type { UserIntentFlow } from './intent-contract.js';
import { parseExecutionFeedbackText, recordExecutionFeedback } from './execution-feedback.js';
import * as surfaceRuntimeData from './surface-runtime-conversation-data.js';

export {
  buildPipelineIntentContextArgs,
  buildSurfaceStructuredQuery,
} from './surface-runtime-conversation-data.js';

async function handleGovernedExecutionHint(
  context: SurfaceRuntimeRouteContext
): Promise<SurfaceConversationResult> {
  const resolved = resolveSurfaceIntent(context.input.surfaceText || context.structuredQuery);
  const intentId = resolved.intentId;
  const candidates = intentId ? selectContractCandidates(intentId, 3, currentScope()) : [];
  const routingDecisionArgs = context.compiledFlow?.routingDecision
    ? ['--routing-decision', JSON.stringify(context.compiledFlow.routingDecision)]
    : [];
  const promoteToMission = async (): Promise<SurfaceConversationResult> => {
    const governancePayload = surfaceRuntimeData.buildWorkScopeGovernancePayload(context);
    const missionId = `MSN-${Date.now().toString(36).toUpperCase()}`;
    const command = `node dist/scripts/mission_controller.js create ${missionId} public`;
    let output = '';
    try {
      output = safeExec(
        'node',
        [
          'dist/scripts/mission_controller.js',
          'create',
          missionId,
          'public',
          ...surfaceRuntimeData.buildIntentGoalHandoffArgs(context, missionId),
          ...(governancePayload ? ['--routing-decision', JSON.stringify(governancePayload)] : []),
        ],
        {
          cwd: pathResolver.rootDir(),
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
        `承認と記録が必要なためミッションとして進めます。ミッションID: ${missionId}`,
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
    const command = `node dist/scripts/mission_controller.js create ${missionId} public`;
    let output = '';
    try {
      output = safeExec(
        'node',
        [
          'dist/scripts/mission_controller.js',
          'create',
          missionId,
          'public',
          ...surfaceRuntimeData.buildIntentGoalHandoffArgs(context, missionId),
          ...routingDecisionArgs,
        ],
        {
          cwd: pathResolver.rootDir(),
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
        `承認と記録が必要なためミッションを作成しました。ミッションID: ${missionId}`,
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
    output = safeExec(
      'node',
      ['dist/scripts/mission_controller.js', ...mapped, ...routingDecisionArgs],
      {
        cwd: pathResolver.rootDir(),
      }
    );
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

function buildMissionTeamPromptContext(missionId: string): string {
  const plan = loadMissionTeamPlan(missionId);
  if (!plan) return '';
  const teamView = buildMissionTeamView(plan);
  return [
    '',
    'Mission team context:',
    JSON.stringify(
      {
        mission_id: plan.mission_id,
        mission_type: plan.mission_type,
        team: teamView,
      },
      null,
      2
    ),
    '',
    'If delegation is needed, choose a team_role from the team object and emit a ```nerve_route``` JSON block.',
  ].join('\n');
}

async function ensureSurfaceAgent(agentId: string, cwd?: string) {
  const existing = getAgentRuntimeHandle(agentId);
  const status = existing?.getRecord?.()?.status;
  if (existing && status !== 'shutdown' && status !== 'error') return existing;

  const manifest = getAgentManifest(agentId, pathResolver.rootDir());
  if (!manifest) {
    throw new Error(`Surface agent manifest not found: ${agentId}`);
  }
  const { provider, modelId } = resolveAgentSelectionHints(manifest);

  const spawnOptions = {
    agentId,
    provider,
    modelId,
    systemPrompt: manifest.systemPrompt,
    capabilities: manifest.capabilities,
    cwd: cwd || pathResolver.rootDir(),
    requestedBy: 'surface_agent',
    runtimeOwnerId: agentId,
    runtimeOwnerType: 'surface',
    runtimeMetadata: {
      lease_kind: 'surface',
      surface_agent_id: agentId,
      provider_strategy: manifest.selection_hints?.provider_strategy,
      fallback_providers: manifest.selection_hints?.fallback_providers,
    },
  } as const;

  if (getRegisteredEnvText('KYBERION_DISABLE_AGENT_RUNTIME_SUPERVISOR_DAEMON') === '1') {
    return ensureAgentRuntime(spawnOptions);
  }

  try {
    const snapshot = await ensureAgentRuntimeViaDaemon(toSupervisorEnsurePayload(spawnOptions));
    return createSupervisorBackedAgentHandle(agentId, spawnOptions.requestedBy, snapshot);
  } catch (_) {
    return ensureAgentRuntime(spawnOptions);
  }
}

// SO-05: model-tier declarations for the surface conversation front (see
// libs/core/surface-reasoning-tier-boundary.test.ts for the registration
// ceremony that keeps every reasoning call in this file declared). Recorded
// through a structured logger event — the lightest existing mechanism OP-01
// / trace tooling can aggregate without a new subsystem. The recorder itself
// now lives in reasoning-tier-declaration.ts (SO-05 back half) so
// orchestrator-judgment call sites elsewhere (intent-reconciliation.ts,
// mission-lifecycle.ts, surface-mission-steering.ts) can log through the
// same mechanism without depending on this module; this wrapper keeps the
// narrower call-site union and the existing name for this file's 3 call
// sites unchanged.
type SurfaceReasoningTierCallSite =
  'surface_intent_compile' | 'surface_main_ask' | 'surface_summary_ask';

function recordSurfaceReasoningTierDeclaration(input: {
  callSite: SurfaceReasoningTierCallSite;
  declaredTier: 'fast' | 'standard' | 'deep';
  escalatedReason?: string;
}): void {
  recordReasoningTierDeclaration(input);
}

/**
 * Single derivation of "this turn needs approval" shared by both surface UX
 * contract call sites (the in-conversation escalation check and the outbound
 * chokepoint), so an approval turn is held to the same consequence/unblock
 * rule wherever it is validated.
 */
function deriveSurfaceApprovalRequired(input: {
  intentResolution?: { authority_level?: string } | null;
  approvalRequests?: readonly unknown[];
  missionProposals?: readonly unknown[];
}): boolean {
  return (
    input.intentResolution?.authority_level === 'approval_required' ||
    (input.approvalRequests?.length ?? 0) > 0 ||
    (input.missionProposals?.length ?? 0) > 0
  );
}

/**
 * SO-05 Task 3: one-shot fast→standard escalation for the *text* of a surface
 * agent response that is about to become the user-visible reply. Runs INSIDE
 * runSurfaceConversation (not the outer runSurfaceMessageConversation
 * wrapper) because a fresh top-level re-ask would re-run routing/delegation
 * and their side effects — this only re-asks the same handle with the same
 * turn's prompt, never re-enters routing. Callers pass only the already
 * `extractSurfaceBlocks`-derived `.text`; structured blocks (a2aMessages,
 * approvalRequests, …) that were already acted on for this turn are left
 * untouched by escalation.
 *
 * Escalates at most once per call: fast response → validate → repair →
 * validate → standard re-ask (no further validation/repair loop — the outer
 * `runSurfaceMessageConversation` chokepoint still runs its own unchanged
 * validate/repair pass on the final text and is the last word).
 */
async function escalateSurfaceTextIfNeeded(
  handle: AgentHandle,
  prompt: string,
  text: string,
  callSite: SurfaceReasoningTierCallSite,
  approvalRequired = false
): Promise<string> {
  // Empty text (e.g. a2a-only agent turns) keeps its pre-escalation handling:
  // the outer chokepoint's deterministic repair is responsible for shaping it.
  if (!text.trim()) return text;

  const allowConversationalReply = isSimpleGreetingText(prompt);
  const verdict = validateSurfaceUxContract({
    text,
    allow_conversational_reply: allowConversationalReply,
    approval_required: approvalRequired,
  });
  if (verdict.valid) return text;

  const repairedText = repairSurfaceUxContractText(text);
  if (
    repairedText !== text &&
    validateSurfaceUxContract({
      text: repairedText,
      allow_conversational_reply: allowConversationalReply,
      approval_required: approvalRequired,
    }).valid
  ) {
    return repairedText;
  }

  const escalationReason = 'ux_contract_validation_failed';
  recordSurfaceReasoningTierDeclaration({
    callSite,
    declaredTier: 'standard',
    escalatedReason: escalationReason,
  });
  const escalatedPrompt = [
    'Regenerate the final reply to the original user request below.',
    'Original user request:',
    prompt,
    '',
    'The previous draft failed an internal response-quality check and could not be repaired automatically.',
    'Do not mention this check, escalation, hidden context, or internal contract in the reply.',
    'Answer the original request directly in the user language.',
  ].join('\n');
  // Fail-open on every escalation defect (throw, non-string, empty): the
  // conversation must never get worse because the escalation attempt failed —
  // fall back to the original text and let the outer chokepoint repair it,
  // which is exactly the pre-escalation behavior.
  try {
    const escalatedRawText = await handle.ask(escalatedPrompt, { model_tier: 'standard' });
    if (typeof escalatedRawText !== 'string' || !escalatedRawText.trim()) return text;
    const escalatedText = extractSurfaceBlocks(escalatedRawText).text;
    return escalatedText || escalatedRawText;
  } catch (error: any) {
    logger.warn(
      `[surface_reasoning_tier_escalation_failed] call_site=${callSite} escalation_reason=${escalationReason} error=${error?.message || String(error)}`
    );
    return text;
  }
}

export function deriveSlackIntentLabel(text: string): string {
  return deriveSurfaceIntentLabelFromProviderPolicy('slack', text);
}

export function deriveSlackExecutionMode(text: string): SlackExecutionMode {
  return deriveSlackExecutionModeFromProviderPolicy(text);
}

export function shouldForceSlackDelegation(text: string): boolean {
  return shouldForceSurfaceDelegationFromProviderPolicy('slack', text);
}

const OUTPUT_LANGUAGE_NAMES: Readonly<Partial<Record<SupportedLocale, string>>> = {
  en: 'English',
  ja: 'Japanese',
};

/**
 * I18N-06: the single prompt fragment answering "which language should this
 * generation reply in". Modeled on the slack-bridge wording that already
 * worked (`Produce the final Slack reply in the user language.`), but made
 * deterministic by naming the resolved locale explicitly instead of relying
 * on the model to infer it from context.
 *
 * Every surface-facing generation call site should inject this exactly
 * once. Callers that already know the target language for this specific
 * generation (a customer's bound language, a bridge's per-message derived
 * language) pass it explicitly; omitting it resolves the operator's own
 * locale via `resolveLocale()` — the right default for operator-facing
 * surfaces (chronos, the internal bridges) where there is no separate
 * "customer" whose language could differ from the operator's.
 */
export function buildOutputLanguageInstruction(locale?: string | null): string {
  const resolved = normalizeLocale(locale) ?? resolveLocale();
  const languageName = OUTPUT_LANGUAGE_NAMES[resolved] || resolved;
  return `Produce the final reply in ${languageName}. Keep it concise and channel-appropriate.`;
}

/**
 * I18N-06 task 4: `user_language` / "Derived language" signals (this file's
 * own message-content heuristic, and `parseSlackSurfacePrompt`'s twin in
 * `surface-runtime-router.ts`) are derived from what the user actually
 * typed, not from `resolveLocale()` (onboarding identity / env / OS locale).
 * The two usually agree; when they don't — e.g. an operator whose identity
 * says `ja` writes one message in English — we must not silently pick a
 * winner. This only warns; the derived value keeps deciding downstream
 * behavior exactly as before (see call sites).
 */
function warnOnUserLanguageDisagreement(derivedLanguage: string | undefined, source: string): void {
  const derived = normalizeLocale(derivedLanguage);
  if (!derived) return;
  const resolved = resolveLocale();
  if (derived !== resolved) {
    logger.warn(
      `[i18n] user_language signal disagrees with resolveLocale(): derived="${derived}" (${source}) vs resolved="${resolved}" (operator identity/env). Keeping the derived value — resolveLocale() does not override it.`
    );
  }
}

export function buildSlackSurfacePrompt(input: SlackSurfaceInput): string {
  const threadTs = input.threadTs || input.ts || 'unknown';
  const channelType = input.channelType || 'unknown';
  const normalizedText = input.text.trim();
  const language = /[ぁ-んァ-ン一-龯]/.test(normalizedText) ? 'ja' : 'en';
  warnOnUserLanguageDisagreement(language, 'buildSlackSurfacePrompt content heuristic');
  const executionMode = deriveSlackExecutionMode(normalizedText);
  return [
    'You are handling a Slack conversation as the Slack Surface Agent.',
    `Channel: ${input.channel}`,
    `Thread: ${threadTs}`,
    `Channel type: ${channelType}`,
    `User: ${input.user || 'unknown'}`,
    `Derived intent: ${shouldForceSlackDelegation(normalizedText) ? 'request_deeper_reasoning' : 'request_lightweight_reply'}`,
    `Derived language: ${language}`,
    `Execution mode: ${executionMode}`,
    '',
    'User message:',
    normalizedText,
  ].join('\n');
}

function normalizeDelegationPayload(payload: any, fallbackText: string): any {
  if (!payload || typeof payload !== 'object') return payload;
  const currentText = typeof payload.text === 'string' ? payload.text.trim() : '';
  const looksPlaceholder =
    currentText === '' ||
    currentText === 'original request and relevant Slack context' ||
    currentText === 'original request';

  if (!looksPlaceholder) return payload;
  return {
    ...payload,
    text: fallbackText,
  };
}

async function processDelegations(
  a2aMessages: A2AMessage[],
  senderAgentId: string,
  fallbackText: string
): Promise<SurfaceDelegationResult[]> {
  const delegationResults: SurfaceDelegationResult[] = [];

  for (const msg of a2aMessages) {
    try {
      const envelope = {
        a2a_version: '1.0',
        header: {
          msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6)}`,
          sender: senderAgentId,
          receiver: msg.header?.receiver,
          performative: msg.header?.performative || 'request',
          conversation_id: msg.header?.conversation_id,
          timestamp: new Date().toISOString(),
        },
        payload: normalizeDelegationPayload(msg.payload, fallbackText),
      };

      const response = await a2aBridge.route(envelope);
      delegationResults.push({
        receiver: envelope.header.receiver,
        response: response.payload?.text || JSON.stringify(response.payload),
      });
    } catch (err: any) {
      delegationResults.push({
        receiver: msg.header?.receiver,
        error: err.message,
      });
    }
  }

  return delegationResults;
}

async function routeForcedDelegation(
  receiver: string,
  query: string,
  senderAgentId: string,
  missionId?: string
): Promise<SurfaceDelegationResult[]> {
  try {
    const enrichedQuery =
      receiver === 'nerve-agent' && missionId
        ? `${query}\n${buildMissionTeamPromptContext(missionId)}`
        : query;
    const response = await a2aBridge.route(
      surfaceRuntimeData.buildSurfaceDelegationRequest({
        senderAgentId,
        receiver,
        query: enrichedQuery,
        intent: 'surface_handoff',
      })
    );

    return [
      {
        receiver,
        response: response.payload?.text || JSON.stringify(response.payload),
      },
    ];
  } catch (err: any) {
    return [
      {
        receiver,
        error: err.message,
      },
    ];
  }
}

async function routeSlackForcedDelegation(
  receiver: string,
  query: string,
  senderAgentId: string,
  parsedSlackPrompt?: ParsedSlackSurfacePrompt | null,
  missionId?: string
): Promise<SurfaceDelegationResult[]> {
  const parsed = parsedSlackPrompt || parseSlackSurfacePrompt(query);
  if (!parsed) {
    return routeForcedDelegation(receiver, query, senderAgentId, missionId);
  }
  warnOnUserLanguageDisagreement(
    parsed.derivedLanguage,
    'parseSlackSurfacePrompt content heuristic'
  );

  try {
    const response = await a2aBridge.route(
      surfaceRuntimeData.buildSurfaceDelegationRequest({
        senderAgentId,
        receiver,
        query: parsed.userMessage,
        intent: deriveSlackIntentLabel(parsed.userMessage),
        context: {
          channel: 'slack',
          slack_channel: parsed.channel,
          thread: parsed.thread,
          user: parsed.user,
          user_language: parsed.derivedLanguage,
          execution_mode: parsed.executionMode || 'conversation',
        },
      })
    );

    return [
      {
        receiver,
        response: response.payload?.text || JSON.stringify(response.payload),
        bypassedSurfaceAgent: true,
      },
    ];
  } catch (err: any) {
    return [
      {
        receiver,
        error: err.message,
        bypassedSurfaceAgent: true,
      },
    ];
  }
}

async function routeMissionTeamDelegation(
  missionId: string,
  teamRole: string,
  query: string,
  senderAgentId: string
): Promise<SurfaceDelegationResult[]> {
  const assignment = resolveMissionTeamReceiver({ missionId, teamRole });
  if (!assignment?.agent_id) {
    return [
      {
        receiver: `${missionId}:${teamRole}`,
        error: `No assigned agent for team role ${teamRole} in mission ${missionId}`,
      },
    ];
  }

  const results = await routeForcedDelegation(assignment.agent_id, query, senderAgentId, missionId);
  return results.map((result) => ({
    ...result,
    missionId,
    teamRole,
    authorityRole: assignment.authority_role || undefined,
  }));
}

async function routeNerveRoutingProposals(
  proposals: NerveRoutingProposal[],
  senderAgentId: string,
  missionId?: string
): Promise<SurfaceDelegationResult[]> {
  if (!missionId) return [];
  const results: SurfaceDelegationResult[] = [];
  for (const proposal of proposals) {
    if (proposal.intent !== 'delegate_task' || !proposal.team_role) continue;
    const delegated = await routeMissionTeamDelegation(
      proposal.mission_id || missionId,
      proposal.team_role,
      proposal.task_summary || proposal.why || 'Delegated task from nerve-agent',
      senderAgentId
    );
    results.push(...delegated);
  }
  return results;
}

async function handleSlackConversationBypass(
  context: SurfaceRuntimeRouteContext
): Promise<SurfaceConversationResult> {
  const delegationResults = await routeSlackForcedDelegation(
    context.computedReceiver!,
    context.structuredQuery,
    context.input.senderAgentId,
    context.parsedSlackPrompt,
    context.input.missionId
  );
  return buildDelegatedSurfaceConversationResult(delegationResults);
}

async function handlePresenceForcedBypass(
  context: SurfaceRuntimeRouteContext
): Promise<SurfaceConversationResult> {
  const delegationResults = await routeForcedDelegation(
    context.computedReceiver!,
    context.structuredQuery,
    context.input.senderAgentId,
    context.input.missionId
  );
  return buildDelegatedSurfaceConversationResult(delegationResults);
}

const SURFACE_RUNTIME_ROUTE_HANDLERS: surfaceRuntimeData.SurfaceRuntimeRouteHandler[] = [
  // SO-04: mission steering only matches when the thread already holds an
  // active OrchestratorSession AND the message is an explicit steering
  // phrase (rule-based, conservative) — see surface-mission-steering.ts.
  // Placed first: a session-owning thread's steering intent must never be
  // reinterpreted by intent-compile-based routing below.
  missionSteeringRouteHandler,
  {
    matches: (context) => {
      if (!context.compiledFlow) return false;
      const resolved = resolvedSurfaceIntent(context);
      return Boolean(
        resolved.routeFamily === 'pipeline' ||
        (resolved.routeFamily === 'mission' && resolved.intentId !== 'delegate-mission-task') ||
        surfaceRuntimeData.shouldPromoteToMission(context)
      );
    },
    handle: async (context) => {
      try {
        return await handleGovernedExecutionHint(context);
      } catch (error: any) {
        return emptySurfaceResult(`Governed execution failed: ${error?.message || String(error)}`);
      }
    },
  },
  {
    matches: (context) => {
      const resolved = resolvedSurfaceIntent(context);
      // Generic direct-reply intent continue-conversation must fall through
      // to the surface agent, otherwise a greeting is treated as a knowledge
      // search and bypasses the runtime supervisor. Other direct-reply
      // catalog paths retain the existing local fallback behavior.
      return (
        resolved.routeFamily === 'direct_reply' &&
        !context.computedReceiver &&
        resolved.intentId !== 'continue-conversation'
      );
    },
    handle: async (context) => {
      const resolved = resolvedSurfaceIntent(context);
      try {
        return await surfaceRuntimeData.handleSurfaceQueryRoute(context, resolved);
      } catch (error: any) {
        return emptySurfaceResult(`Query route failed: ${error?.message || String(error)}`);
      }
    },
  },
  {
    matches: (context) => {
      const resolved = resolvedSurfaceIntent(context);
      return resolved.routeFamily === 'browser_session';
    },
    handle: async (context) => {
      const query = structuredSurfaceQueryText(context);
      try {
        const delegationResults = await routeForcedDelegation(
          'browser-operator',
          query,
          context.input.senderAgentId,
          context.input.missionId
        );
        return buildDelegatedSurfaceConversationResult(delegationResults);
      } catch (error: any) {
        return emptySurfaceResult(`Browser route failed: ${error?.message || String(error)}`);
      }
    },
  },
  {
    matches: (context) => {
      const surface =
        context.input.surface || surfaceChannelFromAgentId(context.input.agentId) || 'presence';
      const activeSession = getActiveTaskSession(surface);
      const hasActiveSlotFilling = Boolean(
        activeSession &&
        activeSession.requirements?.missing &&
        activeSession.requirements.missing.length > 0
      );
      return (
        hasActiveSlotFilling ||
        Boolean(classifyTaskSessionIntent(structuredSurfaceQueryText(context)))
      );
    },
    handle: async (context) => {
      try {
        return await surfaceRuntimeData.handleTaskSessionRoute(context);
      } catch (error: any) {
        return emptySurfaceResult(`Task-session route failed: ${error?.message || String(error)}`);
      }
    },
  },
  {
    matches: (context) =>
      Boolean(
        context.parsedSlackPrompt &&
        context.parsedSlackPrompt.executionMode === 'conversation' &&
        context.computedReceiver
      ),
    handle: handleSlackConversationBypass,
  },
  {
    matches: (context) =>
      context.input.agentId === 'presence-surface-agent' && Boolean(context.computedReceiver),
    handle: handlePresenceForcedBypass,
  },
];

export async function runSurfaceConversation(
  input: SurfaceConversationInput
): Promise<SurfaceConversationResult> {
  surfaceRuntimeData.surfaceRuntimeContextStore.enterWith(input);
  const parsedExecutionFeedback =
    input.executionFeedback || parseExecutionFeedbackText(input.query);
  if (parsedExecutionFeedback) {
    const record = recordExecutionFeedback({
      ...parsedExecutionFeedback,
      ...(input.correlationId && !parsedExecutionFeedback.correlation_id
        ? { correlation_id: input.correlationId }
        : {}),
      ...(input.surface && !parsedExecutionFeedback.surface ? { surface: input.surface } : {}),
    });
    return {
      ...emptySurfaceResult(surfaceRuntimeData.buildFeedbackAcknowledgement(record)),
      executionFeedbackRecord: record,
      intentResolution: resolveIntentResolutionContract(input.surfaceText || input.query || '', {
        tier: input.scope?.tier,
        tenantId: input.scope?.tenant_slug,
      }),
    };
  }
  const forcedReceiver = normalizeSurfaceDelegationReceiver(input.forcedReceiver);
  const routedSurfaceInput = surfaceRoutingText(input);
  const surface = input.surface || surfaceChannelFromAgentId(input.agentId);
  const originalText = (input.surfaceText || input.query || '').trim();
  const pendingIntent = input.correlationId ? loadPendingIntent(input.correlationId) : null;
  const resolutionText = [pendingIntent?.source_text, originalText]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n');
  const intentResolution: IntentResolutionContract = resolveIntentResolutionContract(
    resolutionText,
    {
      tier: input.scope?.tier,
      tenantId: input.scope?.tenant_slug,
    }
  );
  const withIntentResolution = (result: SurfaceConversationResult): SurfaceConversationResult => ({
    ...result,
    intentResolution,
  });
  const routingTextParts = [
    input.threadContext,
    pendingIntent?.thread_context,
    pendingIntent?.source_text
      ? `Pending clarification context:\n${pendingIntent.source_text}`
      : undefined,
    `Current incoming message:\n${routedSurfaceInput.text}`,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  const routingText = routingTextParts.join('\n\n');
  const ruleBasedReceiver = forcedReceiver || deriveSurfaceDelegationReceiver(routingText, surface);
  const preResolvedIntent = resolveSurfaceIntent(originalText);
  const isDirectDelegationIntent = preResolvedIntent.intentId === 'delegate-mission-task';
  const compiledFlow: UserIntentFlow | null =
    !forcedReceiver &&
    !ruleBasedReceiver &&
    !isDirectDelegationIntent &&
    shouldCompileSurfaceIntent(input, routingText, ruleBasedReceiver)
      ? await (() => {
          recordSurfaceReasoningTierDeclaration({
            callSite: 'surface_intent_compile',
            declaredTier: 'fast',
          });
          return compileUserIntentFlow(
            {
              text: originalText,
              channel: surface || 'surface',
              correlationId: input.correlationId,
              tier: input.scope?.tier,
              tenantSlug: input.scope?.tenant_slug,
              runtimeContext: {
                ...surfaceRuntimeData.buildPendingRuntimeContext(pendingIntent, input),
                ...(input.scope ? { surface_scope: input.scope } : {}),
              },
            },
            { model_tier: 'fast' }
          );
        })().catch((error: any) => {
          logger.warn(
            `[SURFACE] Intent contract compilation failed: ${error?.message || String(error)}`
          );
          return null;
        })
      : null;

  if (compiledFlow?.clarificationPacket) {
    if (input.correlationId) {
      savePendingIntent({
        correlation_id: input.correlationId,
        intent_id:
          compiledFlow.intentContract?.intent_id || compiledFlow.executionBrief?.archetype_id,
        source_text: originalText,
        required_inputs:
          compiledFlow.intentContract?.required_inputs ||
          compiledFlow.executionBrief?.missing_inputs ||
          [],
        source_surface: surface,
        thread_context: input.threadContext,
        clarification_packet: compiledFlow.clarificationPacket,
        runtime_context: surfaceRuntimeData.buildPendingRuntimeContext(pendingIntent, input),
      });
    }
    return withIntentResolution(
      attachRoutingDecision(
        {
          text: formatClarificationPacketConcise(compiledFlow.clarificationPacket, {
            locale: resolveLocale(),
          }),
          a2uiMessages: [],
          a2aMessages: [],
          delegationResults: [],
          approvalRequests: [],
          routingProposals: [],
          missionProposals: [],
          planningPackets: [],
        },
        compiledFlow.routingDecision
      )
    );
  }

  const computedReceiver: SurfaceDelegationReceiver | undefined =
    forcedReceiver ||
    ruleBasedReceiver ||
    (!forcedReceiver && compiledFlow
      ? resolveSurfaceConversationReceiver(undefined, compiledFlow, surface)
      : undefined);

  const structuredQuery = compiledFlow
    ? surfaceRuntimeData.buildSurfaceStructuredQuery(input.query, compiledFlow)
    : input.query;

  const parsedSlackPrompt =
    input.agentId === 'slack-surface-agent' && computedReceiver
      ? routedSurfaceInput.parsedSlackPrompt ||
        (!input.surfaceText ? parseSlackSurfacePrompt(structuredQuery) : null)
      : null;

  const routeContext: SurfaceRuntimeRouteContext = {
    input,
    compiledFlow,
    resolvedIntent: resolveSurfaceIntent(originalText),
    computedReceiver,
    structuredQuery,
    parsedSlackPrompt,
  };
  const matchedRouteHandler = SURFACE_RUNTIME_ROUTE_HANDLERS.find((handler) =>
    handler.matches(routeContext)
  );
  if (matchedRouteHandler) {
    const routedResult = await matchedRouteHandler.handle(routeContext);
    return withIntentResolution(
      surfaceRuntimeData.attachExecutionFeedbackPrompt(
        attachRoutingDecision(routedResult, compiledFlow?.routingDecision),
        compiledFlow,
        input
      )
    );
  }

  const handle = await ensureSurfaceAgent(input.agentId, input.cwd);
  const firstResponse = await handle.ask(structuredQuery, { model_tier: 'fast' });
  recordSurfaceReasoningTierDeclaration({ callSite: 'surface_main_ask', declaredTier: 'fast' });
  const firstBlocks = extractSurfaceBlocks(firstResponse);
  let delegationResults: SurfaceDelegationResult[] = [];
  const delegationFallbackText = buildDelegationFallbackText(structuredQuery);

  if (firstBlocks.a2aMessages.length > 0) {
    delegationResults = await processDelegations(
      firstBlocks.a2aMessages,
      input.senderAgentId,
      delegationFallbackText
    );
  } else if (input.missionId && input.teamRole) {
    delegationResults = await routeMissionTeamDelegation(
      input.missionId,
      input.teamRole,
      structuredQuery,
      input.senderAgentId
    );
  } else if (computedReceiver) {
    delegationResults = await routeForcedDelegation(
      computedReceiver,
      structuredQuery,
      input.senderAgentId,
      input.missionId
    );
  }

  if (delegationResults.length === 0) {
    const mainAskText = await escalateSurfaceTextIfNeeded(
      handle,
      structuredQuery,
      firstBlocks.text,
      'surface_main_ask',
      deriveSurfaceApprovalRequired({
        intentResolution,
        approvalRequests: firstBlocks.approvalRequests,
        missionProposals: firstBlocks.missionProposals,
      })
    );
    return withIntentResolution(
      surfaceRuntimeData.attachExecutionFeedbackPrompt(
        attachRoutingDecision({ ...firstBlocks, text: mainAskText }, compiledFlow?.routingDecision),
        compiledFlow,
        input
      )
    );
  }

  const successful = delegationResults.filter((result) => !result.error);
  const routingProposals = successful.flatMap((result) => {
    const text = typeof result.response === 'string' ? result.response : '';
    return extractSurfaceBlocks(text).routingProposals || [];
  });
  const routedDelegationResults =
    routingProposals.length > 0
      ? await routeNerveRoutingProposals(routingProposals, input.senderAgentId, input.missionId)
      : [];
  const finalDelegationResults = [...delegationResults, ...routedDelegationResults];

  if (successful.length === 0 && routedDelegationResults.length === 0) {
    const mainAskText = await escalateSurfaceTextIfNeeded(
      handle,
      structuredQuery,
      firstBlocks.text,
      'surface_main_ask',
      deriveSurfaceApprovalRequired({
        intentResolution,
        approvalRequests: firstBlocks.approvalRequests,
        missionProposals: firstBlocks.missionProposals,
      })
    );
    return withIntentResolution(
      surfaceRuntimeData.attachExecutionFeedbackPrompt(
        attachRoutingDecision(
          {
            ...firstBlocks,
            text: mainAskText,
            delegationResults: finalDelegationResults,
            approvalRequests: firstBlocks.approvalRequests,
            routingProposals,
            missionProposals: firstBlocks.missionProposals,
            planningPackets: firstBlocks.planningPackets,
          },
          compiledFlow?.routingDecision
        ),
        compiledFlow,
        input
      )
    );
  }

  // I18N-06: the output-language fragment is injected here — the single
  // choke point every surface (slack, chronos, discord, telegram,
  // imessage) already funnels delegation-summary generation through —
  // instead of each surface hardcoding (or omitting) its own language
  // instruction.
  const summaryInstruction = [
    input.delegationSummaryInstruction,
    buildDelegationSummaryInstruction(),
    buildOutputLanguageInstruction(),
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join('\n\n');

  const summaryPrompt = `${summaryInstruction}\n\n${buildDelegationSummaryContext({
    originalQuery: routingText,
    delegationResults: finalDelegationResults,
  })}`;

  const followUpResponse = await handle.ask(summaryPrompt, { model_tier: 'fast' });
  recordSurfaceReasoningTierDeclaration({ callSite: 'surface_summary_ask', declaredTier: 'fast' });
  const followUpBlocksRaw = extractSurfaceBlocks(followUpResponse);
  const followUpText = await escalateSurfaceTextIfNeeded(
    handle,
    summaryPrompt,
    followUpBlocksRaw.text,
    'surface_summary_ask',
    deriveSurfaceApprovalRequired({
      intentResolution,
      approvalRequests: [...firstBlocks.approvalRequests, ...followUpBlocksRaw.approvalRequests],
      missionProposals: [
        ...(firstBlocks.missionProposals || []),
        ...(followUpBlocksRaw.missionProposals || []),
      ],
    })
  );
  const followUpBlocks = { ...followUpBlocksRaw, text: followUpText };

  return withIntentResolution(
    surfaceRuntimeData.attachExecutionFeedbackPrompt(
      attachRoutingDecision(
        {
          text: followUpBlocks.text,
          a2uiMessages: [...firstBlocks.a2uiMessages, ...followUpBlocks.a2uiMessages],
          a2aMessages: firstBlocks.a2aMessages,
          delegationResults: finalDelegationResults,
          approvalRequests: [...firstBlocks.approvalRequests, ...followUpBlocks.approvalRequests],
          routingProposals,
          missionProposals: [
            ...(firstBlocks.missionProposals || []),
            ...(followUpBlocks.missionProposals || []),
          ],
          planningPackets: [
            ...(firstBlocks.planningPackets || []),
            ...(followUpBlocks.planningPackets || []),
          ],
        },
        compiledFlow?.routingDecision
      ),
      compiledFlow,
      input
    )
  );
}

export async function runSurfaceMessageConversation(
  input: SurfaceConversationMessageInput
): Promise<SurfaceConversationResult> {
  // HA-01: count one non-blocking worker turn per surface thread. The
  // correlation id is per message, so derive the stable session key from the
  // surface/channel/thread tuple instead.
  try {
    // SO-02: single source of truth for this derivation lives in
    // orchestrator-session.ts (deriveSurfaceSessionId) — kept byte-identical
    // to what was inlined here so existing session ids never change.
    const sessionId = deriveSurfaceSessionId(input.surface, input.channel, input.threadTs);
    const trigger = triggerBackgroundReviewFork({
      sessionId,
      nudgeConfig: { turnThreshold: 10, toolThreshold: 10 },
      surface: input.surface,
      missionId: input.missionId,
      approvalChannel: input.channel,
      approvalThreadTs: input.threadTs,
      snapshot: [
        `surface=${input.surface}`,
        `channel=${input.channel || 'default'}`,
        `thread=${input.threadTs || 'default'}`,
        `message:\n${input.text}`,
        input.threadContext ? `thread_context:\n${input.threadContext}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    if (trigger.review_due && trigger.fork) {
      logger.info(
        `[HA-01] Background review reserved for surface session ${sessionId}; main response remains non-blocking.`
      );
      const fork = trigger.fork;
      const handleForkFailure = (error: unknown) => {
        // The runner normally converts failures to a result, but this final
        // guard keeps a backend/serialization defect from becoming an
        // unhandled rejection on the surface process.
        logger.warn(
          `[HA-01] Background review fork detached failure: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      };
      if (input.awaitBackgroundReviewFork) {
        // Local mission E2E may await the detached result to prove the full
        // nudge→fork→approval path. Normal surface traffic remains detached.
        await fork;
      } else {
        void fork.catch(handleForkFailure);
      }
    }
  } catch (error) {
    logger.warn(
      `[HA-01] Background review nudge unavailable; continuing surface response: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const result = await runSurfaceConversation(buildSurfaceConversationInput(input));
  // Enforce the surface UX contract on the outbound user-facing text. This is
  // the single chokepoint for all surface responses; validation is non-blocking
  // (a violation is logged and attached to the result, never dropped) so a
  // contract miss surfaces for review without breaking delivery. Previously
  // validateSurfaceUxContract was implemented + tested but never invoked.
  try {
    const text = (result as { text?: unknown })?.text;
    if (typeof text === 'string' && text.trim()) {
      const allowConversationalReply = isSimpleGreetingText(input.text);
      const approvalRequired = deriveSurfaceApprovalRequired(result);
      const verdict = validateSurfaceUxContract({
        text,
        allow_conversational_reply: allowConversationalReply,
        approval_required: approvalRequired,
      });
      if (!verdict.valid) {
        const repairedText = repairSurfaceUxContractText(text);
        if (repairedText !== text) {
          const repairedVerdict = validateSurfaceUxContract({
            text: repairedText,
            allow_conversational_reply: allowConversationalReply,
            approval_required: approvalRequired,
          });
          if (repairedVerdict.valid) {
            (result as { text?: string }).text = repairedText;
            (result as { uxContract?: unknown }).uxContract = repairedVerdict;
            logger.info(
              `[UX_CONTRACT] surface response repaired before delivery: ${verdict.violations.join('; ')}`
            );
            return result;
          }
        }
        logger.warn(
          `[UX_CONTRACT] surface response violates contract: ${verdict.violations.join('; ')}`
        );
      }
      (result as { uxContract?: unknown }).uxContract = verdict;
    }
  } catch {
    // Never block delivery on the contract check itself.
  }
  return result;
}
