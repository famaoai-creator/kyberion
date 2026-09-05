import { describe, expect, it } from 'vitest';

import { parseAutomationBlueprintValues } from './automation_blueprint.js';

describe('automation blueprint values parser', () => {
  it('accepts an object of slot values', () => {
    expect(parseAutomationBlueprintValues({ timezone: 'Asia/Tokyo' })).toEqual({
      timezone: 'Asia/Tokyo',
    });
  });

  it.each([null, [], 'values', 42])('rejects non-object values: %j', (value) => {
    expect(() => parseAutomationBlueprintValues(value)).toThrow(
      '--values-json must be a JSON object'
    );
  });

  it('rejects nested dangerous keys before blueprint resolution', () => {
    expect(() =>
      parseAutomationBlueprintValues({ filters: { constructor: { polluted: true } } })
    ).toThrow('--values-json contains a dangerous JSON key');
  });
});
