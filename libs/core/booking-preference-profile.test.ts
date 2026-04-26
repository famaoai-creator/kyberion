import * as path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, safeReadFile } from '@agent/core';
import { describe, expect, it } from 'vitest';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('booking-preference-profile schema', () => {
  it('accepts the canonical example', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/booking-preference-profile.schema.json'));
    const example = JSON.parse(
      safeReadFile(path.resolve(root, 'knowledge/public/schemas/booking-preference-profile.example.json'), {
        encoding: 'utf8',
      }) as string,
    );

    expect(validate(example)).toBe(true);
  });

  it('rejects payloads without the required security boundary', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/booking-preference-profile.schema.json'));

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
});
