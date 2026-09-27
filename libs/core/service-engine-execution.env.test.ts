import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { buildPresetProcessEnv } from './service-engine-execution.js';

/**
 * DR-01: a service preset's `alt.env` overlay (CLI and stdio MCP children) is
 * data, so it may never set execution authority for the child.
 */
describe('service preset process env (DR-01)', () => {
  it('drops execution-authority keys and keeps the rest', () => {
    expect(
      buildPresetProcessEnv({
        API_BASE: 'https://example.invalid',
        RETRIES: 3,
        SYSTEM_ROLE: 'ecosystem_architect',
        MISSION_ROLE: 'mission_controller',
        KYBERION_PERSONA: 'sovereign',
        KYBERION_DELEGATED_ROLE: 'ecosystem_architect@concierge',
        KYBERION_SUDO: 'true',
      })
    ).toEqual({ API_BASE: 'https://example.invalid', RETRIES: '3' });
  });

  it('returns undefined when nothing but authority keys remain', () => {
    expect(buildPresetProcessEnv({ SYSTEM_ROLE: 'x' })).toBeUndefined();
    expect(buildPresetProcessEnv(undefined)).toBeUndefined();
  });

  it('is used for every preset child-process env, not for HTTP headers', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/service-engine-execution.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(
      /buildChildEnv\(\s*(?:options\?\.env|stripUnresolvedTemplateValues\(\s*resolveTemplateValue\(input\.alt\.env)/u
    );
    expect(source.match(/buildPresetProcessEnv\(/gu)?.length).toBeGreaterThanOrEqual(4);
  });
});
