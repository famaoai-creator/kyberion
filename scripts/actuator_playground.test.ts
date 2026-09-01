import { describe, expect, it } from 'vitest';
import { parsePlaygroundParams } from './actuator_playground.js';

describe('actuator playground JSON input boundary', () => {
  it('accepts an object parameter payload without coercion', () => {
    expect(parsePlaygroundParams('{"count":2,"enabled":true}')).toEqual({
      count: 2,
      enabled: true,
    });
  });

  it.each(['[]', 'null', '"text"'])('rejects non-object parameters %s', (raw) => {
    expect(() => parsePlaygroundParams(raw)).toThrow('--params must be a JSON object');
  });

  it('rejects dangerous nested keys before actuator execution', () => {
    expect(() => parsePlaygroundParams('{"params":{"__proto__":{"polluted":true}}}')).toThrow(
      '--params contains a dangerous JSON key'
    );
  });
});
