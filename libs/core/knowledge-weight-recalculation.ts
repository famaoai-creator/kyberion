import { createHash } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { physicalScopedPath } from './physical-namespace.js';
import { auditChain } from './audit-chain.js';
import { readJson } from './foundation/json.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import {
  loadKnowledgeUsageAggregate,
  type KnowledgeUsageAggregateEntry,
} from './src/knowledge-feedback-loop.js';
import {
  loadKnowledgeRankingWeights,
  type KnowledgeRankingWeightConfig,
  type KnowledgeRankingWeights,
} from './ranking-signals.js';
import type { ScopeContext } from './scope-context.js';

export interface KnowledgeRankingWeightProposal {
  generated_at: string;
  scope: ScopeContext;
  approval_required: true;
  status: 'proposed' | 'insufficient_data';
  sample: {
    document_count: number;
    feedback_events: number;
    used_events: number;
    not_used_events: number;
    usage_yield: number | null;
  };
  current_weights: KnowledgeRankingWeights;
  proposed_weights: KnowledgeRankingWeights;
  rationale: string[];
  output_path?: string;
}

export interface KnowledgeRankingWeightProposalOptions {
  scope: ScopeContext;
  min_feedback_events?: number;
  now?: Date;
  persist?: boolean;
}

export interface KnowledgeRankingWeightApplyResult {
  status: 'dry_run' | 'applied';
  tenant_slug: string;
  path: string;
  before_weights: KnowledgeRankingWeights;
  applied_weights: KnowledgeRankingWeights;
  changed_keys: string[];
  approval_ref: string;
  approved_by: string;
  audit_ref?: string;
}

function bounded(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value * 100) / 100));
}

function proposalPath(scope: ScopeContext): string {
  return pathResolver.rootResolve(
    physicalScopedPath(
      'active/shared/runtime/feedback-loop',
      {
        ...scope,
        scope_kind: scope.session_id ? 'session' : scope.mission_id ? 'mission' : 'tenant',
      },
      'ranking-weight-proposals',
      'latest.json'
    )
  );
}

function summarizeUsage(entries: KnowledgeUsageAggregateEntry[]) {
  const used = entries.reduce((sum, entry) => sum + Math.max(0, entry.used_count || 0), 0);
  const notUsed = entries.reduce((sum, entry) => sum + Math.max(0, entry.not_used_count || 0), 0);
  const feedbackEvents = used + notUsed;
  return {
    document_count: entries.length,
    feedback_events: feedbackEvents,
    used_events: used,
    not_used_events: notUsed,
    usage_yield: feedbackEvents > 0 ? bounded(used / feedbackEvents, 0, 1) : null,
  };
}

/**
 * Derive a steward proposal from one tenant's feedback aggregate. This is
 * deliberately a proposal-only operation: governance JSON is never changed
 * by runtime feedback, and insufficient data keeps the current weights.
 */
export function proposeKnowledgeRankingWeightRecalculation(
  options: KnowledgeRankingWeightProposalOptions
): KnowledgeRankingWeightProposal {
  if (!options.scope.tenant_slug) {
    throw new Error('[SCOPE_CONTEXT_INVALID] weight recalculation requires tenant_slug');
  }
  // Ranking overrides are tenant-level governance, even when the caller is
  // currently inside a project/mission/task. Do not accidentally produce a
  // narrower proposal or read only one child namespace.
  const tenantScope: ScopeContext = {
    tier: 'confidential',
    tenant_slug: options.scope.tenant_slug,
  };
  const entries = loadKnowledgeUsageAggregate(tenantScope);
  const sample = summarizeUsage(entries);
  const minEvents = Math.max(1, Math.floor(options.min_feedback_events ?? 20));
  const current = loadKnowledgeRankingWeights(tenantScope);
  const sufficient = sample.feedback_events >= minEvents && sample.usage_yield !== null;
  const proposed: KnowledgeRankingWeights = sufficient
    ? {
        ...current,
        // Keep this bounded so one noisy tenant cannot make usage feedback
        // dominate authority or containment proximity.
        usage_yield: bounded(2 + sample.usage_yield! * 6, 2, 8),
      }
    : { ...current };
  const rationale = sufficient
    ? [
        `tenant feedback yield is ${(sample.usage_yield! * 100).toFixed(1)}% across ${sample.feedback_events} events`,
        'usage_yield is bounded to [2, 8] and requires steward approval before governance update',
      ]
    : [
        `feedback events=${sample.feedback_events}; minimum=${minEvents}`,
        'retain current weights until this tenant has enough explicit useful/not_useful feedback',
      ];
  const proposal: KnowledgeRankingWeightProposal = {
    generated_at: (options.now || new Date()).toISOString(),
    scope: tenantScope,
    approval_required: true,
    status: sufficient ? 'proposed' : 'insufficient_data',
    sample,
    current_weights: current,
    proposed_weights: proposed,
    rationale,
  };
  if (options.persist !== false) {
    const outputPath = proposalPath(tenantScope);
    safeWriteFile(outputPath, `${JSON.stringify(proposal, null, 2)}\n`, { mkdir: true });
    proposal.output_path = outputPath;
  }
  return proposal;
}

function stableWeights(weights: KnowledgeRankingWeights): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(weights)
        .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
        .sort(([left], [right]) => left.localeCompare(right))
    )
  );
}

function assertWeightValues(weights: KnowledgeRankingWeights, label: string): void {
  for (const [key, value] of Object.entries(weights)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`[KNOWLEDGE_WEIGHT_INVALID] ${label}.${key} must be a number in [0, 100]`);
    }
  }
}

/**
 * Apply one tenant proposal through the steward gate. Runtime feedback never
 * calls this function: an operator must provide both an approval reference
 * and approving principal, and a changed current weight set is rejected as a
 * stale proposal. The governance file is backed up before the atomic write.
 */
export function applyKnowledgeRankingWeightProposal(input: {
  proposal: KnowledgeRankingWeightProposal;
  approval_ref: string;
  approved_by: string;
  dry_run?: boolean;
  now?: Date;
}): KnowledgeRankingWeightApplyResult {
  const proposal = input.proposal;
  const tenantSlug = proposal.scope?.tenant_slug?.trim();
  const approvalRef = input.approval_ref.trim();
  const approvedBy = input.approved_by.trim();
  if (!tenantSlug) throw new Error('[SCOPE_CONTEXT_INVALID] weight proposal has no tenant_slug');
  if (!approvalRef)
    throw new Error('[KNOWLEDGE_WEIGHT_APPROVAL_REQUIRED] approval_ref is required');
  if (!approvedBy) throw new Error('[KNOWLEDGE_WEIGHT_APPROVAL_REQUIRED] approved_by is required');
  if (proposal.approval_required !== true) {
    throw new Error('[KNOWLEDGE_WEIGHT_APPROVAL_REQUIRED] proposal is not approval-gated');
  }
  if (proposal.status !== 'proposed') {
    throw new Error(
      `[KNOWLEDGE_WEIGHT_NOT_APPLYABLE] proposal status '${proposal.status}' is not proposed`
    );
  }
  assertWeightValues(proposal.current_weights, 'current_weights');
  assertWeightValues(proposal.proposed_weights, 'proposed_weights');

  const governancePath = pathResolver.knowledge('product/governance/knowledge-weights.json');
  const current = loadKnowledgeRankingWeights(proposal.scope);
  if (stableWeights(current) !== stableWeights(proposal.current_weights)) {
    throw new Error(
      '[KNOWLEDGE_WEIGHT_STALE_PROPOSAL] governed weights changed since this proposal was generated'
    );
  }
  const changedKeys = Object.keys(proposal.proposed_weights).filter(
    (key) =>
      current[key as keyof KnowledgeRankingWeights] !==
      proposal.proposed_weights[key as keyof KnowledgeRankingWeights]
  );
  const appliedWeights = { ...current, ...proposal.proposed_weights };
  const result: KnowledgeRankingWeightApplyResult = {
    status: input.dry_run ? 'dry_run' : 'applied',
    tenant_slug: tenantSlug,
    path: governancePath,
    before_weights: current,
    applied_weights: appliedWeights,
    changed_keys: changedKeys,
    approval_ref: approvalRef,
    approved_by: approvedBy,
  };
  if (input.dry_run) return result;

  const raw = safeExistsSync(governancePath)
    ? readJson<KnowledgeRankingWeightConfig>(governancePath)
    : { version: '1.0.0', defaults: { proximity: 1, usage_yield: 4 } };
  const nextConfig: KnowledgeRankingWeightConfig = {
    ...raw,
    version: raw.version || '1.0.0',
    tenant_overrides: {
      ...(raw.tenant_overrides || {}),
      [tenantSlug]: {
        ...(raw.tenant_overrides?.[tenantSlug] || {}),
        ...Object.fromEntries(
          changedKeys.map((key) => [
            key,
            proposal.proposed_weights[key as keyof KnowledgeRankingWeights],
          ])
        ),
      },
    },
  };
  const previous = safeExistsSync(governancePath)
    ? (safeReadFile(governancePath, { encoding: 'utf8' }) as string)
    : '';
  if (previous) {
    safeWriteFile(`${governancePath}.previous`, previous, { mkdir: true, encoding: 'utf8' });
    safeWriteFile(`${governancePath}.history/knowledge-weights-${Date.now()}.json`, previous, {
      mkdir: true,
      encoding: 'utf8',
    });
  }
  safeWriteFile(governancePath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
    mkdir: true,
    encoding: 'utf8',
  });
  const audit = auditChain.record({
    agentId: approvedBy,
    action: 'knowledge_ranking_weights_update',
    operation: 'steward_apply',
    result: 'completed',
    tenantSlug,
    correlationId: approvalRef,
    metadata: {
      approval_ref: approvalRef,
      approved_by: approvedBy,
      changed_keys: changedKeys,
      before_hash: createHash('sha256').update(stableWeights(current)).digest('hex'),
      after_hash: createHash('sha256').update(stableWeights(appliedWeights)).digest('hex'),
    },
  });
  result.audit_ref = `audit:${audit.id}`;
  return result;
}
