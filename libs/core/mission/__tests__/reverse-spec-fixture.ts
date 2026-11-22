import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeMkdir, safeRmSync, safeWriteFile } from '../../secure-io.js';
import { writeJson } from '../../foundation/json.js';
import { computeSourceFingerprint } from '../../analysis/source-fingerprint.js';
import { REVERSE_SPEC_EVIDENCE_FILES, type ReverseSpecPurpose } from '../reverse-spec-evidence.js';

/** Test fixtures for reverse_spec / legacy_migration evidence gates (not shipped: __tests__ is excluded from the build). */
const ROOT = process.cwd();
const created: string[] = [];

export function cleanupFixtures(): void {
  for (const dir of created.splice(0)) safeRmSync(dir, { recursive: true, force: true });
}

export function write(file: string, content: unknown): void {
  safeMkdir(path.dirname(file), { recursive: true });
  if (typeof content === 'string') safeWriteFile(file, content);
  else writeJson(file, content);
}

/** A complete, passing reverse_spec evidence set over a two-file legacy source. */
export function reverseSpecFixture(purpose: ReverseSpecPurpose = 'rebuild') {
  const base = path.join(ROOT, 'active/shared/tmp', `reverse-spec-evidence-${randomUUID()}`);
  created.push(base);
  const source = path.join(base, 'legacy');
  const mission = path.join(base, 'mission');
  write(
    path.join(source, 'src/orders.py'),
    'from billing import charge\n\ndef place_order(total):\n    if total > 500: return charge(total * 0.85)\n    return charge(total)\n'
  );
  write(path.join(source, 'src/billing.py'), 'def charge(amount):\n    return amount\n');
  const sourceRoot = path.relative(ROOT, source).replaceAll(path.sep, '/');
  const docs = {
    scope: {
      source_root: sourceRoot,
      baseline_commit: 'abc1234',
      purpose,
      in_scope: ['src/'],
      exclusions: [],
      references: [{ path: 'README.md', kind: 'readme', status: 'unverified_claim' }],
      languages: ['python'],
    } as Record<string, unknown>,
    code_graph: {
      kind: 'code-graph-registry',
      schema_version: 1,
      source_root: sourceRoot,
      source_fingerprint: computeSourceFingerprint(source),
      nodes: [
        {
          id: 'MOD:src/orders.py',
          kind: 'module',
          language: 'python',
          path: 'src/orders.py',
          line: 1,
        },
        {
          id: 'MOD:src/billing.py',
          kind: 'module',
          language: 'python',
          path: 'src/billing.py',
          line: 1,
        },
      ],
      edges: [
        {
          from: 'MOD:src/orders.py',
          to: 'MOD:src/billing.py',
          kind: 'imports',
          path: 'src/orders.py',
          line: 1,
        },
      ],
      reconciliation: [
        {
          node_kind: 'module',
          route_a: { definition: 'tree-sitter program roots', count: 2 },
          route_b: { definition: 'file listing by extension', count: 2 },
          only_in_a: [],
          only_in_b: [],
          resolution: '',
        },
      ],
    } as Record<string, unknown>,
    analysis: {
      items: [
        { id: 'ANA-BEHAVIOR-01', category: 'BEHAVIOR', node_ids: ['MOD:src/orders.py'] },
        { id: 'ANA-API-01', category: 'API', node_ids: ['MOD:src/billing.py'] },
      ],
      dispositions: [],
    } as Record<string, unknown>,
    specify: {
      author_actor_id: 'writer-agent',
      specs: [
        {
          spec_id: 'SPEC-BEHAVIOR-ordering-01',
          layer: 'essence',
          path: 'evidence/specs/ordering.md',
          analysis_refs: ['ANA-BEHAVIOR-01', 'ANA-API-01'],
          claims: [
            {
              claim_id: 'C-001',
              confidence: 'confirmed',
              citations: [{ path: 'src/orders.py', line: 3 }],
            },
            { claim_id: 'C-002', confidence: 'unknown', unknown_class: 'deferred', citations: [] },
          ],
        },
      ],
    } as Record<string, unknown>,
    audit: {
      verifier_actor_id: 'verifier-agent',
      sampling: { method: 'full', population: 1, sample_size: 1 },
      entries: [{ claim_id: 'C-001', verdict: 'supported' }],
    } as Record<string, unknown>,
  };
  const flush = () => {
    for (const [stage, doc] of Object.entries(docs))
      write(path.join(mission, REVERSE_SPEC_EVIDENCE_FILES[stage as keyof typeof docs]), doc);
    write(path.join(mission, 'evidence/specs/ordering.md'), '# Ordering\n');
  };
  flush();
  return { base, mission, source, docs, flush };
}
