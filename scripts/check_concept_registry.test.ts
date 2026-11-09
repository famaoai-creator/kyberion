import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_ROOT,
  CONCEPT_REGISTRY,
  DOCUMENTATION_SOURCE_MAP,
  GLOSSARY,
  checkArchitectureConcepts,
  checkConceptRegistry,
  checkGlossary,
  checkPlanIndexes,
  checkRetiredDocument,
  checkRetirementReferences,
  collectContributorVocabulary,
  collectHeadings,
  listArchitectureDocs,
  createCheckoutView,
  foldMultilineList,
  headingSlug,
  pruneBaseline,
  splitQualifiedHeading,
  validateRegistry,
  type ConceptRegistry,
  type ConceptRegistryBaseline,
  type RepoView,
} from './check_concept_registry.js';
import { resolveCiGateBaselinePath } from './lib/ci-gate-baseline.js';
import { readTextFile } from '@agent/core/foundation';

function memoryView(files: Record<string, string>): RepoView {
  const dirs = new Set<string>();
  for (const file of Object.keys(files)) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join('/'));
  }
  return {
    exists: (relativePath) => relativePath in files || dirs.has(relativePath),
    isDirectory: (relativePath) => dirs.has(relativePath),
    read: (relativePath) => {
      if (!(relativePath in files)) throw new Error(`missing ${relativePath}`);
      return files[relativePath];
    },
    list: (relativeDir) => {
      const prefix = `${relativeDir}/`;
      return [
        ...new Set(
          [...Object.keys(files), ...dirs]
            .filter((candidate) => candidate.startsWith(prefix))
            .map((candidate) => candidate.slice(prefix.length).split('/')[0])
        ),
      ];
    },
  };
}

const GLOSSARY_OK = [
  '# Glossary',
  '### Contributor vocabulary',
  '| Term | Canonical definition |',
  '| ---- | -------------------- |',
  '| WorkItem | The shared record. |',
  '## Units of work',
  '### WorkItem',
  '### Channel (delivery route)',
  '### Channel (interaction context)',
  '### Stance',
].join('\n');

function registry(overrides: Partial<ConceptRegistry['terms'][number]>[] = []): ConceptRegistry {
  return {
    manifest_version: 1,
    terms: [
      {
        id: 'work-item',
        term: 'WorkItem',
        aliases: ['work item'],
        category: 'unit_of_work',
        definition: 'The shared record.',
        glossary_anchor: 'workitem',
        canonical_doc: 'docs/GLOSSARY.md#units-of-work',
        owner_modules: ['libs/core/work.ts'],
        not_to_confuse_with: ['stance'],
      },
      {
        id: 'stance',
        term: 'Stance',
        category: 'identity',
        definition: 'A runtime overlay.',
        glossary_anchor: 'stance',
        canonical_doc: 'knowledge/product/architecture/stance.md',
      },
      {
        id: 'channel',
        term: 'Channel',
        category: 'surface',
        definition: 'A homonym.',
        glossary_anchor: 'channel-delivery-route',
        canonical_doc: 'docs/GLOSSARY.md',
        senses: [
          {
            qualifier: 'delivery route',
            glossary_anchor: 'channel-delivery-route',
            definition: 'x',
          },
          {
            qualifier: 'interaction context',
            glossary_anchor: 'channel-interaction-context',
            definition: 'y',
          },
        ],
      },
      ...(overrides as ConceptRegistry['terms']),
    ],
  };
}

const baseFiles: Record<string, string> = {
  [GLOSSARY]: GLOSSARY_OK,
  'libs/core/work.ts': '',
  'knowledge/product/architecture/stance.md': '---\ntitle: S\nconcepts: [stance]\n---\n# S\n',
};

describe('markdown helpers', () => {
  it('slugs headings like GitHub', () => {
    expect(headingSlug('NHI (Non-Human Identity)')).toBe('nhi-non-human-identity');
    expect(headingSlug("Tenant's Customers")).toBe('tenants-customers');
    expect(headingSlug('ViewerContext / Viewer Scope')).toBe('viewercontext--viewer-scope');
  });

  it('splits qualified headings', () => {
    expect(splitQualifiedHeading('Channel (delivery route)')).toEqual({
      base: 'channel',
      qualifier: 'delivery route',
    });
    expect(splitQualifiedHeading('Mission')).toEqual({ base: 'mission' });
  });

  it('folds multi-line concepts lists and rejects anything else', () => {
    const fm = (body: string) => `---\ntitle: T\n${body}\n---\n# T\n`;
    expect(foldMultilineList(fm('concepts:\n  [\n    a,\n    b,\n  ]'), 'concepts')).toBe(
      '[ a, b, ]'
    );
    expect(foldMultilineList(fm('concepts:\n  [a, b]').replace(/\n/g, '\r\n'), 'concepts')).toBe(
      '[a, b]'
    );
    expect(foldMultilineList(fm('concepts:\n  - a\n  - "b"\nother: x'), 'concepts')).toBe(
      '[a, "b"]'
    );
    expect(foldMultilineList(fm('concepts:\n- a\n- b'), 'concepts')).toBe('[a, b]');
    expect(foldMultilineList(fm('concepts:\n  just prose'), 'concepts')).toBeUndefined();
    expect(foldMultilineList(fm('concepts:'), 'concepts')).toBeUndefined();
    expect(foldMultilineList(fm('concepts.x:\n  [a]'), 'concepts')).toBeUndefined();
  });

  it('reads the contributor vocabulary table only', () => {
    const rows = collectContributorVocabulary(GLOSSARY_OK + '\n| Other | not in table |');
    expect([...rows.keys()]).toEqual(['workitem']);
  });
});

describe('validateRegistry (C1)', () => {
  it('accepts a consistent registry', () => {
    expect(validateRegistry(registry(), memoryView(baseFiles))).toEqual([]);
  });

  it('rejects a term or alias claimed by two entries', () => {
    const failures = validateRegistry(
      registry([
        {
          id: 'work-unit',
          term: 'Work Item',
          category: 'unit_of_work',
          definition: 'dup',
          glossary_anchor: 'workitem',
          canonical_doc: 'docs/GLOSSARY.md',
        },
      ]),
      memoryView(baseFiles)
    );
    expect(failures.join('\n')).toMatch(/"Work Item" is claimed by both work-item and work-unit/);
  });

  it('accepts transitioning and deprecated terms that cite a decision and a plan', () => {
    const view = memoryView({ ...baseFiles, 'adr.md': '# adr\n\n## Lease\n', 'plan.md': '# plan' });
    expect(
      validateRegistry(
        registry([
          {
            id: 'lease',
            term: 'Lease',
            category: 'governance',
            definition: 'x',
            glossary_anchor: 'lease',
            canonical_doc: 'docs/GLOSSARY.md',
            lifecycle: { state: 'transitioning', decision: 'adr.md#lease', plan: 'plan.md' },
          },
          {
            id: 'old-lease',
            term: 'Old Lease',
            category: 'governance',
            definition: 'x',
            glossary_anchor: 'old-lease',
            canonical_doc: 'docs/GLOSSARY.md',
            lifecycle: { state: 'deprecated', decision: 'adr.md', replaced_by: ['lease'] },
          },
        ]),
        view
      )
    ).toEqual([]);
  });

  it('rejects lifecycles without evidence or with dangling replacements', () => {
    const failures = validateRegistry(
      registry([
        {
          id: 'moving',
          term: 'Moving',
          category: 'scope',
          definition: 'x',
          glossary_anchor: 'moving',
          canonical_doc: 'docs/GLOSSARY.md',
          lifecycle: { state: 'transitioning', decision: 'missing-adr.md' },
        },
        {
          id: 'gone',
          term: 'Gone',
          category: 'scope',
          definition: 'x',
          glossary_anchor: 'gone',
          canonical_doc: 'docs/GLOSSARY.md',
          lifecycle: { state: 'deprecated', decision: 'docs/GLOSSARY.md', replaced_by: ['gone2'] },
        },
        {
          id: 'gone2',
          term: 'Gone2',
          category: 'scope',
          definition: 'x',
          glossary_anchor: 'gone2',
          canonical_doc: 'docs/GLOSSARY.md',
          lifecycle: { state: 'deprecated', decision: 'docs/GLOSSARY.md', replaced_by: ['nobody'] },
        },
        {
          id: 'stray',
          term: 'Stray',
          category: 'scope',
          definition: 'x',
          glossary_anchor: 'stray',
          canonical_doc: 'docs/GLOSSARY.md',
          lifecycle: {
            state: 'transitioning',
            decision: 'docs/GLOSSARY.md',
            plan: 'docs/GLOSSARY.md',
            replaced_by: ['gone'],
          },
        },
      ]),
      memoryView(baseFiles)
    ).join('\n');
    expect(failures).toMatch(/moving lifecycle\.decision does not exist/);
    expect(failures).toMatch(/moving is transitioning — name the migration plan/);
    expect(failures).toMatch(/gone replaced_by gone2, which is itself deprecated/);
    expect(failures).toMatch(/gone2 replaced_by unknown id nobody/);
    expect(failures).toMatch(/stray lists replaced_by but is not deprecated/);
  });

  it('rejects a lifecycle anchor that names no heading', () => {
    const view = memoryView({
      ...baseFiles,
      'adr.md': '# ADR\n\n## D1 — Real\n',
      'plan.md': '# p',
    });
    const failures = validateRegistry(
      registry([
        {
          id: 'moving',
          term: 'Moving',
          category: 'scope',
          definition: 'x',
          glossary_anchor: 'moving',
          canonical_doc: 'docs/GLOSSARY.md',
          lifecycle: { state: 'transitioning', decision: 'adr.md#d9--renamed', plan: 'plan.md' },
        },
        {
          id: 'fine',
          term: 'Fine',
          category: 'scope',
          definition: 'x',
          glossary_anchor: 'fine',
          canonical_doc: 'docs/GLOSSARY.md',
          lifecycle: { state: 'transitioning', decision: 'adr.md#d1--real', plan: 'plan.md' },
        },
      ]),
      view
    ).join('\n');
    expect(failures).toMatch(/moving lifecycle\.decision has no heading #d9--renamed/);
    expect(failures).not.toMatch(/fine/);
  });

  it('rejects missing canonical docs, owner modules and unknown confusion ids', () => {
    const failures = validateRegistry(
      registry([
        {
          id: 'ghost',
          term: 'Ghost',
          category: 'scope',
          definition: 'x',
          glossary_anchor: 'ghost',
          canonical_doc: 'docs/missing.md',
          owner_modules: ['libs/core/missing.ts'],
          not_to_confuse_with: ['nobody'],
        },
      ]),
      memoryView(baseFiles)
    ).join('\n');
    expect(failures).toMatch(/canonical_doc does not exist: docs\/missing.md/);
    expect(failures).toMatch(/owner module does not exist: libs\/core\/missing.ts/);
    expect(failures).toMatch(/not_to_confuse_with unknown id nobody/);
  });
});

describe('checkGlossary (C2/C3)', () => {
  it('accepts declared homonyms and matching definitions', () => {
    expect(checkGlossary(registry(), GLOSSARY_OK)).toEqual([]);
  });

  it('rejects a term defined twice without declared senses', () => {
    const glossary = `${GLOSSARY_OK}\n### Stance (Customer Overlay)`;
    expect(checkGlossary(registry(), glossary).join('\n')).toMatch(
      /"stance" is defined 2 times \(lines 10, 11\)/
    );
  });

  it('rejects a qualifier that is not a declared sense', () => {
    const glossary = `${GLOSSARY_OK}\n### Channel (team)`;
    expect(checkGlossary(registry(), glossary).join('\n')).toMatch(/"channel" is defined 3 times/);
  });

  it('rejects a contributor-vocabulary row that drifts from the registry', () => {
    const glossary = GLOSSARY_OK.replace(
      '| WorkItem | The shared record. |',
      '| WorkItem | The canonical unit of executable work. |'
    );
    expect(checkGlossary(registry(), glossary).join('\n')).toMatch(
      /Contributor vocabulary row "WorkItem" must equal the registry definition/
    );
  });

  it('rejects registry entries without a glossary heading', () => {
    const glossary = GLOSSARY_OK.replace('### Stance', '### Posture');
    expect(checkGlossary(registry(), glossary).join('\n')).toMatch(/no heading for stance/);
  });
});

describe('retirement lifecycle (C4/C5)', () => {
  const sourceMap = {
    categories: [
      {
        id: 'concept',
        canonical: 'docs/new.md',
        index: 'docs/old-index.md',
        historical: ['docs/archive.md'],
      },
    ],
  };

  it('rejects a superseded doc that is still listed as an index', () => {
    const view = memoryView({
      ...baseFiles,
      'docs/new.md': '# new',
      'docs/old-index.md':
        '---\ntitle: Old\ndoc_status: superseded\nsuperseded_by: docs/new.md\n---\n',
      'docs/archive.md': '---\ntitle: A\ndoc_status: historical\n---\n',
    });
    expect(checkRetirementReferences(registry(), sourceMap, view).join('\n')).toMatch(
      /docs\/old-index.md is doc_status superseded — move it to that category's historical list/
    );
  });

  it('rejects a registry canonical_doc that is retired', () => {
    const view = memoryView({
      ...baseFiles,
      'knowledge/product/architecture/stance.md': '---\ntitle: S\ndoc_status: historical\n---\n',
    });
    expect(checkRetirementReferences(registry(), { categories: [] }, view).join('\n')).toMatch(
      /stance canonical_doc knowledge\/product\/architecture\/stance.md is doc_status historical/
    );
  });

  it('requires superseded_by on superseded architecture docs and validates its target', () => {
    const baseline: ConceptRegistryBaseline = {
      version: 1,
      architecture_docs_without_concepts: [],
    };
    const view = memoryView({
      ...baseFiles,
      [`${ARCHITECTURE_ROOT}/a.md`]: '---\ntitle: A\ndoc_status: superseded\n---\n',
      [`${ARCHITECTURE_ROOT}/b.md`]:
        '---\ntitle: B\ndoc_status: superseded\nsuperseded_by: docs/nowhere.md\n---\n',
      [`${ARCHITECTURE_ROOT}/c.md`]: '---\ntitle: C\ndoc_status: obsolete\n---\n',
    });
    const failures = checkArchitectureConcepts(registry(), baseline, view).join('\n');
    expect(failures).toMatch(/a.md: doc_status superseded requires superseded_by/);
    expect(failures).toMatch(/b.md: superseded_by does not exist: docs\/nowhere.md/);
    expect(failures).toMatch(/c.md: doc_status must be one of superseded\|historical/);
  });
});

describe('architecture concepts ratchet (C6)', () => {
  it('requires new architecture docs to declare registered concepts', () => {
    const baseline: ConceptRegistryBaseline = {
      version: 1,
      architecture_docs_without_concepts: [`${ARCHITECTURE_ROOT}/legacy.md`],
    };
    const view = memoryView({
      ...baseFiles,
      [`${ARCHITECTURE_ROOT}/legacy.md`]: '---\ntitle: L\n---\n',
      [`${ARCHITECTURE_ROOT}/fresh.md`]: '---\ntitle: F\n---\n',
      [`${ARCHITECTURE_ROOT}/typo.md`]: '---\ntitle: T\nconcepts: [stanse]\n---\n',
    });
    const failures = checkArchitectureConcepts(registry(), baseline, view).join('\n');
    expect(failures).toMatch(/fresh.md: new architecture docs must declare concepts/);
    expect(failures).toMatch(/typo.md: concepts lists unregistered id "stanse"/);
    expect(failures).not.toMatch(/legacy.md/);
  });

  it('reads prettier-wrapped flow lists and block lists as concepts', () => {
    const baseline: ConceptRegistryBaseline = {
      version: 1,
      architecture_docs_without_concepts: [],
    };
    const view = memoryView({
      ...baseFiles,
      [`${ARCHITECTURE_ROOT}/wrapped.md`]:
        '---\ntitle: W\nconcepts:\n  [\n    stance,\n    work-item,\n  ]\n---\n',
      [`${ARCHITECTURE_ROOT}/block.md`]: '---\ntitle: B\nconcepts:\n  - stance\n  - stanse\n---\n',
      [`${ARCHITECTURE_ROOT}/prose.md`]: '---\ntitle: P\nconcepts:\n  stance and more\n---\n',
    });
    const failures = checkArchitectureConcepts(registry(), baseline, view).join('\n');
    expect(failures).not.toMatch(/wrapped.md/);
    expect(failures).toMatch(/block.md: concepts lists unregistered id "stanse"/);
    expect(failures).toMatch(/prose.md: concepts must be an inline list/);
  });

  it('fails on stale baseline entries and prunes them without adding any', () => {
    const baseline: ConceptRegistryBaseline = {
      version: 1,
      architecture_docs_without_concepts: [
        `${ARCHITECTURE_ROOT}/stance.md`,
        `${ARCHITECTURE_ROOT}/gone.md`,
      ],
    };
    const view = memoryView({ ...baseFiles, [`${ARCHITECTURE_ROOT}/fresh.md`]: '# no fm' });
    const failures = checkArchitectureConcepts(registry(), baseline, view).join('\n');
    expect(failures).toMatch(
      /baseline: knowledge\/product\/architecture\/stance.md no longer needs/
    );
    expect(failures).toMatch(/baseline: knowledge\/product\/architecture\/gone.md no longer needs/);
    expect(pruneBaseline(baseline, view).architecture_docs_without_concepts).toEqual([]);
  });
});

describe('monthly plan indexes (C7)', () => {
  const sourceMap = {
    categories: [
      { id: 'status', canonical: 'docs/developer/improvement-plans-2026-08/README.ja.md' },
    ],
  };

  it('requires a README linking every plan, and the status index linking every month', () => {
    const view = memoryView({
      'docs/developer/improvement-plans-2026-08/README.ja.md':
        '[a](./A.ja.md) [09](../improvement-plans-2026-09/README.ja.md)',
      'docs/developer/improvement-plans-2026-08/A.ja.md': '',
      'docs/developer/improvement-plans-2026-09/README.ja.md': '[b](./B.ja.md)',
      'docs/developer/improvement-plans-2026-09/B.ja.md': '',
      'docs/developer/improvement-plans-2026-09/C.ja.md': '',
      'docs/developer/improvement-plans-2026-10/D.ja.md': '',
      'docs/developer/improvement-plans-2026-11/README.ja.md': '',
      'docs/developer/improvement-plans-archive/E.ja.md': '',
    });
    const failures = checkPlanIndexes(sourceMap, view);
    expect(failures).toEqual([
      'docs/developer/improvement-plans-2026-09/README.ja.md: does not link C.ja.md',
      'docs/developer/improvement-plans-2026-10: missing README.ja.md index for 1 plans',
      'docs/developer/improvement-plans-2026-08/README.ja.md: status index must link docs/developer/improvement-plans-2026-11/README.ja.md',
    ]);
  });

  it('does not accept a same-named plan from another month as the link', () => {
    const view = memoryView({
      'docs/developer/improvement-plans-2026-09/README.ja.md':
        '[x](../improvement-plans-2026-10/SAME.ja.md)',
      'docs/developer/improvement-plans-2026-09/SAME.ja.md': '',
      'docs/developer/improvement-plans-2026-10/README.ja.md': '[x](./SAME.ja.md)',
      'docs/developer/improvement-plans-2026-10/SAME.ja.md': '',
    });
    expect(checkPlanIndexes({ categories: [] }, view)).toEqual([
      'docs/developer/improvement-plans-2026-09/README.ja.md: does not link SAME.ja.md',
    ]);
  });
});

describe('review hardening', () => {
  it('ignores headings inside fences, including nested fence markers', () => {
    const markdown = [
      '````md',
      '```',
      '### Fake',
      '```',
      '````',
      '### Real',
      '~~~',
      '### Hidden',
      '~~~',
    ].join('\n');
    expect(collectHeadings(markdown).map((heading) => heading.text)).toEqual(['Real']);
  });

  it('rejects a registered alias that has its own glossary definition', () => {
    const glossary = `${GLOSSARY_OK}\n### Work Item`;
    expect(checkGlossary(registry(), glossary).join('\n')).toMatch(
      /alias "work item" of work-item has its own definition/
    );
  });

  it('rejects doc_status on improvement plans', () => {
    const plan = 'docs/developer/improvement-plans-2026-11/P.ja.md';
    const view = memoryView({
      [plan]: '---\ntitle: P\nstatus: active\ndoc_status: superseded\n---\n',
    });
    expect(checkRetiredDocument(view, plan).join('\n')).toMatch(
      /improvement plans use their own status/
    );
  });

  it('scans architecture subdirectories', () => {
    const view = memoryView({ [`${ARCHITECTURE_ROOT}/decisions/d.md`]: '# d' });
    expect(listArchitectureDocs(view)).toEqual([`${ARCHITECTURE_ROOT}/decisions/d.md`]);
  });

  it('validates doc_status outside the architecture folder', () => {
    const files: Record<string, string> = {
      'knowledge/product/governance/concept-registry.json': JSON.stringify(registry()),
      'docs/documentation-source-map.json': JSON.stringify({ categories: [] }),
      ...baseFiles,
      'docs/OLD.md': '---\ntitle: Old\ndoc_status: deprecated\n---\n',
    };
    const failures = checkConceptRegistry(memoryView(files), {
      version: 1,
      architecture_docs_without_concepts: [],
    }).join('\n');
    expect(failures).toMatch(/docs\/OLD.md: doc_status must be one of superseded\|historical/);
  });
});

describe('checkout', () => {
  it('passes on the current repository content', () => {
    const view = createCheckoutView();
    const baseline = JSON.parse(
      readTextFile(resolveCiGateBaselinePath('concept-registry'))
    ) as ConceptRegistryBaseline;
    expect(view.exists(CONCEPT_REGISTRY)).toBe(true);
    expect(view.exists(DOCUMENTATION_SOURCE_MAP)).toBe(true);
    expect(checkConceptRegistry(view, baseline)).toEqual([]);
  });
});
