import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync, safeReadFile } from './secure-io.js';
import { createArtifactRecord, loadArtifactRecord, saveArtifactRecord } from './artifact-record.js';

function cleanupArtifact(artifactId: string): void {
  const filePath = pathResolver.shared(`runtime/artifacts/${artifactId}.json`);
  if (safeExistsSync(filePath)) safeRmSync(filePath);
}

describe('artifact-record', () => {
  beforeEach(() => {
    cleanupArtifact('ART-QUALITY-DOC');
    cleanupArtifact('ART-QUALITY-DECK');
  });

  it('annotates saved document artifacts with deliverable quality metadata', () => {
    const artifact = createArtifactRecord({
      artifact_id: 'ART-QUALITY-DOC',
      project_id: 'PRJ-QUALITY',
      task_session_id: 'TSK-QUALITY',
      kind: 'markdown',
      storage_class: 'artifact_store',
      path: 'active/shared/tmp/quality-doc.md',
      preview_text: [
        '# Title',
        '',
        '## Body',
        '',
        'This document has enough content to produce a stable quality score.',
        'It is sufficiently structured to exercise the quality gate path.',
        'The content is intentionally long enough to pass the baseline document-length threshold used by the quality helper.',
      ].join('\n'),
    });

    const filePath = saveArtifactRecord(artifact);
    const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
    expect(parsed.metadata).toMatchObject({
      quality_kind: 'doc',
      quality_verdict: 'ok',
      quality_score: 100,
    });
    expect(loadArtifactRecord('ART-QUALITY-DOC')?.metadata).toMatchObject({
      quality_kind: 'doc',
      quality_verdict: 'ok',
    });
  });

  it('infers deck artifacts from their kind and stores warn-level quality metadata', () => {
    const artifact = createArtifactRecord({
      artifact_id: 'ART-QUALITY-DECK',
      project_id: 'PRJ-QUALITY',
      task_session_id: 'TSK-QUALITY',
      kind: 'pptx',
      storage_class: 'artifact_store',
      path: 'active/shared/tmp/quality-deck.pptx',
      preview_text: 'Deck preview.',
      metadata: { slide_count: 2 },
    });

    const filePath = saveArtifactRecord(artifact);
    const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
    expect(parsed.metadata).toMatchObject({
      quality_kind: 'deck',
      quality_verdict: 'warn',
      quality_score: 50,
    });
  });
});
