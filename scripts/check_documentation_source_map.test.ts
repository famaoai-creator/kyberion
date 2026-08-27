import { describe, expect, it } from 'vitest';
import {
  validateDocumentationSourceMap,
  checkDocumentationSourceMap,
} from './check_documentation_source_map.js';

const existingPaths = new Set([
  'docs/developer/improvement-plans-2026-08/README.ja.md',
  'docs/PRODUCTIZATION_ROADMAP.md',
  'docs/ROADMAP.md',
  'docs/ROADMAP_COMPLETION_LEDGER.md',
  'CHANGELOG.md',
  'docs/developer/improvement-plans-2026-07/README.ja.md',
  'docs/developer/improvement-plans-2026-07/STATUS.ja.md',
  'knowledge/product/architecture/organization-work-loop.md',
  'knowledge/product/architecture/kyberion-canonical-concept-index.md',
  'knowledge/product/architecture/enterprise-operating-kernel.md',
  'knowledge/product/architecture/kyberion-concept-map.md',
  'docs/WHY.md',
  'docs/INTENT_LOOP_CONCEPT.md',
  'docs/QUICKSTART.md',
  'docs/INITIALIZATION.md',
  'knowledge/product/governance/onboarding-flow.md',
  'knowledge/product/governance/phases/onboarding.md',
  'docs/operator/README.md',
  'README.md',
]);

const validManifest = {
  manifest_version: 1,
  categories: [
    {
      id: 'status',
      canonical: 'docs/developer/improvement-plans-2026-08/README.ja.md',
      supporting: [
        'docs/PRODUCTIZATION_ROADMAP.md',
        'docs/ROADMAP.md',
        'docs/ROADMAP_COMPLETION_LEDGER.md',
        'CHANGELOG.md',
      ],
      historical: [
        'docs/developer/improvement-plans-2026-07/README.ja.md',
        'docs/developer/improvement-plans-2026-07/STATUS.ja.md',
      ],
    },
    {
      id: 'concept',
      canonical: 'knowledge/product/architecture/organization-work-loop.md',
      index: 'knowledge/product/architecture/kyberion-canonical-concept-index.md',
      supporting: [
        'knowledge/product/architecture/enterprise-operating-kernel.md',
        'knowledge/product/architecture/kyberion-concept-map.md',
        'docs/WHY.md',
        'docs/INTENT_LOOP_CONCEPT.md',
      ],
    },
    {
      id: 'onboarding',
      canonical: 'docs/QUICKSTART.md',
      scoped_sources: [
        { scope: 'first_win', path: 'docs/QUICKSTART.md' },
        { scope: 'day_2_initialization', path: 'docs/INITIALIZATION.md' },
        {
          scope: 'tenant_organization_activation_and_first_work',
          path: 'knowledge/product/governance/onboarding-flow.md',
        },
      ],
      supporting: ['knowledge/product/governance/phases/onboarding.md', 'docs/operator/README.md'],
    },
  ],
  entrypoints: [
    'README.md',
    'docs/QUICKSTART.md',
    'docs/INITIALIZATION.md',
    'docs/developer/improvement-plans-2026-08/README.ja.md',
  ],
};

describe('documentation source map', () => {
  it('accepts the checked-in category and scope contract', () => {
    expect(validateDocumentationSourceMap(validManifest, existingPaths)).toEqual([]);
  });

  it('rejects duplicate onboarding scopes and a moved canonical status source', () => {
    const invalid = structuredClone(validManifest) as typeof validManifest;
    invalid.categories[0].canonical = 'docs/ROADMAP.md';
    invalid.categories[2].scoped_sources.push({
      scope: 'first_win',
      path: 'docs/INITIALIZATION.md',
    });
    const failures = validateDocumentationSourceMap(invalid, existingPaths);
    expect(failures).toContain(
      'status: canonical must be docs/developer/improvement-plans-2026-08/README.ja.md'
    );
    expect(failures).toContain('onboarding: duplicate scope first_win');
  });

  it('passes against the repository files and entrypoint links', () => {
    expect(checkDocumentationSourceMap()).toEqual([]);
  });
});
