import { describe, expect, it } from 'vitest';
import { parseKnowledgeResponse } from './knowledge-response';

const candidate = {
  candidate_id: 'CAND-1',
  status: 'queued',
  proposed_memory_kind: 'heuristic',
  summary: 'Use the governed path',
  evidence_refs: ['trace:1'],
  sensitivity_tier: 'confidential',
  source_ref: 'mission:MSN-1',
  tenantSlug: 'tenant-a',
  ratification_required: true,
};

const valid = {
  ok: true,
  candidates: [candidate],
  tenantSlugs: ['tenant-a'],
  accessRole: 'localadmin',
};

describe('parseKnowledgeResponse', () => {
  it('accepts the knowledge candidate projection', () => {
    expect(parseKnowledgeResponse(valid)).toEqual(valid);
  });

  it.each([
    ['not ok', { ...valid, ok: false }],
    ['invalid candidate status', { ...valid, candidates: [{ ...candidate, status: 'unknown' }] }],
    ['invalid tier', { ...valid, candidates: [{ ...candidate, sensitivity_tier: 'secret' }] }],
    ['invalid evidence refs', { ...valid, candidates: [{ ...candidate, evidence_refs: {} }] }],
    ['invalid tenant scope', { ...valid, tenantSlugs: 1 }],
    ['invalid access role', { ...valid, accessRole: 'admin' }],
    ['dangerous nested key', { ...valid, candidates: [{ ...candidate, ['__proto__']: {} }] }],
  ])('rejects %s', (_label, value) => {
    expect(parseKnowledgeResponse(value)).toBeUndefined();
  });
});
