import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import * as approvals from '@agent/core/governance/approval-store';
import { writeMemberProfile, memberProfilePath } from '@agent/core/organization/member-registry';
import {
  loadMemoryPromotionCandidate,
  memoryPromotionQueuePath,
} from '@agent/core/knowledge/memory-promotion-queue';
import { scopedLearningMarkdownPath } from '@agent/core/knowledge/scoped-learning-domain';
import { issueOrganizationDoctrine, publishOrganizationDoctrine } from './organization_doctrine.js';

const suffix = randomUUID().slice(0, 8);
const tenantSlug = `doctrine-${suffix}`;
const organizationId = 'org-doctrine-test';
const scope = {
  tier: 'confidential' as const,
  tenant_slug: tenantSlug,
  organization_id: organizationId,
};
const fixtureDir = pathResolver.sharedTmp(`org-doctrine-${suffix}`);
const doctrineFile = path.join(fixtureDir, 'ops-doctrine.md');
const cleanup: string[] = [fixtureDir];

beforeEach(() => {
  vi.stubEnv(
    'KYBERION_MEMORY_QUEUE_PATH',
    `active/shared/tmp/test-org-doctrine-${randomUUID()}.jsonl`
  );
  vi.stubEnv('KYBERION_SUDO', 'true');
  safeMkdir(fixtureDir, { recursive: true });
});

afterEach(() => {
  process.env.KYBERION_SUDO = 'true';
  withExecutionContext('ecosystem_architect', () => {
    for (const file of cleanup.splice(0)) safeRmSync(file, { recursive: true, force: true });
    safeRmSync(memoryPromotionQueuePath(), { force: true });
    safeRmSync(pathResolver.rootResolve(`active/shared/runtime/tenants/${tenantSlug}`), {
      recursive: true,
      force: true,
    });
    safeRmSync(pathResolver.knowledge(`confidential/${tenantSlug}`), {
      recursive: true,
      force: true,
    });
    for (const root of Object.values(approvals.approvalStoreRoots()))
      safeRmSync(pathResolver.rootResolve(root + '/terminal'), { recursive: true, force: true });
    // Tenant-scoped requests live in the tenant approval partitions.
    safeRmSync(pathResolver.rootResolve(approvals.approvalStoreRoots().tenantApprovals), {
      recursive: true,
      force: true,
    });
  });
  vi.unstubAllEnvs();
});

function approvePending(requestId: string): void {
  const memberId = `doctrine-${suffix}`;
  cleanup.push(memberProfilePath(memberId));
  withExecutionContext('sovereign_concierge', () =>
    writeMemberProfile({
      member_id: memberId,
      display_name: 'Doctrine reviewer',
      status: 'active',
      memberships: [{ tenant_slug: tenantSlug, role: 'owner' }],
      access_registrations: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  );
  const record = approvals.loadApprovalRequest('terminal', requestId)!;
  approvals.decideApprovalRequest('infrastructure_sentinel', {
    channel: 'terminal',
    requestId,
    decision: 'approved',
    decidedBy: 'user:' + memberId,
    decidedByType: 'human',
    authenticated: true,
    authMethod: 'surface_session',
    deciderIdentitySource: 'server_resolved',
    deciderPrincipal: {
      actor: { kind: 'human', id: 'user:' + memberId },
      principalId: 'user:' + memberId,
      source: 'token',
      provider: 'browser-session',
    },
    presentedDigest: approvals.computeApprovalPresentedDigest(record),
  });
}

describe('organization doctrine', () => {
  it('issues an authored SOP candidate, publishes after approval, and the artifact verifies', async () => {
    safeWriteFile(
      doctrineFile,
      '---\ntitle: On-call escalation doctrine\n---\n\n# On-call escalation\n\n' +
        'Escalate unresolved incidents to the on-call owner within fifteen minutes of detection.\n\n' +
        '1. Triage the signal and attach the first evidence bundle.\n' +
        '2. Page the owning domain lead; do not wait for full diagnosis.\n' +
        '3. Record the handoff in the operations log before standing down.\n'
    );
    const issued: Record<string, unknown>[] = [];
    issueOrganizationDoctrine(
      [
        '--organization-id',
        organizationId,
        '--tier',
        'confidential',
        '--tenant-slug',
        tenantSlug,
        '--file',
        doctrineFile,
      ],
      (value) => issued.push(value as Record<string, unknown>)
    );
    const receipt = issued[0]!;
    expect(receipt.candidate_id).toMatch(/^MEM-/);
    expect(receipt.approval_ref).toBeTruthy();

    const candidate = loadMemoryPromotionCandidate(String(receipt.candidate_id), scope)!;
    expect(candidate.source_type).toBe('authored');
    expect(candidate.curation?.title).toBe('On-call escalation doctrine');
    expect(candidate.curation?.content).toContain('Escalate unresolved incidents');

    approvePending(String(receipt.approval_ref).split(':')[1]!);

    const published: Record<string, unknown>[] = [];
    try {
      await publishOrganizationDoctrine(
        [
          '--organization-id',
          organizationId,
          '--tier',
          'confidential',
          '--tenant-slug',
          tenantSlug,
          '--candidate-id',
          String(receipt.candidate_id),
          '--expected-payload-digest',
          String(receipt.expected_payload_digest),
        ],
        (value) => published.push(value as Record<string, unknown>)
      );
    } catch (error) {
      const stalled = loadMemoryPromotionCandidate(String(receipt.candidate_id), scope);
      throw new Error(
        `publish failed: ${(error as Error).message} | status=${stalled?.status} note=${stalled?.ratification_note}`
      );
    }
    expect(published[0]?.state).toBe('published');

    const promoted = loadMemoryPromotionCandidate(String(receipt.candidate_id), scope)!;
    expect(published[0]?.publication).toBeTruthy();
    expect(scopedLearningMarkdownPath(scope, promoted.candidate_id)).toContain(
      `confidential/${tenantSlug}`
    );
  });
});
