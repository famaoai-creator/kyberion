#!/usr/bin/env node
import { currentScope } from '@agent/core/scope-context';
import { baseRoleEnvText } from '@agent/core/foundation';
import { isValidTenantSlug } from '@agent/core/foundation/scope';
import { knowledgeWritePathFor } from '@agent/core/knowledge/knowledge-scope';
import {
  applyKnowledgeRankingWeightProposal,
  loadKnowledgeRankingWeightProposal,
  proposeKnowledgeRankingWeightRecalculation,
} from '@agent/core/knowledge/knowledge-weight-recalculation';
import {
  captureSessionCorrection,
  citePromotedKnowledgeForSession,
  recallPromotedKnowledgeForSession,
} from '@agent/core/knowledge';
import type { MemoryScopeEnvelope } from '@agent/core/knowledge/memory-scope';
import { pathResolver } from '@agent/core/path-resolver';
import { recordHumanKnowledgeFeedback } from '@agent/core/knowledge/knowledge-feedback-loop';
import { resolveTenant } from '@agent/core/organization/tenant-registry';
import { assertSafeRepositoryPath, safeExistsSync, safeWriteFile } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import { nowIso } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

const USAGE =
  'Usage: pnpm knowledge place --level <tenant|organization|project|mission|task|session|common|product|public> --slug <name> --title <title> --body <text> [--apply]\n       pnpm knowledge feedback --path <path> --verdict <useful|stale|wrong|not_useful>' +
  '\n       pnpm knowledge recall --topic <text> [--session <id>] [--limit <n>] [--min-score <n>] [--tenant <slug>]' +
  '\n       pnpm knowledge cite --used <csv> [--not-used <csv>] [--missing-topics <csv>] [--session <id>] [--result-id <id>] [--tenant <slug>]' +
  '\n       pnpm knowledge capture-correction --text <text> [--session <id>] [--tenant <slug>] [--owner <nhi>] [--tier <public|confidential|personal>]' +
  '\n       pnpm knowledge weights recalculate --tenant <tenant-slug> [--min-events <n>] [--no-persist]' +
  '\n       pnpm knowledge weights apply --proposal <path> --approval-ref <ref> --approved-by <principal> [--dry-run]';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function csvFlag(args: string[], name: string): string[] {
  const raw = flag(args, name);
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveCliSessionScope(args: string[]): MemoryScopeEnvelope {
  const current = currentScope();
  const requestedTenant = flag(args, '--tenant')?.trim();
  if (requestedTenant) {
    if (!isValidTenantSlug(requestedTenant)) {
      throw new Error(`[SCOPE_CONTEXT_INVALID] Invalid --tenant '${requestedTenant}'.`);
    }
    if (current.tenant_slug && current.tenant_slug !== requestedTenant) {
      throw new Error(
        `[SCOPE_CONTEXT_MISMATCH] Bound tenant '${current.tenant_slug}' does not match --tenant '${requestedTenant}'.`
      );
    }
  }
  const requestedTier = flag(args, '--tier')?.trim();
  if (requestedTier && !['public', 'confidential', 'personal'].includes(requestedTier)) {
    throw new Error(`[SCOPE_CONTEXT_INVALID] Invalid --tier '${requestedTier}'.`);
  }
  const tenantSlug = requestedTenant || current.tenant_slug;
  const tier =
    (requestedTier as MemoryScopeEnvelope['tier'] | undefined) ||
    (tenantSlug ? 'confidential' : current.tier);
  const ownerNhi =
    flag(args, '--owner')?.trim() || current.nhi_id || current.viewer_principal || undefined;
  return {
    ...current,
    tier,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    ...(ownerNhi ? { owner_nhi: ownerNhi } : {}),
  };
}

export const main = defineScript({
  name: 'knowledge',
  flags: ['dry-run'],
  async run(context) {
    const args = context.positional;
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
      context.print(USAGE);
      return;
    }
    if (args[0] === 'recall') {
      const topic = flag(args, '--topic')?.trim();
      if (!topic) {
        throw new Error(
          '[MEMORY_LOOP_TOPIC_REQUIRED] Usage: pnpm knowledge recall --topic <text> [--session <id>] [--limit <n>] [--min-score <n>] [--tenant <slug>]'
        );
      }
      const sessionId = flag(args, '--session')?.trim() || `cli-${nowIso().slice(0, 10)}`;
      const limitRaw = flag(args, '--limit');
      const minScoreRaw = flag(args, '--min-score');
      const result = await recallPromotedKnowledgeForSession({
        topic,
        sessionId,
        scope: resolveCliSessionScope(args),
        recipientKind: 'cli_session',
        ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {}),
        ...(minScoreRaw !== undefined ? { minScore: Number(minScoreRaw) } : {}),
      });
      context.print(result);
      return;
    }
    if (args[0] === 'cite') {
      const sessionId = flag(args, '--session')?.trim() || `cli-${nowIso().slice(0, 10)}`;
      const used = csvFlag(args, '--used');
      const notUsed = csvFlag(args, '--not-used');
      const missingTopics = csvFlag(args, '--missing-topics');
      const result = citePromotedKnowledgeForSession({
        sessionId,
        used,
        notUsed,
        missingTopics,
        scope: resolveCliSessionScope(args),
        ...(flag(args, '--result-id') ? { resultId: flag(args, '--result-id') } : {}),
      });
      context.print(result);
      return;
    }
    if (args[0] === 'capture-correction') {
      const text = flag(args, '--text')?.trim();
      if (!text) {
        throw new Error(
          '[MEMORY_LOOP_CORRECTION_REQUIRED] Usage: pnpm knowledge capture-correction --text <text> [--session <id>] [--tenant <slug>] [--owner <nhi>] [--tier <public|confidential|personal>]'
        );
      }
      const sessionId = flag(args, '--session')?.trim() || `cli-${nowIso().slice(0, 10)}`;
      const result = captureSessionCorrection({
        text,
        sessionId,
        scope: resolveCliSessionScope(args),
        surface: 'cli',
      });
      context.print(result);
      return;
    }
    if (args[0] === 'weights' && args[1] === 'recalculate') {
      const current = currentScope();
      const tenant = flag(args, '--tenant') || current.tenant_slug;
      if (!tenant || !isValidTenantSlug(tenant)) {
        throw new Error(
          '[SCOPE_CONTEXT_INVALID] Usage: pnpm knowledge weights recalculate --tenant <tenant-slug>'
        );
      }
      const proposal = proposeKnowledgeRankingWeightRecalculation({
        scope: { ...current, tier: 'confidential', tenant_slug: tenant },
        ...(flag(args, '--min-events')
          ? { min_feedback_events: Number(flag(args, '--min-events')) }
          : {}),
        persist: args.includes('--no-persist') ? false : true,
      });
      context.print(proposal);
      return;
    }
    if (args[0] === 'weights' && args[1] === 'apply') {
      const proposalPathArg = flag(args, '--proposal');
      const approvalRef = flag(args, '--approval-ref');
      const approvedBy = flag(args, '--approved-by');
      if (!proposalPathArg || !approvalRef || !approvedBy) {
        throw new Error(
          '[KNOWLEDGE_WEIGHT_INVALID] Usage: pnpm knowledge weights apply --proposal <path> --approval-ref <ref> --approved-by <principal> [--dry-run]'
        );
      }
      const proposalPath = assertSafeRepositoryPath(pathResolver.rootResolve(proposalPathArg));
      if (!safeExistsSync(proposalPath)) {
        throw new Error(`[KNOWLEDGE_WEIGHT_INVALID] proposal not found: ${proposalPathArg}`);
      }
      const proposal = loadKnowledgeRankingWeightProposal(proposalPath);
      if (!proposal?.scope?.tenant_slug || !isValidTenantSlug(proposal.scope.tenant_slug)) {
        throw new Error('[SCOPE_CONTEXT_INVALID] proposal must contain a registered tenant slug');
      }
      // Tenant registry profiles live in the protected personal tier. Resolve
      // that authority through the onboarding/tenant steward context, then keep
      // the actual governance write under the knowledge_steward gate below.
      withExecutionContext('sovereign_concierge', () => resolveTenant(proposal.scope.tenant_slug));
      const result = withExecutionContext('knowledge_steward', () =>
        applyKnowledgeRankingWeightProposal({
          proposal,
          approval_ref: approvalRef,
          approved_by: approvedBy,
          dry_run: context.dryRun,
        })
      );
      context.print(result);
      return;
    }
    if (args[0] === 'feedback') {
      const documentPath = flag(args, '--path');
      const verdict = flag(args, '--verdict') as
        'useful' | 'stale' | 'wrong' | 'not_useful' | undefined;
      if (
        !documentPath ||
        !verdict ||
        !['useful', 'stale', 'wrong', 'not_useful'].includes(verdict)
      ) {
        throw new Error(
          '[KNOWLEDGE_FEEDBACK_INVALID] Usage: pnpm knowledge feedback --path <path> --verdict <useful|stale|wrong|not_useful>'
        );
      }
      const feedbackPath = recordHumanKnowledgeFeedback({
        document_path: documentPath,
        verdict,
        reason: flag(args, '--reason'),
        actor: baseRoleEnvText() || 'operator',
        source: 'cli',
        scope: currentScope(),
      });
      context.print({ status: 'recorded', feedback_path: feedbackPath });
      return;
    }
    if (args[0] !== 'place') {
      throw new Error(USAGE);
    }
    const level = flag(args, '--level') as Parameters<typeof knowledgeWritePathFor>[1] | undefined;
    const slug = flag(args, '--slug');
    const title = flag(args, '--title') || slug;
    const body = flag(args, '--body');
    if (!level || !slug || !title || !body)
      throw new Error('[KNOWLEDGE_WRITE_INVALID] --level, --slug, --title and --body are required');
    const scope = currentScope();
    const relativePath = knowledgeWritePathFor(scope, level, slug);
    const content = [
      '---',
      `title: ${title.replace(/\n/g, ' ')}`,
      `last_updated: ${nowIso().slice(0, 10)}`,
      `scope: ${level}`,
      ...(scope.tenant_slug ? [`tenant_slug: ${scope.tenant_slug}`] : []),
      '---',
      '',
      body,
      '',
    ].join('\n');
    const target = assertSafeRepositoryPath(pathResolver.knowledge(relativePath), {
      allowMissingLeaf: true,
    });
    if (!args.includes('--apply') || context.dryRun) {
      context.print({ status: 'dry_run', relative_path: relativePath, content });
      return;
    }
    if (safeExistsSync(target) && !args.includes('--force')) {
      throw new Error(
        `[KNOWLEDGE_WRITE_EXISTS] ${relativePath} exists; pass --force to replace it`
      );
    }
    if (
      scope.tenant_slug &&
      ['tenant', 'organization', 'project', 'mission', 'task', 'session'].includes(level)
    ) {
      // Registry resolution is the authority check; a customer stance or an
      // arbitrary CLI slug must never create a new tenant knowledge boundary.
      resolveTenant(scope.tenant_slug);
    }
    safeWriteFile(target, content, { encoding: 'utf8', mkdir: true });
    context.print({ status: 'written', relative_path: relativePath });
  },
});

if (
  isDirectScript(import.meta.url, 'knowledge.ts') ||
  isDirectScript(import.meta.url, 'knowledge.js')
) {
  void main();
}
