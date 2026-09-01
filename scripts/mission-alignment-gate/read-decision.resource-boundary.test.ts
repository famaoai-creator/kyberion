import { describe, expect, it } from 'vitest';
import { resolveDecisionResourcePath } from './read-decision.js';

describe('mission alignment decision resource boundary', () => {
  it('rejects repository-external reviewed resources', () => {
    expect(() => resolveDecisionResourcePath('/tmp/reviewed.html', true)).toThrow(
      /RESOURCE_PATH_SCOPE/u
    );
    expect(() => resolveDecisionResourcePath('../outside/brief.json', true)).toThrow(
      /RESOURCE_PATH_SCOPE/u
    );
  });
});
