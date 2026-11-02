/** Human-readable scope for the already hash-bound development admission. No authority is issued here. */
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { DECISION_CARD_LIMITS, type DecisionCardEvidence } from '../governance/decision-card.js';
import { DOT_ACTION_LEDGER_PATH, type DotActionRecord } from '../dot/dot-action-ledger.js';
import { dotStatePath } from '../dot/dot-state-paths.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { MissionDevelopmentSpec } from '../mission/mission-development-continuation.js';
import type { ContinuousWorkOwnerScope } from './continuous-work-owner-state.js';
import type { EventScopeInput } from '../event-scope.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';

export function continuousDevelopmentConsentSummary(
  development: MissionDevelopmentSpec,
  scope: Pick<ContinuousWorkOwnerScope, 'tier' | 'tenant_slug'> &
    Partial<Pick<ContinuousWorkOwnerScope, 'organization_id'>>
): string {
  const summary = [
    `Delegate development: ${development.repository_url}`,
    `Scope: ${scope.tier}; organization: ${scope.organization_id ?? 'none'}; tenant: ${scope.tenant_slug ?? 'none'}.`,
    'Branches: agent/kyberion-development → main.',
    `Exact source files: ${development.source_edit_paths.length}; maximum code repairs: ${development.max_repairs ?? 2}.`,
    'Automatic effects: implement, test, repair, push, create PR, independent review, merge and verify merge CI.',
    'CODE_REVIEW and DELIVERY use actual independent review and merge/CI proof instead of another per-step human confirmation.',
    'Review every exact file and the complete descriptor in the linked evidence before approving.',
  ].join('\n');
  if (summary.length > DECISION_CARD_LIMITS.text)
    throw new Error(
      'Development security summary exceeds the decision card limit; shorten the reviewed identifiers'
    );
  return summary;
}

export function continuousDevelopmentAlignmentScope(
  development: MissionDevelopmentSpec,
  scope: ContinuousWorkOwnerScope
): string[] {
  return [
    continuousDevelopmentConsentSummary(development, scope),
    'Full owner-bound reviewed descriptor: evidence/continuous-owner.json (development_hash).',
    `Scoped PR body source: ${development.body_file}`,
    ...development.source_edit_paths.map((file) => `Exact approved source file: ${file}`),
  ];
}

export function continuousDevelopmentDecisionPresentation(
  charter: DotCharter,
  record: Pick<
    DotActionRecord,
    'action_ref' | 'admission' | 'continuous_work' | 'title' | 'objective' | 'semantic_judgment'
  >,
  rootDir?: string
): { question: string; evidence: DecisionCardEvidence[]; scope?: EventScopeInput } | undefined {
  const development = record.continuous_work?.missions.find(
    (mission) => mission.development
  )?.development;
  if (!development) return undefined;
  if (!record.admission || !/^[a-f0-9]{64}$/u.test(record.admission.semantic_hash))
    throw new Error('Development consent requires its exact admission hash');
  const summary = continuousDevelopmentConsentSummary(development, charter.scope);
  const context = `${charter.title} proposes: ${record.title} — ${record.objective}`;
  const remaining = DECISION_CARD_LIMITS.text - summary.length;
  const question = (
    remaining > 2 ? `${summary}\n${context.slice(0, remaining - 1)}` : summary
  ).trim();
  const ledger =
    charter.scope.tier === 'public'
      ? DOT_ACTION_LEDGER_PATH
      : dotStatePath(charter, 'action-ledger.jsonl');
  const ref = rootDir
    ? pathResolver.toRepoRelative(path.resolve(rootDir, ledger)).split(path.sep).join('/')
    : ledger;
  return {
    question,
    // Storage visibility only: untenanted organization/project authority stays
    // in the full admission/ledger. Existing governed judgment scope is preserved.
    ...(!record.semantic_judgment
      ? {
          scope: {
            tier: charter.scope.tier,
            ...(charter.scope.tenant_slug
              ? {
                  tenant_slug: charter.scope.tenant_slug,
                  ...(charter.scope.organization_id
                    ? { organization_id: charter.scope.organization_id }
                    : {}),
                  ...(charter.scope.project_id ? { project_id: charter.scope.project_id } : {}),
                }
              : {}),
            ...(charter.scope.owner_nhi ? { nhi_id: charter.scope.owner_nhi } : {}),
          },
        }
      : {}),
    evidence: [
      {
        label: `Full development plan; action ${record.action_ref}; admission SHA-256 ${record.admission.semantic_hash}`,
        ref,
      },
    ],
  };
}

/** Execution admission never treats a hash-bound but unreadable old card as informed consent. */
export function assertContinuousDevelopmentApprovalPresentation(
  charter: DotCharter,
  record: Parameters<typeof continuousDevelopmentDecisionPresentation>[1],
  approval: Pick<ApprovalRequestRecord, 'decisionCard' | 'scope'>,
  rootDir?: string
): void {
  const expected = continuousDevelopmentDecisionPresentation(charter, record, rootDir);
  if (!expected) return;
  if (
    approval.decisionCard?.question !== expected.question ||
    JSON.stringify(approval.decisionCard?.evidence) !== JSON.stringify(expected.evidence) ||
    (expected.scope &&
      (['tier', 'tenant_slug', 'organization_id', 'project_id', 'nhi_id'] as const).some(
        (key) => approval.scope?.[key] !== expected.scope?.[key]
      ))
  )
    throw new Error(
      'Development approval presentation changed or is incomplete; review the initial plan scope again'
    );
}
