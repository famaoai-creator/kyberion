/**
 * HA-01 asynchronous background-review fork.
 *
 * The fork is deliberately proposal-only: it may enqueue a governed memory
 * candidate, persist a distill proposal, and create a pending human approval
 * request for a valid patch proposal, but it never mutates mission state,
 * applies a skill patch, or promotes knowledge itself. The main surface turn
 * can therefore start this runner without awaiting it.
 */

import { z } from 'zod';
import {
  buildBackgroundReviewPrompt,
  evaluateBackgroundReviewText,
  assertBackgroundReviewOperationAllowed,
} from './background-review-policy.js';
import {
  completeBackgroundReview,
  cancelBackgroundReview,
  recordBackgroundReviewActivity,
  type BackgroundReviewNudgeConfig,
  type BackgroundReviewNudgeResult,
} from './background-review-nudge.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  type MemoryCandidateKind,
  type MemoryCandidateTier,
} from './memory-promotion-queue.js';
import {
  createDistillCandidateRecord,
  saveDistillCandidateRecord,
} from './distill-candidate-registry.js';
import {
  createBackgroundReviewApprovalRequest,
  inspectBackgroundReviewProposal,
  type BackgroundReviewPatch,
} from './background-review-patch.js';
import {
  getReasoningBackend,
  type ReasoningBackend,
  type ReasoningCallOptions,
} from './reasoning-backend.js';
import { parseStructuredJson } from './structured-reasoning.js';
import { logger } from './core.js';
import { findRelevantDistilledKnowledge } from './distill-knowledge-injector.js';
import { recordKnowledgeDelivery } from './src/knowledge-feedback-loop.js';
import {
  enqueueSurfaceNotification,
  enqueueSurfaceOutboxMessage,
} from './surface-coordination-store.js';
import type { SurfaceAsyncChannel } from './channel-surface-types.js';
import { withReasoningPayloadScope } from './reasoning-egress-scope.js';

const ProposalActionSchema = z.preprocess(
  (value) =>
    String(value || '')
      .trim()
      .toLowerCase(),
  z.enum(['memory_candidate', 'pipeline_proposal', 'skill_patch', 'no_action'])
);

const BackgroundReviewProposalSchema = z
  .object({
    action: ProposalActionSchema,
    title: z.string().trim().max(200).optional(),
    summary: z.string().trim().max(4000).optional(),
    target_ref: z.string().trim().max(500).optional(),
    proposed_memory_kind: z
      .enum(['sop', 'template', 'heuristic', 'risk_rule', 'clarification_prompt'])
      .optional(),
    sensitivity_tier: z.enum(['public', 'confidential', 'personal']).optional(),
    patch: z
      .object({
        operation: z.enum(['append_step', 'append_section']),
        step: z.record(z.string(), z.unknown()).optional(),
        section: z.string().trim().max(8_000).optional(),
      })
      .optional(),
  })
  .superRefine((proposal, context) => {
    if (proposal.action === 'no_action') return;
    if (!proposal.summary) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'summary is required',
      });
    }
    if (proposal.action === 'pipeline_proposal' && proposal.patch?.operation !== 'append_step') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patch'],
        message: 'pipeline proposals require an append_step patch',
      });
    }
    if (proposal.action === 'skill_patch' && proposal.patch?.operation !== 'append_section') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patch'],
        message: 'skill patches require an append_section patch',
      });
    }
    if (proposal.patch?.operation === 'append_step' && !proposal.patch.step) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patch', 'step'],
        message: 'append_step requires step',
      });
    }
    if (proposal.patch?.operation === 'append_section' && !proposal.patch.section?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patch', 'section'],
        message: 'append_section requires section',
      });
    }
  });

type BackgroundReviewProposal = z.infer<typeof BackgroundReviewProposalSchema>;

export interface BackgroundReviewForkInput {
  sessionId: string;
  surface: SurfaceAsyncChannel;
  snapshot: string;
  missionId?: string;
  approvalChannel?: string;
  approvalThreadTs?: string;
  sourceRef?: string;
  backend?: Pick<ReasoningBackend, 'delegateTask'>;
  callOptions?: ReasoningCallOptions;
}

export type BackgroundReviewForkStatus = 'queued' | 'no_action' | 'rejected' | 'failed';

export interface BackgroundReviewForkResult {
  status: BackgroundReviewForkStatus;
  session_id: string;
  action?: BackgroundReviewProposal['action'];
  candidate_id?: string;
  approval_request_id?: string;
  approval_request_error?: string;
  approval_notification_id?: string;
  approval_notification_error?: string;
  reason?: string;
}

export interface BackgroundReviewTriggerInput extends BackgroundReviewForkInput {
  nudgeConfig?: BackgroundReviewNudgeConfig;
}

export interface BackgroundReviewTriggerResult extends BackgroundReviewNudgeResult {
  fork?: Promise<BackgroundReviewForkResult>;
}

/**
 * Reserve one review and start its fork without awaiting it.
 *
 * Keeping the reservation and fork launch together prevents callers from
 * accidentally starting a fork without a durable nudge state transition.
 * Tests and governed surfaces may await the returned promise; production
 * surfaces intentionally detach it.
 */
export function triggerBackgroundReviewFork(
  input: BackgroundReviewTriggerInput
): BackgroundReviewTriggerResult {
  const nudge = recordBackgroundReviewActivity({
    sessionId: input.sessionId,
    activity: 'turn',
    config: input.nudgeConfig,
  });
  if (!nudge.review_due) return nudge;
  return {
    ...nudge,
    fork: runBackgroundReviewFork(input),
  };
}

function canonicalSourceRef(input: BackgroundReviewForkInput): string {
  const provided = String(input.sourceRef || '').trim();
  if (provided) return provided;
  return input.missionId
    ? `mission:${input.missionId}:background-review:${input.sessionId}`
    : `surface:${input.surface}:background-review:${input.sessionId}`;
}

function boundedSnapshot(snapshot: string): string {
  return String(snapshot || '')
    .trim()
    .slice(0, 12_000);
}

const BACKGROUND_REVIEW_KNOWLEDGE_HINT_LIMIT = 2;
const BACKGROUND_REVIEW_KNOWLEDGE_EXCERPT_MAX = 200;

function truncateKnowledgeExcerpt(value: string, max: number): string {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * KP-02: attach a compact "Relevant knowledge" section to the delegateTask
 * context.
 *
 * `provisionTaskKnowledge` (task-knowledge-provisioning.ts, KP-01) is not
 * usable at this call site: `resolveMissionContextPack` requires a real
 * `missionId: string` that resolves to persisted mission state
 * (`ResolveMissionContextPackInput`), but a background review fork runs
 * per-*session* against a free-text conversation `snapshot` and is
 * frequently not mission-scoped at all — `input.missionId` is optional (see
 * `canonicalSourceRef` above, which falls back to a `surface:...` ref when
 * absent). There is also no WorkItem/TaskSession/ProjectState here to
 * resolve a pack around. So this calls the lower-level primitive
 * `provisionTaskKnowledge` itself wraps (`findRelevantDistilledKnowledge`)
 * directly, mirroring its excerpt/truncation conventions (200-char
 * excerpts, same shape as `renderSystemPromptForm` in
 * task-knowledge-provisioning.ts), and records delivery the same way KP-05
 * does via `recordKnowledgeDelivery` — using a `session:<id>` scope marker
 * in place of a mission id when this fork has no mission
 * (`recordKnowledgeDelivery`'s `missionId` field is required but this
 * caller has no mission to report against).
 *
 * Fail-open: any lookup error is swallowed and logged once; delegation
 * proceeds with the original label-only context exactly as before this
 * change.
 */
async function buildBackgroundReviewKnowledgeContext(
  input: BackgroundReviewForkInput
): Promise<string> {
  const baseContext = 'background-review:' + input.sessionId;
  try {
    const topic = boundedSnapshot(input.snapshot);
    if (!topic) return baseContext;
    const entries = await findRelevantDistilledKnowledge({
      topic,
      limit: BACKGROUND_REVIEW_KNOWLEDGE_HINT_LIMIT,
      minScore: 0.08,
    });
    if (entries.length === 0) return baseContext;

    const lines = [
      'Relevant knowledge:',
      ...entries.map(
        (entry) =>
          `- ${entry.title} (${entry.path}): ${truncateKnowledgeExcerpt(entry.excerpt, BACKGROUND_REVIEW_KNOWLEDGE_EXCERPT_MAX)}`
      ),
    ];
    recordKnowledgeDelivery({
      missionId: input.missionId || `session:${input.sessionId}`,
      taskId: input.sessionId,
      recipientKind: 'background_review_fork',
      refs: entries.map((entry) => ({ path: entry.path, score: entry.score, title: entry.title })),
    });
    return `${baseContext}\n\n${lines.join('\n')}`;
  } catch (error) {
    logger.warn(
      `[KP-02] Background review knowledge lookup failed, delegating without knowledge context: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return baseContext;
  }
}

function buildForkPrompt(input: BackgroundReviewForkInput): string {
  return `${buildBackgroundReviewPrompt({
    sessionId: input.sessionId,
    snapshot: boundedSnapshot(input.snapshot),
  })}

Output JSON contract:
{
  "action": "memory_candidate | pipeline_proposal | skill_patch | no_action",
  "title": "short title when action is not no_action",
  "summary": "reusable, evidence-backed proposal; omit only for no_action",
  "target_ref": "existing skill or pipeline reference when relevant",
  "patch": { "operation": "append_step", "step": { "op": "...", "params": {} } }
  "proposed_memory_kind": "sop | template | heuristic | risk_rule | clarification_prompt",
  "sensitivity_tier": "personal | confidential"
}
For skill_patch, use { "operation": "append_section", "section": "## Heading\\n\\nGuidance" } instead.
Use no_action when the snapshot contains no durable, reusable learning.`;
}

function parseProposal(raw: string): BackgroundReviewProposal {
  if (
    String(raw || '')
      .trim()
      .toLowerCase() === 'no_action'
  ) {
    return { action: 'no_action' };
  }
  const parsed = parseStructuredJson(raw, 'background-review-fork');
  const result = BackgroundReviewProposalSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Background review proposal schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

function assertProposalPolicy(proposal: BackgroundReviewProposal): void {
  if (proposal.action === 'no_action') return;
  const text = [proposal.title, proposal.summary, proposal.target_ref].filter(Boolean).join('\n');
  const policy = evaluateBackgroundReviewText(text);
  if (!policy.allowed) {
    throw new Error(`[POLICY_VIOLATION] Background review proposal rejected: ${policy.reason}`);
  }
}

function persistMemoryCandidate(
  input: BackgroundReviewForkInput,
  proposal: BackgroundReviewProposal,
  sourceRef: string
): string {
  assertBackgroundReviewOperationAllowed('memory:enqueue');
  const missionScoped = Boolean(input.missionId);
  const candidate = createMemoryPromotionCandidate({
    sourceType: missionScoped ? 'mission' : 'task_session',
    sourceRef,
    proposedMemoryKind: (proposal.proposed_memory_kind || 'heuristic') as MemoryCandidateKind,
    summary: proposal.summary || '',
    // The fork cannot promote model-supplied evidence. It records a canonical
    // source pointer so a later human review can inspect the original session.
    evidenceRefs: [sourceRef],
    sensitivityTier: (missionScoped ? 'confidential' : 'personal') as MemoryCandidateTier,
    ratificationRequired: true,
  });
  enqueueMemoryPromotionCandidate(candidate);
  return candidate.candidate_id;
}

function persistProposal(
  input: BackgroundReviewForkInput,
  proposal: BackgroundReviewProposal,
  sourceRef: string
): string {
  const operation = proposal.action === 'pipeline_proposal' ? 'pipeline:promote' : 'skill:patch';
  assertBackgroundReviewOperationAllowed(operation);
  const record = createDistillCandidateRecord({
    source_type: input.missionId ? 'mission' : 'task_session',
    tier: input.missionId ? 'confidential' : 'personal',
    mission_id: input.missionId,
    task_session_id: input.sessionId,
    title: proposal.title || 'Background review proposal',
    summary: proposal.summary || '',
    status: 'proposed',
    target_kind: proposal.action === 'pipeline_proposal' ? 'sop_candidate' : 'pattern',
    evidence_refs: [sourceRef],
    metadata: {
      origin: 'background_review_fork',
      action: proposal.action,
      target_ref: proposal.target_ref,
      patch: proposal.patch as BackgroundReviewPatch | undefined,
      provenance: {
        session_id: input.sessionId,
        surface: input.surface,
        source_ref: sourceRef,
        generated_by: 'background-review-fork',
      },
    },
  });
  saveDistillCandidateRecord(record);
  return record.candidate_id;
}

/**
 * Run one reserved review. Errors are returned as a status and release the
 * reservation so a later threshold can retry; callers never need to await it
 * on the main conversation path.
 */
export async function runBackgroundReviewFork(
  input: BackgroundReviewForkInput
): Promise<BackgroundReviewForkResult> {
  const sourceRef = canonicalSourceRef(input);
  const backend = input.backend || getReasoningBackend();
  try {
    const raw = await withReasoningPayloadScope(
      {
        tier: input.missionId ? 'confidential' : 'personal',
        tenant_slug: process.env.KYBERION_CUSTOMER?.trim() || undefined,
        purpose: 'background review snapshot',
      },
      async () =>
        backend.delegateTask(
          buildForkPrompt(input),
          await buildBackgroundReviewKnowledgeContext(input),
          input.callOptions || {
            effort: 'low',
            model_tier: 'fast',
            budget: { max_prompt_chars: 16_000, max_response_chars: 4_000 },
          }
        )
    );
    const proposal = parseProposal(raw);
    assertProposalPolicy(proposal);

    if (proposal.action === 'no_action') {
      completeBackgroundReview(input.sessionId);
      return { status: 'no_action', session_id: input.sessionId, action: proposal.action };
    }

    const candidateId =
      proposal.action === 'memory_candidate'
        ? persistMemoryCandidate(input, proposal, sourceRef)
        : persistProposal(input, proposal, sourceRef);
    let approvalRequestId: string | undefined;
    let approvalRequestError: string | undefined;
    let approvalNotificationId: string | undefined;
    let approvalNotificationError: string | undefined;
    if (proposal.action === 'pipeline_proposal' || proposal.action === 'skill_patch') {
      // Generate the request from the persisted candidate so the exact target,
      // patch, and current pre-image are bound before a human sees it.
      try {
        const preview = inspectBackgroundReviewProposal(candidateId);
        const approval = createBackgroundReviewApprovalRequest({
          candidateId,
          expectedSha256: preview.expectedSha256,
          requestedBy: 'background-review-fork',
          missionId: input.missionId,
          approvalChannel: input.approvalChannel,
          approvalThreadTs: input.approvalThreadTs,
        });
        approvalRequestId = approval.id;
        if (input.approvalChannel?.trim()) {
          try {
            const noticeText = [
              'background review の提案に人間の承認が必要です。',
              `承認要求: ${approval.id}`,
              `候補: ${candidateId}`,
              `返信: appr:${approval.id}:approve または appr:${approval.id}:reject`,
              `承認: pnpm cli -- approve ${approval.id} background-review`,
              '承認後に候補の apply を実行してください。',
            ].join('\n');
            if (input.surface === 'presence') {
              const notification = enqueueSurfaceNotification({
                surface: input.surface,
                channel: input.approvalChannel.trim(),
                threadTs: input.approvalThreadTs?.trim() || input.sessionId,
                sourceAgentId: 'background-review-fork',
                title: 'Background review approval required',
                text: noticeText,
                status: 'info',
                requestId: approval.id,
              });
              approvalNotificationId = notification.notification_id;
            } else {
              const notificationRef = enqueueSurfaceOutboxMessage({
                surface: input.surface,
                correlationId: approval.id,
                channel: input.approvalChannel.trim(),
                threadTs: input.approvalThreadTs?.trim() || input.sessionId,
                text: noticeText,
                source: 'system',
              });
              approvalNotificationId =
                notificationRef
                  .split(/[\\/]/u)
                  .pop()
                  ?.replace(/\.json$/u, '') || notificationRef;
            }
          } catch (error) {
            approvalNotificationError = error instanceof Error ? error.message : String(error);
            logger.warn(
              `[HA-01] Background review approval notification unavailable: ${approvalNotificationError}`
            );
          }
        }
      } catch (error) {
        // Keep the proposal durable for operator inspection, but never claim
        // that it is ready for application when its target cannot be read or
        // validated. A later explicit `background-review request` can retry
        // after the target is repaired without re-running the fork.
        approvalRequestError = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[HA-01] Background review proposal queued without approval request: ${approvalRequestError}`
        );
      }
    }
    completeBackgroundReview(input.sessionId);
    logger.info(
      `[HA-01] Background review proposal queued: action=${proposal.action} candidate=${candidateId}`
    );
    return {
      status: 'queued',
      session_id: input.sessionId,
      action: proposal.action,
      candidate_id: candidateId,
      ...(approvalRequestId ? { approval_request_id: approvalRequestId } : {}),
      ...(approvalRequestError ? { approval_request_error: approvalRequestError } : {}),
      ...(approvalNotificationId ? { approval_notification_id: approvalNotificationId } : {}),
      ...(approvalNotificationError
        ? { approval_notification_error: approvalNotificationError }
        : {}),
    };
  } catch (error) {
    cancelBackgroundReview(input.sessionId);
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`[HA-01] Background review fork failed: ${reason}`);
    return {
      status: reason.includes('[POLICY_VIOLATION]') ? 'rejected' : 'failed',
      session_id: input.sessionId,
      reason,
    };
  }
}
