import * as path from 'node:path';
import AjvModule from 'ajv';
import {
  loadSlidePatternPack,
  resetSlidePatternPackCache,
  selectSlidePattern,
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
});
