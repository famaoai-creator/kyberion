import { describe, expect, it } from 'vitest';
import {
  evaluateArtifactVerification,
  type ArtifactVerificationInput,
} from './artifact-verification.js';

const baseInput: ArtifactVerificationInput = {
  job: { status: 'completed' },
  file: { exists: true, path: 'active/shared/exports/sample.mp4' },
  content: { status: 'passed' },
  visual_review: {
    status: 'reviewed',
    findings: [],
    error_count: 0,
    warning_count: 0,
    images_reviewed: 3,
  },
  human_approval: { status: 'pending' },
};

describe('KA-06 artifact verification', () => {
  it('reports a completed artifact as ready, not published', () => {
    const result = evaluateArtifactVerification(baseInput);
    expect(result.status).toBe('ready_for_approval');
    expect(result.publication_allowed).toBe(false);
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      'job',
      'file',
      'content',
      'visual_review',
      'human_approval',
    ]);
  });

  it('does not treat a skipped visual review as a pass', () => {
    const result = evaluateArtifactVerification({
      ...baseInput,
      visual_review: {
        ...baseInput.visual_review,
        status: 'skipped',
        skipped_reason: 'no rasterizer',
      },
    });
    expect(result.status).toBe('blocked');
    expect(result.publication_allowed).toBe(false);
  });

  it('only allows publication after explicit human approval', () => {
    const result = evaluateArtifactVerification({
      ...baseInput,
      human_approval: { status: 'approved' },
    });
    expect(result.status).toBe('approved');
    expect(result.publication_allowed).toBe(true);
  });
});
