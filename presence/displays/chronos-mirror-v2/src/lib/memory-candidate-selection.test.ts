import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCandidate } from '@agent/core/knowledge/memory-promotion-queue';
import type { ViewerContext } from './viewer-context';
const mocks = vi.hoisted(() => ({ rows: [] as MemoryCandidate[] }));
vi.mock('@agent/core/knowledge/memory-promotion-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/knowledge/memory-promotion-queue')>()),
  listMemoryPromotionCandidates: () => mocks.rows,
}));
import {
  memoryCandidateKey,
  resolveMemoryCandidateForViewer,
  MemoryCandidateAmbiguityError,
} from './memory-candidate-selection';
const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'acme',
  organization_id: 'org-a',
  project_id: 'proj-a',
};
const row: MemoryCandidate = {
  candidate_id: 'MEM-SELECT',
  source_type: 'artifact',
  source_ref: 'artifact:one',
  knowledge_domain: 'organization',
  proposed_memory_kind: 'sop',
  summary: 'SOP',
  evidence_refs: ['artifact:one'],
  sensitivity_tier: 'confidential',
  ratification_required: true,
  status: 'queued',
  queued_at: '2026-10-20T00:00:00.000Z',
  scope,
};
const viewer: ViewerContext = {
  role: 'localadmin',
  source: 'token',
  principalId: 'user:one',
  tenantSlugs: ['acme'],
  organizationIds: ['org-a'],
  projectIds: ['proj-a'],
  tierAccess: ['public', 'confidential'],
};
const resolve = (candidateKey?: string, selectedViewer = viewer) =>
  resolveMemoryCandidateForViewer({
    candidateId: row.candidate_id,
    candidateKey,
    viewer: selectedViewer,
  });
beforeEach(() => {
  mocks.rows = [row];
});
describe('authorized memory candidate selection', () => {
  it('selects exact authorized key, never the first same-id hidden row', () => {
    mocks.rows = [{ ...row, scope: { ...scope, tenant_slug: 'other' } }, row];
    expect(resolve(memoryCandidateKey(row))).toEqual(row);
  });
  it('rejects duplicates even when their opaque identity is the same', () => {
    mocks.rows = [row, { ...row }];
    expect(() => resolve(memoryCandidateKey(row))).toThrow(MemoryCandidateAmbiguityError);
  });
  it('requires narrowing when multiple authorized scopes share an id', () => {
    const second = { ...row, scope: { ...scope, project_id: 'proj-b' } };
    mocks.rows = [row, second];
    const wide = { ...viewer, projectIds: 'all' as const };
    expect(() => resolve(undefined, wide)).toThrow(MemoryCandidateAmbiguityError);
    expect(resolve(memoryCandidateKey(second), wide)).toEqual(second);
  });
  it.each([
    { tenant_slug: 'other' },
    { organization_id: 'org-b' },
    { project_id: 'proj-b' },
    { owner_nhi: 'user:other' },
    { allowed_audience: ['user:other'] },
  ])('does not let a known key authorize restricted scope %j', (restriction) => {
    const hidden = { ...row, scope: { ...scope, ...restriction } };
    mocks.rows = [hidden];
    expect(resolve(memoryCandidateKey(hidden))).toBeNull();
  });
  it('does not let confidential destination authorize personal source', () => {
    const hidden = { ...row, scope: { tier: 'personal' as const, owner_nhi: 'user:one' } };
    mocks.rows = [hidden];
    expect(resolve(memoryCandidateKey(hidden))).toBeNull();
  });
  it('returns unavailable for a stale or forged opaque key', () => {
    expect(resolve('0'.repeat(64))).toBeNull();
  });
});
