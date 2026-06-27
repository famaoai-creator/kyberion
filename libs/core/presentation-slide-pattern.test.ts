import * as path from 'node:path';
import AjvModule from 'ajv';
import {
  loadSlidePatternPack,
  resetSlidePatternPackCache,
  selectSlidePattern,
  buildSlidePatternDiagnostics,
  validateSlidePatternContent,
} from './presentation-slide-pattern.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import { afterEach, describe, expect, it } from 'vitest';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('presentation slide pattern pack', () => {
  afterEach(() => {
    resetSlidePatternPackCache();
  });

  it('validates the governed catalog and canonical example', () => {
    const root = process.cwd();
    const ajv = new Ajv({ allErrors: true });
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/slide-pattern-pack.schema.json')
    );
    const catalog = JSON.parse(
      safeReadFile(
        path.resolve(root, 'knowledge/public/design-patterns/presentation/slide-pattern-pack.json'),
        { encoding: 'utf8' }
      ) as string
    );
    const example = JSON.parse(
      safeReadFile(
        path.resolve(root, 'knowledge/product/schemas/slide-pattern-pack.example.json'),
        { encoding: 'utf8' }
      ) as string
    );

    expect(validate(catalog)).toBe(true);
    expect(validate(example)).toBe(true);
  });

  it('selects a pattern by explicit policy before scoring', () => {
    const selection = selectSlidePattern({
      deckPurpose: 'proposal',
      semanticType: 'problem',
      slideType: 'content',
      layoutKey: 'title-body',
      policy: {
        pack_id: 'slide-md-core',
        default_pattern_id: 'key-message-single',
        rules: [{ semantic_type: 'problem', pattern_id: 'problem-solution' }],
      },
    });

    expect(selection).toEqual(
      expect.objectContaining({
        pattern_id: 'problem-solution',
        layout_key: 'two-column-story',
        body_zone: 'two-column-callout',
        source: expect.objectContaining({ reason: 'policy-rule' }),
      })
    );
  });

  it('prefers specialized layouts over generic title-body layouts when scores tie', () => {
    const pack = {
      kind: 'slide-pattern-pack',
      version: 'test',
      pack_id: 'test-pack',
      source: { name: 'test' },
      patterns: [
        {
          pattern_id: 'generic-summary',
          category: 'summary',
          summary: 'Generic summary',
          suitable_scenes: ['summary'],
          slide_types: ['summary'],
          semantic_types: ['summary'],
          structure: { layout: 'generic-summary' },
          element_slots: [{ slot_id: 'message', role: 'Message', required: true }],
          renderer_hints: { layout_key: 'title-body', body_zone: 'single-column' },
        },
        {
          pattern_id: 'structured-summary',
          category: 'summary',
          summary: 'Structured summary',
          suitable_scenes: ['summary'],
          slide_types: ['summary'],
          semantic_types: ['summary'],
          structure: { layout: 'structured-summary' },
          element_slots: [{ slot_id: 'message', role: 'Message', required: true }],
          renderer_hints: { layout_key: 'decision-cta', body_zone: 'decision-cta' },
        },
      ],
    } as any;

    const selection = selectSlidePattern({
      semanticType: 'summary',
      slideType: 'summary',
      layoutKey: 'title-body',
      pack,
    });

    expect(selection?.pattern_id).toBe('structured-summary');
  });

  it('warns when content does not satisfy pattern constraints', () => {
    const pack = loadSlidePatternPack();
    const pattern = pack.patterns.find((entry) => entry.pattern_id === 'problem-solution');
    expect(pattern).toBeTruthy();
    const selection = selectSlidePattern({
      semanticType: 'problem',
      pack: { ...pack, patterns: [pattern!] },
    });
    expect(selection).toBeTruthy();

    const warnings = validateSlidePatternContent(selection!, {
      title: 'Current state',
      problem_items: ['Long onboarding', 'Fragmented support'],
      solution_items: ['Guided journey'],
    });
    expect(warnings).toEqual(
      expect.arrayContaining(['Problems and solutions must align by item number.'])
    );
  });

  it('builds short visual diagnostics for generic layouts and mixed story families', () => {
    const diagnostics = buildSlidePatternDiagnostics([
      {
        id: 'why-change',
        title: 'Why the current onboarding flow leaves too much room for avoidable drop-off',
        layout_key: 'title-body',
        pattern_id: 'problem-solution',
        slide_pattern: {
          pattern_id: 'problem-solution',
          category: 'comparison',
          layout_key: 'two-column-story',
          body_zone: 'two-column-callout',
          constraints: [{ kind: 'paired_item_counts_match', slots: ['problem_items', 'solution_items'], message: 'Problems and solutions must align by item number.' }],
          element_slots: [
            { slot_id: 'problem_items', role: 'Problems', required: true, min_items: 2 },
            { slot_id: 'solution_items', role: 'Solutions', required: true, min_items: 2 },
          ],
        },
        body: ['Current onboarding', 'Fewer drops'],
        objective: 'Show the problem',
      },
      {
        id: 'delivery-plan',
        title: 'Delivery plan',
        layout_key: 'timeline-roadmap',
        pattern_id: 'milestone-timeline',
        slide_pattern: {
          pattern_id: 'milestone-timeline',
          category: 'flow',
          layout_key: 'timeline-roadmap',
          body_zone: 'timeline',
          constraints: [],
          element_slots: [{ slot_id: 'milestones', role: 'Milestones', required: true, min_items: 3 }],
        },
        body: ['Discovery', 'Pilot', 'Rollout'],
        objective: 'Show the roadmap',
      },
    ]);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'generic-layouts' }),
        expect.objectContaining({ code: 'headline-too-long', slide_id: 'why-change' }),
        expect.objectContaining({ code: 'mixed-story-families' }),
      ]),
    );
  });
});
