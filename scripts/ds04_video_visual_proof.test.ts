import { describe, expect, it } from 'vitest';
import { buildDs04ProofAdf } from './ds04_video_visual_proof.js';

describe('DS-04 video visual proof fixture', () => {
  it('keeps the client-a palette on a single tokenized scene', () => {
    const adf = buildDs04ProofAdf('active/shared/tmp/ds04-video-visual-proof/client-a');
    const scene = adf.scenes[0];

    expect(adf.scenes).toHaveLength(1);
    expect(scene.template_ref?.template_id).toBe('split-highlight');
    expect(scene.content?.visual_steps).toHaveLength(3);
    expect(scene.content?.design_system_vars?.['--kb-accent']).toBe('#e879f9');
    expect(scene.content?.design_system_vars?.['--kb-accent-blue']).toBe('#a78bfa');
    expect(adf.output.bundle_dir).toContain('ds04-video-visual-proof/client-a');
  });
});
