import { describe, expect, it } from 'vitest';
import {
  classifyTrustRequiringResource,
  requiresProjectTrust,
  TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES,
} from './trust-requiring-resources.js';

describe('trust-requiring resources', () => {
  it('keeps the trust-sensitive vocabulary explicit and deterministic', () => {
    expect(TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES).toEqual([
      '.kyberion-plugins.json',
      'pipelines/',
      'roles/PROCEDURE.md',
      'facets/',
      'AGENTS.override.md',
      'skills/',
    ]);
  });

  it('recognizes descendants while leaving ordinary knowledge readable', () => {
    expect(classifyTrustRequiringResource('./pipelines/deploy.json')).toBe('pipelines/');
    expect(classifyTrustRequiringResource('skills/release/SKILL.md')).toBe('skills/');
    expect(requiresProjectTrust('AGENTS.override.md')).toBe(true);
    expect(requiresProjectTrust('knowledge/public/guide.md')).toBe(false);
    expect(requiresProjectTrust('pipelines-other/notes.md')).toBe(false);
  });
});
