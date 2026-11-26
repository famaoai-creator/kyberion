import { describe, expect, it } from 'vitest';
import {
  ACTUATOR_ACTION_ALIASES,
  canonicalActuatorAction,
  normalizePipelineOp,
} from './pipeline-op-aliases.js';
import { compileRunManifest } from './run-manifest.js';

describe('actuator action aliases', () => {
  it('folds browser:navigate into browser:goto at runtime, like the Run Manifest compiler', () => {
    expect(canonicalActuatorAction('browser', 'navigate')).toBe('goto');
    expect(canonicalActuatorAction('browser', 'goto')).toBe('goto');
    expect(canonicalActuatorAction('shadowdomain', 'navigate')).toBe('navigate');
    // The runner dispatches normalizePipelineOp(step.op).
    expect(normalizePipelineOp('browser:navigate')).toBe('browser:goto');
    const manifest = compileRunManifest(
      [{ op: 'browser:navigate', params: { url: 'https://app.example.test/' } }],
      {
        inputPath: 'knowledge/confidential/fixture/x.json',
        contentSha256: 'h',
        scope: { tier: 'confidential', tenantSlug: 'fixture' },
      }
    );
    expect(manifest.requirements.effects[0].operation_id).toBe(
      normalizePipelineOp('browser:navigate')
    );
  });

  it('keeps every alias consistent between the compiler fold and runtime normalization', () => {
    for (const [domain, actions] of Object.entries(ACTUATOR_ACTION_ALIASES))
      for (const [alias, canonical] of Object.entries(actions))
        expect(normalizePipelineOp(`${domain}:${alias}`)).toBe(`${domain}:${canonical}`);
  });
});
