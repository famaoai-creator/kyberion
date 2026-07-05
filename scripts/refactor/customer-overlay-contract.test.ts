import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeReadFile } from '@agent/core';
import { normalizeMissionVisionRef, parseMissionVisionRef } from './mission-creation.js';

const ROOT = pathResolver.rootDir();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

describe('mission refactor customer overlay contract', () => {
  it('uses the active customer root for mission prerequisites and a structured company vision ref', () => {
    const state = read('scripts/refactor/mission-state.ts');
    const creation = read('scripts/refactor/mission-creation.ts');
    const llm = read('scripts/refactor/mission-llm.ts');

    // mission-state.ts uses resolveActiveProfileRoot() (refactored from customerResolver.customerRoot)
    expect(state).toContain('resolveActiveProfileRoot');
    expect(state).toContain('my-identity.json');
    expect(state).toContain('my-vision.md');
    expect(state).toContain('agent-identity.json');
    expect(state).toContain('Sovereign profile incomplete');
    expect(state).toContain('complete customer onboarding');
    expect(creation).toContain('resolveCompany');
    expect(creation).toContain('buildCompanyVisionRef');
    expect(creation).toContain('company://');
    expect(creation).not.toContain("customerResolver.customerRoot('my-vision.md')");
    expect(llm).toContain("customerResolver.customerRoot('my-identity.json')");
  });

  it('normalizes mission vision refs to company URIs while preserving explicit company and vision URIs', () => {
    const tempRoot = pathResolver.sharedTmp('mission-vision-ref-test');

    expect(normalizeMissionVisionRef(undefined, 'acme', tempRoot)).toBe('company://acme/vision');
    expect(normalizeMissionVisionRef('company://acme/vision', 'acme', tempRoot)).toBe(
      'company://acme/vision'
    );
    expect(normalizeMissionVisionRef('vision://custom', 'acme', tempRoot)).toBe('vision://custom');
    expect(normalizeMissionVisionRef('legacy free string', 'acme', tempRoot)).toBe(
      'company://acme/vision?source=legacy%20free%20string'
    );
  });

  it('parses mission vision refs into structured summaries for routing', () => {
    expect(
      parseMissionVisionRef('company://acme/vision?source=legacy free string', 'acme')
    ).toEqual({
      raw: 'company://acme/vision?source=legacy free string',
      kind: 'company',
      tenant_slug: 'acme',
      path: 'vision',
      query: 'source=legacy free string',
    });
    expect(parseMissionVisionRef('vision://custom/path', 'acme')).toEqual({
      raw: 'vision://custom/path',
      kind: 'vision',
      tenant_slug: 'acme',
      path: 'custom/path',
      query: null,
    });
    expect(parseMissionVisionRef('legacy free string', 'acme')).toEqual({
      raw: 'legacy free string',
      kind: 'legacy',
      tenant_slug: 'acme',
      path: null,
      query: null,
    });
  });
});
