/**
 * `pnpm organization doctrine` — human-authored doctrine/SOP intake through the
 * governed scoped-learning pipeline. `issue` registers an authored document as a
 * promotion candidate, curates it and requests the canonical approval; `publish`
 * completes publication once the approval exists. The approval gate stays human.
 */
import * as path from 'node:path';
import { readTextFile } from '@agent/core/foundation/text';
import { auditChain } from '@agent/core/governance/audit-chain';
import { withExecutionContext } from '@agent/core/authority';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  loadMemoryPromotionCandidate,
} from '@agent/core/knowledge/memory-promotion-queue';
import {
  curateScopedLearningCandidate,
  inspectScopedLearningCandidate,
  publishScopedLearningCandidate,
  requestScopedLearningCandidateApproval,
} from '@agent/core/knowledge/scoped-learning-workflow';
import { approvedLearningPayloadDigest } from '@agent/core/knowledge/scoped-learning-domain';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

type Print = (value: unknown) => void;

const ISSUE_USAGE =
  'Usage: pnpm organization doctrine issue --organization-id <id> --tier confidential --tenant-slug <slug> --file <repo-confined markdown> [--title <title>]';
const PUBLISH_USAGE =
  'Usage: pnpm organization doctrine publish --organization-id <id> --tier confidential --tenant-slug <slug> --candidate-id <id> --expected-payload-digest <digest>';

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function requireArgs(args: string[], names: string[], usage: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = flag(args, `--${name}`);
    if (!value) throw new Error(`--${name} is required.\n${usage}`);
    out[name] = value;
  }
  return out;
}

function doctrineFrontmatter(text: string): { title?: string; body: string } {
  if (!text.startsWith('---\n')) return { body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { body: text };
  const block = text.slice(4, end);
  const title = block
    .match(/^title\s*:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '');
  return { title, body: text.slice(end + 5) };
}

function doctrineTitle(fileText: string, filePath: string, explicit?: string): string {
  if (explicit) return explicit;
  const { title, body } = doctrineFrontmatter(fileText);
  if (title) return title;
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(filePath, path.extname(filePath));
}

function doctrineSummary(body: string): string {
  const text = body
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .trim();
  const end = text.indexOf('\n\n');
  const paragraph = end === -1 ? text : text.slice(0, end);
  return paragraph.replace(/\s+/g, ' ').slice(0, 400) || text.slice(0, 400);
}

export function issueOrganizationDoctrine(args: string[], print: Print): void {
  if (args.some((arg) => arg === '--help')) return print(ISSUE_USAGE);
  const required = requireArgs(
    args,
    ['organization-id', 'tier', 'tenant-slug', 'file'],
    ISSUE_USAGE
  );
  if (required.tier !== 'confidential')
    throw new Error('--tier must be confidential (scoped SOP publication is confidential-only).');
  const filePath = assertSafeRepositoryPath(path.resolve(required.file));
  const raw = readTextFile(filePath);
  const title = doctrineTitle(raw, filePath, flag(args, '--title'));
  const body = doctrineFrontmatter(raw).body;
  const scope = {
    tier: 'confidential' as const,
    tenant_slug: required['tenant-slug'],
    organization_id: required['organization-id'],
  };
  const sourceRef = `doctrine:${path.basename(filePath)}`;
  const evidenceRef = path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
  const candidate = createMemoryPromotionCandidate({
    sourceType: 'authored',
    sourceRef,
    knowledgeDomain: 'organization',
    proposedMemoryKind: 'sop',
    summary: doctrineSummary(body),
    evidenceRefs: [evidenceRef],
    sensitivityTier: 'confidential',
    ratificationRequired: true,
    scope,
  });
  const audit = auditChain.record({
    agentId: 'organization-doctrine',
    action: 'knowledge_promotion_candidate',
    operation: 'enqueue',
    result: 'completed',
    tenantSlug: scope.tenant_slug,
  });
  candidate.audit_ref = `audit:${audit.id}`;
  enqueueMemoryPromotionCandidate(candidate);
  // Content-hash dedupe may have merged this issue into an existing row; the
  // persisted row for this scope+source is the one the rest of the flow uses.
  const persisted =
    loadMemoryPromotionCandidate(candidate.candidate_id, scope) ||
    listMemoryPromotionCandidates(scope).find(
      (row) =>
        row.source_ref === sourceRef &&
        (row.status === 'queued' || row.status === 'approved' || row.status === 'promoted')
    );
  if (!persisted)
    throw new Error('Doctrine candidate was not persisted (queue merge produced no row).');
  const candidateId = persisted.candidate_id;
  const address = { candidateId, scope };
  curateScopedLearningCandidate({
    ...address,
    curation: {
      title,
      summary: candidate.summary,
      content: body.trim(),
      evidence_refs: candidate.evidence_refs,
    },
    expectedPayloadDigest: approvedLearningPayloadDigest(
      loadMemoryPromotionCandidate(candidateId, scope)!
    ),
  });
  const review = requestScopedLearningCandidateApproval({
    ...address,
    requester: {
      requestedBy: 'agent:organization-doctrine',
      actorId: 'agent:organization-doctrine',
    },
    expectedPayloadDigest: approvedLearningPayloadDigest(
      loadMemoryPromotionCandidate(candidateId, scope)!
    ),
  });
  print({
    candidate_id: candidateId,
    scope,
    state: review.learning.state,
    approval_ref: review.learning.approvalRef,
    expected_payload_digest: review.learning.payloadDigest,
    next: `pnpm organization doctrine publish --organization-id ${scope.organization_id} --tier confidential --tenant-slug ${scope.tenant_slug} --candidate-id ${candidateId} --expected-payload-digest ${review.learning.payloadDigest} (after approval)`,
  });
}

export async function publishOrganizationDoctrine(args: string[], print: Print): Promise<void> {
  if (args.some((arg) => arg === '--help')) return print(PUBLISH_USAGE);
  const required = requireArgs(
    args,
    ['organization-id', 'tier', 'tenant-slug', 'candidate-id', 'expected-payload-digest'],
    PUBLISH_USAGE
  );
  if (required.tier !== 'confidential')
    throw new Error('--tier must be confidential (scoped SOP publication is confidential-only).');
  const scope = {
    tier: 'confidential' as const,
    tenant_slug: required['tenant-slug'],
    organization_id: required['organization-id'],
  };
  const review = await withExecutionContext('mission_controller', () =>
    publishScopedLearningCandidate({
      candidateId: required['candidate-id'],
      scope,
      expectedPayloadDigest: required['expected-payload-digest'],
    })
  );
  const observed = inspectScopedLearningCandidate({
    candidateId: required['candidate-id'],
    scope,
  });
  print({
    candidate_id: required['candidate-id'],
    scope,
    state: review.learning.state,
    publication: observed.learning.publication,
  });
}
