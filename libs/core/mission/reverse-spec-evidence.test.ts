import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateReverseSpecEvidenceAt } from './reverse-spec-evidence.js';
import {
  cleanupFixtures,
  reverseSpecFixture as fixture,
  write,
} from './__tests__/reverse-spec-fixture.js';

afterEach(cleanupFixtures);

describe('reverse_spec evidence gates', () => {
  it('passes every stage for a complete evidence set', () => {
    const { mission } = fixture();
    for (const stage of ['scope', 'code_graph', 'analysis', 'specify', 'audit'] as const) {
      expect(validateReverseSpecEvidenceAt(mission, stage).ok).toBe(true);
    }
    expect(validateReverseSpecEvidenceAt(mission, 'audit').summary).toMatchObject({
      claims: 2,
      verified: 1,
    });
  });

  it('treats existing documents as claims and requires a baseline', () => {
    const { mission, docs, flush } = fixture();
    docs.scope.baseline_commit = 'not-a-sha';
    docs.scope.references = [{ path: 'design.md', kind: 'design', status: 'fact' }];
    flush();
    expect(() => validateReverseSpecEvidenceAt(mission, 'scope')).toThrow(
      /baseline_commit[\s\S]*unverified_claim/u
    );
  });

  it('rejects a code graph whose reconciliation differs without a resolution', () => {
    const { mission, docs, flush } = fixture();
    (docs.code_graph.reconciliation as Record<string, unknown>[])[0].only_in_b = ['src/legacy.ts'];
    flush();
    expect(() => validateReverseSpecEvidenceAt(mission, 'code_graph')).toThrow(
      /without a resolution/u
    );
  });

  it('requires every denominator node to be analyzed or dispositioned with a decision record', () => {
    const { mission, docs, flush } = fixture();
    docs.analysis.items = [
      { id: 'ANA-BEHAVIOR-01', category: 'BEHAVIOR', node_ids: ['MOD:src/orders.py'] },
    ];
    docs.analysis.dispositions = [
      {
        node_id: 'MOD:src/billing.py',
        status: 'out_of_scope',
        reason: 'vendor code',
        decision_ref: 'evidence/decisions/ADR-1.md',
      },
    ];
    flush();
    expect(() => validateReverseSpecEvidenceAt(mission, 'analysis')).toThrow(
      /decision_ref .* does not exist/u
    );
    write(path.join(mission, 'evidence/decisions/ADR-1.md'), '# ADR-1\n');
    expect(validateReverseSpecEvidenceAt(mission, 'analysis').ok).toBe(true);
    docs.analysis.dispositions = [];
    flush();
    expect(() => validateReverseSpecEvidenceAt(mission, 'analysis')).toThrow(
      /1\/2 code-graph nodes/u
    );
  });

  it('rejects uncited confirmed claims and citations that do not resolve', () => {
    const { mission, docs, flush } = fixture();
    const spec = (docs.specify.specs as Record<string, unknown>[])[0];
    spec.claims = [
      { claim_id: 'C-001', confidence: 'confirmed', citations: [] },
      {
        claim_id: 'C-003',
        confidence: 'inferred',
        citations: [{ path: 'src/orders.py', line: 99 }],
      },
      { claim_id: 'C-004', confidence: 'unknown', citations: [] },
      {
        claim_id: 'C-005',
        confidence: 'confirmed',
        universal: true,
        citations: [{ path: 'src/billing.py', line: 1 }],
      },
    ];
    flush();
    const run = () => validateReverseSpecEvidenceAt(mission, 'specify');
    expect(run).toThrow(/without a path:line citation: C-001/u);
    expect(run).toThrow(/beyond the end of the file/u);
    expect(run).toThrow(/unknown_class/u);
    expect(run).toThrow(/population/u);
  });

  it('requires an essence-layer spec unless the purpose is maintenance', () => {
    const { mission, docs, flush } = fixture('evaluation');
    (docs.specify.specs as Record<string, unknown>[])[0].layer = 'implementation';
    flush();
    expect(() => validateReverseSpecEvidenceAt(mission, 'specify')).toThrow(/essence layer/u);
    docs.scope.purpose = 'maintenance';
    flush();
    expect(validateReverseSpecEvidenceAt(mission, 'specify').ok).toBe(true);
  });

  it('requires an independent verifier and no open fabricated claims', () => {
    const { mission, docs, flush } = fixture();
    docs.audit.verifier_actor_id = 'writer-agent';
    docs.audit.entries = [{ claim_id: 'C-001', verdict: 'fabricated' }];
    flush();
    const run = () => validateReverseSpecEvidenceAt(mission, 'audit');
    expect(run).toThrow(/must be independent/u);
    expect(run).toThrow(/unsupported\/fabricated/u);
  });

  it('fails the audit when the analyzed source changed after the code graph froze', () => {
    const { mission, source } = fixture();
    write(path.join(source, 'src/billing.py'), 'def charge(amount):\n    return amount * 2\n');
    expect(() => validateReverseSpecEvidenceAt(mission, 'audit')).toThrow(
      /source changed since the code graph was frozen/u
    );
  });

  it('samples at least min(population, 30) confirmed claims for non-rebuild purposes', () => {
    const { mission, docs, flush } = fixture('maintenance');
    docs.audit.sampling = { method: 'random', population: 1, sample_size: 0 };
    docs.audit.entries = [];
    flush();
    expect(() => validateReverseSpecEvidenceAt(mission, 'audit')).toThrow(/at least 1 required/u);
  });
});
