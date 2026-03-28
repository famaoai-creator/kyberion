import { describe, expect, it } from 'vitest';
import { createDistillCandidateRecord } from './distill-candidate-registry.js';
import { buildPromotedMemoryRecord, savePromotedMemoryRecord } from './promoted-memory.js';
import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';

describe('promoted-memory', () => {
  it('builds a tier-aware promoted memory record', () => {
    const candidate = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'confidential',
      title: 'Reusable SOP candidate',
      summary: 'Operational handling should be reusable.',
      status: 'promoted',
      target_kind: 'sop_candidate',
    });
    const record = buildPromotedMemoryRecord(candidate);
    expect(record.kind).toBe('sop_candidate');
    expect(record.tier).toBe('confidential');
    if (record.kind !== 'sop_candidate') throw new Error('expected sop_candidate');
    expect(record.procedure_steps.length).toBeGreaterThan(0);
    expect(record.safety_notes.length).toBeGreaterThan(0);
  });

  it('builds kind-specific records from metadata', () => {
    const hintCandidate = createDistillCandidateRecord({
      source_type: 'artifact',
      tier: 'public',
      title: 'Browser hint',
      summary: 'Use the browser operator for repeatable site navigation.',
      status: 'promoted',
      target_kind: 'knowledge_hint',
      specialist_id: 'browser-operator',
      metadata: {
        hint_scope: 'browser navigation',
        hint_triggers: ['open site', 'go to page'],
        recommended_refs: ['knowledge/public/procedures/browser/navigate-web.md'],
      },
    });
    const record = buildPromotedMemoryRecord(hintCandidate);
    expect(record.kind).toBe('knowledge_hint');
    if (record.kind !== 'knowledge_hint') throw new Error('expected knowledge_hint');
    expect(record.hint_scope).toBe('browser navigation');
    expect(record.hint_triggers).toContain('open site');
    expect(record.recommended_refs[0]).toContain('navigate-web.md');
  });

  it('writes structured json and markdown outputs with kind-specific sections', () => {
    const candidate = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'public',
      title: 'Reusable pattern',
      summary: 'Presentation pattern should be reusable.',
      status: 'promoted',
      target_kind: 'pattern',
      artifact_ids: ['ART-1'],
      evidence_refs: ['artifact:ART-1'],
      metadata: {
        applicability: ['presentation delivery', 'document specialist'],
        reusable_steps: ['Review the prior deck', 'Adapt the structure', 'Validate the output'],
        expected_outcome: 'A reusable presentation artifact.',
      },
    });
    const saved = savePromotedMemoryRecord(candidate, { executionRole: 'chronos_gateway' });
    expect(saved.logicalPath).toContain('knowledge/public/common/patterns/generated/');
    expect(saved.record.record_id).toBe(candidate.candidate_id);
    expect(saved.record.kind).toBe('pattern');
    if (saved.record.kind !== 'pattern') throw new Error('expected pattern');
    expect(saved.record.applicability).toContain('presentation delivery');
    const markdownPath = pathResolver.resolve(saved.logicalPath);
    const markdown = safeReadFile(markdownPath, { encoding: 'utf8' }) as string;
    expect(markdown).toContain('## Applicability');
    expect(markdown).toContain('## Reusable Steps');
    expect(markdown).toContain('A reusable presentation artifact.');
  });
});
