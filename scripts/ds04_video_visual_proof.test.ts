import { describe, expect, it } from 'vitest';
import { buildDs04ProofAdf } from './ds04_video_visual_proof.js';

describe('DS-04 visual proof entrypoint', () => {
  it('builds the governed semantic proof ADF without executing the renderer', () => {
    const adf = buildDs04ProofAdf('active/shared/tmp/ds04-test');
    expect(adf.kind).toBe('video-composition-adf');
    expect(adf.output).toEqual({
      format: 'mp4',
      bundle_dir: 'active/shared/tmp/ds04-test',
    });
    expect(adf.scenes).toHaveLength(1);
  });
});
