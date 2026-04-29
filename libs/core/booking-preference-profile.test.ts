import * as path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import {
  compileSchemaFromPath,
  getBookingPreflightQuestions,
  safeReadFile,
  selectBookingPreflightQuestionSet,
} from '@agent/core';
import { describe, expect, it } from 'vitest';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('booking-preference-profile schema', () => {
  it('accepts the canonical example', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/public/schemas/booking-preference-profile.schema.json')
    );
    const example = JSON.parse(
      safeReadFile(
        path.resolve(root, 'knowledge/public/schemas/booking-preference-profile.example.json'),
        {
          encoding: 'utf8',
        }
      ) as string
    );

    expect(validate(example)).toBe(true);
  });

  it('rejects payloads without the required security boundary', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/public/schemas/booking-preference-profile.schema.json')
    );

    const invalid = {
      kind: 'booking-preference-profile',
      profile_id: 'travel-points-routing-example',
      preferred_booking_sites: [],
      payment_policy: {
        prefer: ['free_cancellation'],
        allow_prepaid: true,
        require_confirmation_if: ['payment_execution'],
      },
    };

    expect(validate(invalid)).toBe(false);
  });

  it('selects category-specific preflight questions from the profile', () => {
    const root = process.cwd();
    const profile = JSON.parse(
      safeReadFile(
        path.resolve(root, 'knowledge/public/schemas/booking-preference-profile.example.json'),
        {
          encoding: 'utf8',
        }
      ) as string
    );

    const hotelPack = selectBookingPreflightQuestionSet(profile, 'hotel');
    expect(hotelPack?.label).toBe('Travel booking preflight');
    expect(getBookingPreflightQuestions(profile, 'restaurant')).toEqual([
      '人数と希望時間はいつですか?',
      '苦手食材や個室の要否はありますか?',
      '価格重視か予約のしやすさ重視か、どちらですか?',
    ]);
    expect(getBookingPreflightQuestions(profile, 'family')).toEqual([
      '誰の予定を合わせますか?',
      '送迎や学校の締切はありますか?',
      '親の承認や持ち物の確認が必要ですか?',
    ]);
  });
});
