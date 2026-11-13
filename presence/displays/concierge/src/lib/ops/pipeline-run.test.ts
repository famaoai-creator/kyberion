import { describe, expect, it } from 'vitest';

import { dispatchPipelineRun, PipelineRunError } from './pipeline-run';

describe('dispatchPipelineRun context guard', () => {
  // The guard throws before any child is started, so nothing is spawned here.
  it.each(['_knowledge_scope', 'mission_tier', 'mission_dir', 'trust_resolved', '__private'])(
    'refuses a caller context that sets %s for every caller, before starting a child',
    (key) => {
      const run = () =>
        dispatchPipelineRun({
          pipelinePath: 'pipelines/vital-check.json',
          context: { topic: 'weekly', [key]: 'value' },
          label: 'schedule:stored',
        });
      expect(run).toThrow(PipelineRunError);
      expect(run).toThrow(`pipeline context must not set runner-derived keys: ${key}`);
    }
  );
});
