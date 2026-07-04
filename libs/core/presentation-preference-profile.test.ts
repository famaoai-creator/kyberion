import * as path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import {
  compileSchemaFromPath,
  getPresentationBriefQuestions,
  getPresentationSlidePatternSelectionPolicy,
  getPresentationThemeHint,
  safeReadFile,
  selectPresentationBriefQuestionSet,
} from '@agent/core';
import { describe, expect, it, vi } from 'vitest';
import { logger } from './core.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('presentation-preference-profile schema', () => {
  it('accepts the canonical example', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/presentation-preference-profile.schema.json')
    );
    const example = JSON.parse(
      safeReadFile(
        path.resolve(
          root,
          'knowledge/product/schemas/presentation-preference-profile.example.json'
        ),
        {
          encoding: 'utf8',
        }
      ) as string
    );

    expect(validate(example)).toBe(true);
  });

  it('selects brief questions and theme hints by deck purpose', () => {
    const root = process.cwd();
    const profile = JSON.parse(
      safeReadFile(
        path.resolve(
          root,
          'knowledge/product/schemas/presentation-preference-profile.example.json'
        ),
        {
          encoding: 'utf8',
        }
      ) as string
    );

    expect(selectPresentationBriefQuestionSet(profile, 'proposal')?.label).toBe('Proposal deck');
    expect(getPresentationBriefQuestions(profile, 'marketing').questions).toEqual([
      '営業資料ですか、告知資料ですか?',
      'ブランド準拠の強さはどの程度必要ですか?',
    ]);
    expect(getPresentationThemeHint(profile, 'internal_share')).toBe('internal_practical');
    expect(getPresentationThemeHint(profile, 'training')).toBe('training_structured');
    expect(getPresentationSlidePatternSelectionPolicy(profile)).toEqual(
      expect.objectContaining({
        pack_id: 'slide-md-core',
        default_pattern_id: 'key-message-single',
      })
    );
  });

  it('logs how many brief questions were omitted when limiting the preview', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const profile = {
      brief_question_sets: [
        {
          label: 'Test deck',
          questions: ['Q1', 'Q2', 'Q3'],
        },
      ],
      theme_sets: [],
      theme_selection_policy: {},
    } as any;

    expect(getPresentationBriefQuestions(profile, 'proposal', 2)).toEqual({
      questions: ['Q1', 'Q2'],
      omitted_count: 1,
    });
    expect(infoSpy).toHaveBeenCalledWith(
      '[presentation-preference-profile] omitted 1 brief question(s) for deckPurpose=proposal'
    );
    infoSpy.mockRestore();
  });
});
