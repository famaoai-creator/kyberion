import { describe, expect, it } from 'vitest';
import {
  conciergeMemoryQueueEntryId,
  parseConciergeMemoryQueueResponse,
} from './concierge-advisory-response';
import { groupDecideQueue, type DecideQueueEntry } from './decide-view';

const candidateKey = 'a'.repeat(64);
const otherCandidateKey = 'b'.repeat(64);
const query = 'section=knowledge&candidateKey=' + candidateKey;
const legacyCandidate = {
  id: 'candidate-1',
  kind: 'sop',
  summary: 'A reusable procedure',
  source: 'mission-1',
  source_type: 'mission',
  sensitivity_tier: 'confidential',
  occurrences: 1,
  queued_at: '2026-10-20T00:00:00Z',
};

function parseReviewLink(learningReviewUrl: unknown, fields: Record<string, unknown> = {}) {
  return parseConciergeMemoryQueueResponse({
    ok: true,
    candidates: [{ ...legacyCandidate, candidateKey, learningReviewUrl, ...fields }],
  });
}

describe('Concierge scoped learning review link boundary', () => {
  it('retains an exact scoped non-SOP key for inline rejection without requiring a learning link', () => {
    expect(
      parseConciergeMemoryQueueResponse({
        ok: true,
        candidates: [{ ...legacyCandidate, kind: 'heuristic', candidateKey }],
      })
    ).toEqual([{ ...legacyCandidate, kind: 'heuristic', candidateKey }]);
  });
  it.each([
    'https://chronos.example.test/',
    'https://configured-proxy.example.test/chronos/',
    'http://localhost:3000/',
    'http://127.0.0.1:3000/',
    'http://[::1]:3000/',
  ])('preserves a resolver-compatible destination: %s', (base) => {
    const learningReviewUrl = base + '?' + query + '&tenant=tenant-a';
    expect(parseReviewLink(learningReviewUrl)).toEqual([
      { ...legacyCandidate, candidateKey, learningReviewUrl },
    ]);
  });

  it('rejects a link whose candidate selector differs from the displayed row', () => {
    expect(
      parseReviewLink('https://chronos.example.test/?' + query, {
        candidateKey: otherCandidateKey,
      })
    ).toBeUndefined();
  });

  it.each([
    query + '&candidateKey=' + candidateKey,
    query + '&candidateKey=' + otherCandidateKey,
    query + '&candidate%4Bey=' + candidateKey,
    query + '&section=knowledge',
    query + '&section=approvals',
    query + '&sec%74ion=knowledge',
    'section=approvals&section=knowledge&candidateKey=' + candidateKey,
    'section=knowledge',
    'candidateKey=' + candidateKey,
    'section=approvals&candidateKey=' + candidateKey,
  ])('rejects missing, duplicated, or conflicting selectors: %s', (search) => {
    expect(parseReviewLink('https://chronos.example.test/?' + search)).toBeUndefined();
  });

  it.each(['template', 'heuristic', 'risk_rule', 'clarification_prompt'])(
    'rejects scoped review navigation on non-SOP kind %s',
    (kind) => {
      expect(parseReviewLink('https://chronos.example.test/?' + query, { kind })).toBeUndefined();
    }
  );

  it.each([
    'https://user:password@chronos.example.test/?' + query,
    'https://user@chronos.example.test/?' + query,
    'http://user:password@localhost:3000/?' + query,
    'http://chronos.example.test/?' + query,
    'http://localhost.example.test/?' + query,
    'http://127.0.0.1.example.test/?' + query,
    'ftp://chronos.example.test/?' + query,
    'javascript:alert(1)?' + query,
    'data:text/html,review?' + query,
    '//chronos.example.test/?' + query,
    '/?' + query,
    'not a URL',
    '',
    null,
    42,
  ])('rejects unsafe or malformed review URL %s', (learningReviewUrl) => {
    expect(parseReviewLink(learningReviewUrl)).toBeUndefined();
  });

  it.each([undefined, null, '', 'a'.repeat(63), 'A'.repeat(64), 42])(
    'requires the complete opaque row key: %s',
    (invalidKey) => {
      expect(
        parseReviewLink('https://chronos.example.test/?' + query, {
          candidateKey: invalidKey,
        })
      ).toBeUndefined();
    }
  );

  it('rejects a candidate key without a review URL instead of falling back to legacy controls', () => {
    expect(parseReviewLink(undefined)).toBeUndefined();
  });

  it.each(['sop', 'template', 'heuristic', 'risk_rule', 'clarification_prompt'])(
    'leaves legacy %s candidates without scoped link fields unchanged',
    (kind) => {
      const candidate = { ...legacyCandidate, kind };
      expect(parseConciergeMemoryQueueResponse({ ok: true, candidates: [candidate] })).toEqual([
        candidate,
      ]);
    }
  );

  it('rejects the queue rather than quietly dropping invalid scoped-link fields', () => {
    expect(
      parseConciergeMemoryQueueResponse({
        ok: true,
        candidates: [
          legacyCandidate,
          {
            ...legacyCandidate,
            candidateKey,
            learningReviewUrl:
              'https://chronos.example.test/?section=knowledge&candidateKey=' + otherCandidateKey,
          },
        ],
      })
    ).toBeUndefined();
  });
});

describe('Concierge scoped learning card and deferral identity', () => {
  it('keeps same-ID candidates from distinct scopes independently deferrable', () => {
    const candidates = parseConciergeMemoryQueueResponse({
      ok: true,
      candidates: [candidateKey, otherCandidateKey].map((key) => ({
        ...legacyCandidate,
        candidateKey: key,
        learningReviewUrl: 'https://chronos.example.test/?section=knowledge&candidateKey=' + key,
      })),
    });
    expect(candidates).toHaveLength(2);
    if (!candidates) throw new Error('Expected valid scoped candidates');
    const entries = candidates.map((item): DecideQueueEntry => ({
      id: conciergeMemoryQueueEntryId(item),
      kind: 'memory',
      item,
    }));
    const firstId = conciergeMemoryQueueEntryId({ id: legacyCandidate.id, candidateKey });
    const secondId = conciergeMemoryQueueEntryId({
      id: legacyCandidate.id,
      candidateKey: otherCandidateKey,
    });
    expect(firstId).not.toBe(secondId);
    const grouped = groupDecideQueue(entries, new Set([firstId]));
    expect(grouped.deferred.map((entry) => entry.id)).toEqual([firstId]);
    expect(grouped.queue.map((entry) => entry.id)).toEqual([secondId]);
    expect(grouped.countsByKind.memory).toBe(1);
  });

  it('preserves legacy saved-deferral identity without aliasing scoped selectors', () => {
    expect(conciergeMemoryQueueEntryId(legacyCandidate)).toBe('memory-candidate-1');
    const scopedId = conciergeMemoryQueueEntryId({ id: legacyCandidate.id, candidateKey });
    expect(scopedId).not.toBe(conciergeMemoryQueueEntryId(legacyCandidate));
    expect(scopedId).not.toBe(conciergeMemoryQueueEntryId({ id: candidateKey }));
    expect(scopedId).not.toBe(conciergeMemoryQueueEntryId({ id: 'scoped:' + candidateKey }));
  });

  it('does not apply an old ID-only deferral to any scoped candidate', () => {
    const scopedIds = [candidateKey, otherCandidateKey].map((key) =>
      conciergeMemoryQueueEntryId({ id: legacyCandidate.id, candidateKey: key })
    );
    const legacyDeferredIds = new Set([conciergeMemoryQueueEntryId(legacyCandidate)]);
    expect(scopedIds.some((id) => legacyDeferredIds.has(id))).toBe(false);
  });
});
