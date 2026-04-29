import * as path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import {
  compileSchemaFromPath,
  getPresentationBriefQuestions,
  getPresentationThemeHint,
  safeReadFile,
  selectPresentationBriefQuestionSet,
} from '@agent/core';
import { describe, expect, it } from 'vitest';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('presentation-preference-profile schema', () => {
  it('accepts the canonical example', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/public/schemas/presentation-preference-profile.schema.json')
    );
    const example = JSON.parse(
      safeReadFile(
        path.resolve(root, 'knowledge/public/schemas/presentation-preference-profile.example.json'),
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
        path.resolve(root, 'knowledge/public/schemas/presentation-preference-profile.example.json'),
        {
          encoding: 'utf8',
        }
      ) as string
    );

    expect(selectPresentationBriefQuestionSet(profile, 'proposal')?.label).toBe('Proposal deck');
    expect(getPresentationBriefQuestions(profile, 'marketing')).toEqual([
      '営業資料ですか、告知資料ですか?',
      'ブランド準拠の強さはどの程度必要ですか?',
      '図解中心と写真中心のどちらが良いですか?',
    ]);
    expect(getPresentationThemeHint(profile, 'internal_share')).toBe('internal_practical');
    expect(getPresentationThemeHint(profile, 'training')).toBe('training_structured');
  });
});
