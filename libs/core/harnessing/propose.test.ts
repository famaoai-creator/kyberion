import { describe, expect, it } from 'vitest';
import { proposeCandidates } from './propose.js';
import type { SurfaceSpec } from './surface-spec.js';

const spec: SurfaceSpec = { allowed_paths: ['config/'] };

describe('proposeCandidates', () => {
  it('degrades explicitly when the backend cannot produce usable overlays', async () => {
    // Whatever backend is active, a malformed brief still yields a structured
    // result — never a throw. On a stub/offline backend every candidate is
    // rejected with a recorded reason.
    const r = await proposeCandidates({
      brief: 'x',
      surface: spec,
      count: 1,
      outDir: 'active/shared/tmp/harnessing-propose-test',
    });
    expect(r).toHaveProperty('backend_used');
    expect(r).toHaveProperty('candidates');
    expect(r).toHaveProperty('rejected');
    for (const c of r.candidates) {
      expect(c.overlayDir).toContain('harnessing-propose-test');
    }
  });
});
