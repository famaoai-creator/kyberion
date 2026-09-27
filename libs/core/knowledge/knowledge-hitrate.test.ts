import { describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/km02-retrieval-queries.json';
import {
  KnowledgeHintIndex,
  queryKnowledge,
  _chunkMarkdownBody,
  type KnowledgeHint,
} from './knowledge-index.js';

// KM-02 Task 1.4: before/after hit-rate fixture. "Before" is the
// pre-chunking index (one 300-char summary entry per document); "after" adds
// the body-chunk entries the KM-02 chunker produces. The 10 "body" queries in
// the fixture are answerable only from text beyond the summary, so they pin
// the retrieval improvement chunking bought — if chunking regresses, this
// test fails before an operator notices worse recall.

interface DocSpec {
  file: string;
  title: string;
  head: string;
  bodyDetail: string;
}

const FILLER =
  'This section explains the operational background, the governing invariants, and the ' +
  'verification steps a worker follows before marking the task complete. It also records ' +
  'the failure modes observed in earlier missions and the recovery guidance distilled from them. ';

const DOCS: DocSpec[] = [
  {
    file: 'public/mesh-consensus.md',
    title: 'Mesh consensus operations',
    head: 'How peers reach agreement: quorum handshake tuning, vote windows, and leader churn.',
    bodyDetail:
      'When a partition heals, operators pull the xylograph rollback lever to discard divergent suffixes before rejoining the quorum.',
  },
  {
    file: 'public/egress-policy.md',
    title: 'Egress policy guide',
    head: 'Network egress manifest allowlist management for governed outbound requests.',
    bodyDetail:
      'Repeated violations climb the brumewick escalation ladder from warn to enforce to kill-switch.',
  },
  {
    file: 'public/embedding-cache.md',
    title: 'Embedding cache operations',
    head: 'Vector cache eviction budget, scope hashing, and model-keyed invalidation.',
    bodyDetail:
      'Nightly maintenance runs a quenchcoil compaction pass that rewrites fragmented cache files in place.',
  },
  {
    file: 'public/mission-recovery.md',
    title: 'Mission recovery runbook',
    head: 'Mission checkpoint resume: restoring state and continuing from the suspension point.',
    bodyDetail:
      'A farrowdene suspension marker in the journal indicates the mission was paused intentionally and must not be garbage-collected.',
  },
  {
    file: 'public/actuator-catalog.md',
    title: 'Actuator catalog reference',
    head: 'Actuator manifest discovery, capability listing, and op registry generation.',
    bodyDetail:
      'Before dispatch, the runner issues a veldspar preflight probe to confirm the binary and its sandbox entitlements.',
  },
  {
    file: 'public/approval-flow.md',
    title: 'Approval flow handbook',
    head: 'Approval sovereign gate: pending requests, channels, and decision recording.',
    bodyDetail:
      'High-stakes operations require the morrowgate dual signoff, two independent approvals recorded with correlation ids.',
  },
  {
    file: 'public/deck-grammar.md',
    title: 'Deck layout grammar',
    head: 'Slide layout grammar tokens: sections-first composition and renderer defaults.',
    bodyDetail:
      'Every generated deck passes a tessellume contrast audit so text stays legible on themed backgrounds.',
  },
  {
    file: 'public/bridge-ux.md',
    title: 'Bridge UX conventions',
    head: 'Bridge typing indicator loop cadence for discord, telegram, slack, and imessage.',
    bodyDetail:
      'When reactions are unavailable the bridge uses the glimmerfen reaction fallback, a short text acknowledgement instead.',
  },
  {
    file: 'public/cost-controls.md',
    title: 'Cost controls overview',
    head: 'Spend guard tenant override rules and weekly cost reporting for operators.',
    bodyDetail:
      'Long-running subscriptions are spread across periods with the coldspindle amortization table maintained by the cost report.',
  },
  {
    file: 'public/a2a-security.md',
    title: 'A2A security model',
    head: 'Peer envelope signature mode: warn versus enforce, key resolution, and audit events.',
    bodyDetail:
      'Deduplication tracks the harrowlark replay window; envelopes older than the window are rejected outright.',
  },
];

function docContent(doc: DocSpec): string {
  return [
    `# ${doc.title}`,
    '',
    doc.head,
    '',
    '## Background',
    '',
    FILLER + FILLER,
    '',
    '## Operational detail',
    '',
    FILLER + doc.bodyDetail,
    '',
    '## Verification',
    '',
    FILLER + FILLER,
  ].join('\n');
}

function buildIndex(withChunks: boolean): KnowledgeHintIndex {
  const hints: KnowledgeHint[] = [];
  for (const doc of DOCS) {
    const content = docContent(doc);
    hints.push({
      topic: doc.title,
      hint: content.slice(0, 300),
      source: doc.file,
      confidence: 0.6,
      tier: 'public',
    });
    if (withChunks) {
      _chunkMarkdownBody(content).forEach((chunk, i) => {
        hints.push({
          topic: doc.title,
          hint: chunk.slice(0, 1200),
          source: `${doc.file}#chunk${i}`,
          parentSource: doc.file,
          chunkIndex: i,
          confidence: 0.55,
          tier: 'public',
        });
      });
    }
  }
  return new KnowledgeHintIndex(hints);
}

function hitCount(index: KnowledgeHintIndex, needs?: 'head' | 'body'): number {
  let hits = 0;
  for (const q of fixture.queries) {
    if (needs && q.needs !== needs) continue;
    const results = queryKnowledge(index, q.query, { maxResults: 3 });
    if (results.some((r) => r.source === q.expected)) hits += 1;
  }
  return hits;
}

describe('KM-02 retrieval hit-rate fixture', () => {
  it('chunked index answers all 20 representative queries in the top 3', () => {
    const after = buildIndex(true);
    expect(hitCount(after)).toBe(fixture.queries.length);
  });

  it('body-only queries miss without chunks and hit with them (before/after)', () => {
    const before = buildIndex(false);
    const after = buildIndex(true);

    expect(hitCount(before, 'body')).toBe(0);
    expect(hitCount(after, 'body')).toBe(10);
    expect(hitCount(after)).toBeGreaterThanOrEqual(hitCount(before));
  });

  it('head queries were already served before chunking (no regression baseline)', () => {
    const before = buildIndex(false);
    expect(hitCount(before, 'head')).toBe(10);
  });
});
