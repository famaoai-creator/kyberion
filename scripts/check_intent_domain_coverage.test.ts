import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { loadIntentDomainOntologyCatalog } from '@agent/core/intent-resolution';
import { checkIntentDomainCoverage } from './check_intent_domain_coverage.js';

describe('intent domain coverage checker', () => {
  it('loads the canonical ontology catalog through the governed loader', () => {
    expect(loadIntentDomainOntologyCatalog().intents?.length).toBeGreaterThan(0);
  });

  it('passes the current canonical catalogs without a direct process boundary', () => {
    expect(checkIntentDomainCoverage()).toEqual([]);
  });

  it('does not reintroduce generic JSON readers for governed catalogs', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_intent_domain_coverage.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadIntentDomainOntologyCatalog()');
    expect(source).toContain('loadMissionTeamTemplates()');
    expect(source).toContain('loadOutcomeCatalog()');
    expect(source).not.toContain('readFoundationJson');
    expect(source).not.toContain('function readJson(');
  });
});
