// DA-06 tier classification gate — proposeTierPlacement is a pure advisory
// (any placement outside a tenant root requires steward approval) and the
// steward loop reuses the KM-03 memory-promotion queue: enqueue → human
// approves → the candidate id is the only thing that unlocks a
// common/public landing (verifyStewardApproval fails closed on everything
// else).
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync } from './secure-io.js';
import { updateMemoryPromotionCandidateStatus } from './memory-promotion-queue.js';
import {
  enqueueTierPromotionCandidate,
  proposeTierPlacement,
  verifyStewardApproval,
} from './ingest-tier-gate.js';
import type { PiiFinding } from './pii-scrubber.js';

const FINDING: PiiFinding = {
  rule_id: 'EMAIL_ADDRESS',
  severity: 'pii',
  action: 'mask',
  match_preview: 'ta…om',
  line: 1,
  count: 1,
};

let fixtureDir = '';
let savedQueuePath: string | undefined;

beforeAll(() => {
  savedQueuePath = process.env.KYBERION_MEMORY_QUEUE_PATH;
  const relative = `active/shared/tmp/ingest-tier-gate-da06-${randomUUID()}`;
  fixtureDir = path.join(pathResolver.rootDir(), relative);
  safeMkdir(fixtureDir, { recursive: true });
  process.env.KYBERION_MEMORY_QUEUE_PATH = `${relative}/promotion-queue.jsonl`;
});

afterAll(() => {
  if (savedQueuePath === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
  else process.env.KYBERION_MEMORY_QUEUE_PATH = savedQueuePath;
  if (fixtureDir) safeRmSync(fixtureDir, { recursive: true, force: true });
});

describe('proposeTierPlacement (pure advisory)', () => {
  it('tenant-owned source → tenant confidential root, no approval needed', () => {
    const proposal = proposeTierPlacement({ tenant_slug: 'acme-corp', findings: [FINDING] });
    expect(proposal.proposed_path_root).toBe('knowledge/confidential/acme-corp');
    expect(proposal.requires_steward_approval).toBe(false);
    expect(proposal.rationale.join(' ')).toContain('EMAIL_ADDRESS');
  });

  it('no tenant + PII findings → confidential/common with steward approval', () => {
    const proposal = proposeTierPlacement({ findings: [FINDING] });
    expect(proposal.proposed_path_root).toBe('knowledge/confidential/common');
    expect(proposal.requires_steward_approval).toBe(true);
  });

  it('public is only proposed for explicitly-public, finding-free sources — and STILL needs approval', () => {
    const proposal = proposeTierPlacement({
      source_meta: { explicitly_public: true },
      findings: [],
    });
    expect(proposal.proposed_path_root).toBe('knowledge/public');
    expect(proposal.requires_steward_approval).toBe(true);
    // Findings veto the public proposal even when the source claims to be public.
    expect(
      proposeTierPlacement({ source_meta: { explicitly_public: true }, findings: [FINDING] })
        .proposed_path_root
    ).toBe('knowledge/confidential/common');
  });

  it('defaults to confidential/common (fail-closed) and rejects invalid tenant slugs', () => {
    const proposal = proposeTierPlacement({ findings: [] });
    expect(proposal.proposed_path_root).toBe('knowledge/confidential/common');
    expect(proposal.requires_steward_approval).toBe(true);
    expect(() => proposeTierPlacement({ tenant_slug: 'Bad Slug!', findings: [] })).toThrow(
      /invalid tenant_slug/
    );
  });
});

describe('enqueueTierPromotionCandidate + verifyStewardApproval (KM-03 reuse)', () => {
  it('queued candidates do NOT verify; steward approval unlocks exactly the declared target root', () => {
    const candidate = enqueueTierPromotionCandidate({
      target_root: 'knowledge/confidential/common',
      asset_ref: 'asset:ing-0123456789abcdef@v1',
      summary: 'Shared vendor comparison table with no tenant-specific data.',
      evidence_refs: ['asset:ing-0123456789abcdef@v1'],
    });
    expect(candidate.status).toBe('queued');
    expect(candidate.ratification_required).toBe(true);

    // Not yet approved → fail closed.
    expect(() =>
      verifyStewardApproval({
        approval_id: candidate.candidate_id,
        target_root: 'knowledge/confidential/common',
      })
    ).toThrow(/has status 'queued'/);

    // Steward approves (the human step).
    updateMemoryPromotionCandidateStatus({
      candidateId: candidate.candidate_id,
      status: 'approved',
      ratificationNote: 'Reviewed — no tenant data, safe for common.',
    });
    const verified = verifyStewardApproval({
      approval_id: candidate.candidate_id,
      target_root: 'knowledge/confidential/common',
    });
    expect(verified.candidate_id).toBe(candidate.candidate_id);

    // The approval does not transfer to a DIFFERENT target root.
    expect(() =>
      verifyStewardApproval({
        approval_id: candidate.candidate_id,
        target_root: 'knowledge/public',
      })
    ).toThrow(/does not authorize landing under 'knowledge\/public'/);
  });

  it('unknown ids and non-tier-promotion candidates fail closed', () => {
    expect(() =>
      verifyStewardApproval({ approval_id: 'MEM-DOES-NOT-EXIST', target_root: 'knowledge/public' })
    ).toThrow(/not found in the KM-03 promotion queue/);
    expect(() =>
      verifyStewardApproval({ approval_id: '', target_root: 'knowledge/public' })
    ).toThrow(/approval id is required/);
  });

  it('public-tier candidates reject confidential file-path evidence (queue guard preserved)', () => {
    expect(() =>
      enqueueTierPromotionCandidate({
        target_root: 'knowledge/public',
        asset_ref: 'asset:ing-fedcba9876543210@v1',
        summary: 'Public landing with leaky evidence.',
        evidence_refs: ['knowledge/confidential/acme-corp/reports/q1.md'],
      })
    ).toThrow(/cannot include confidential\/personal evidence/);
  });

  it('rejects unknown target roots and empty inputs', () => {
    expect(() =>
      enqueueTierPromotionCandidate({
        target_root: 'knowledge/personal' as never,
        asset_ref: 'asset:x@v1',
        summary: 's',
        evidence_refs: ['asset:x@v1'],
      })
    ).toThrow(/target_root must be one of/);
    expect(() =>
      enqueueTierPromotionCandidate({
        target_root: 'knowledge/public',
        asset_ref: '',
        summary: 's',
        evidence_refs: ['asset:x@v1'],
      })
    ).toThrow(/asset_ref is required/);
  });
});
