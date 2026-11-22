import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { renderPrBodyScaffold } from './pr_body.js';
import {
  evaluatePrKnowledgeReadiness,
  parsePrBodyKnowledge,
} from '@agent/core/knowledge/pr-knowledge-readiness';
import type { MemoryCandidate } from '@agent/core/knowledge/memory-promotion-queue';

const TEMPLATE = String(safeReadFile(pathResolver.rootResolve('.github/PULL_REQUEST_TEMPLATE.md')));

const candidate = (over: Partial<MemoryCandidate> = {}): MemoryCandidate =>
  ({
    candidate_id: 'mem-TEST-1',
    source_type: 'mission_retrospective',
    source_ref: 'mission:MSN-TEST-1',
    proposed_memory_kind: 'heuristic',
    summary: 's',
    evidence_refs: [],
    sensitivity_tier: 'public',
    ratification_required: true,
    status: 'queued',
    queued_at: '2026-11-22T00:00:00Z',
    ...over,
  }) as MemoryCandidate;

describe('renderPrBodyScaffold', () => {
  it('fills the Mission ID and renders promoted/rejected/routed lines', () => {
    const body = renderPrBodyScaffold({
      template: TEMPLATE,
      missionId: 'MSN-TEST-1',
      candidates: [
        candidate({ status: 'promoted', promoted_ref: 'knowledge/product/x.md' }),
        candidate({
          candidate_id: 'mem-TEST-2',
          status: 'rejected',
          ratification_note: 'duplicate',
        }),
        candidate({ candidate_id: 'mem-TEST-3', knowledge_domain: 'organization' }),
        candidate({ candidate_id: 'mem-TEST-4' }),
      ],
    });
    const parsed = parsePrBodyKnowledge(body);
    expect(parsed.missionId).toBe('MSN-TEST-1');
    expect(body).toContain('- promoted: mem-TEST-1 → knowledge/product/x.md');
    expect(body).toContain('- rejected: mem-TEST-2 — duplicate');
    expect(body).toContain('- routed: mem-TEST-3 → organization');
    expect(body).toContain('pending candidate mem-TEST-4');
    // pending candidates never masquerade as declarations
    expect(parsed.knowledgeLines.map((line) => line.kind).sort()).toEqual([
      'promoted',
      'rejected',
      'routed',
    ]);
  });

  it('emits the no-mission none line', () => {
    const body = renderPrBodyScaffold({ template: TEMPLATE, candidates: [] });
    expect(parsePrBodyKnowledge(body).missionId).toBeUndefined();
    expect(body).toContain('- none —');
  });

  it('keeps pending-only candidates out of the declaration lines', () => {
    const body = renderPrBodyScaffold({
      template: TEMPLATE,
      missionId: 'MSN-TEST-1',
      candidates: [candidate()],
    });
    expect(parsePrBodyKnowledge(body).knowledgeLines).toEqual([]);
    expect(body).toContain('pending candidate mem-TEST-1 (queued)');
  });

  it('scaffold for a promoted mission passes readiness evaluation', () => {
    const candidates = [
      candidate({
        status: 'promoted',
        promoted_ref: 'knowledge/product/evolution/wisdom/generated/x.md',
        knowledge_domain: 'product',
      }),
    ];
    const body = renderPrBodyScaffold({
      template: TEMPLATE,
      missionId: 'MSN-TEST-1',
      candidates,
    });
    const result = evaluatePrKnowledgeReadiness({
      body,
      candidates,
      changedFiles: [
        { path: 'knowledge/product/evolution/wisdom/generated/x.md', status: 'A' },
        { path: 'knowledge/product/evolution/wisdom/generated/x.json', status: 'A' },
      ],
    });
    expect(result.violations).toEqual([]);
  });
});
