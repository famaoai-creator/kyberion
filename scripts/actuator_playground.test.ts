import { describe, expect, it } from 'vitest';
import { buildPlaygroundPayload, parsePlaygroundParams } from './actuator_playground.js';

describe('actuator playground JSON input boundary', () => {
  it('builds the canonical actuator payload for machine execution', () => {
    expect(buildPlaygroundPayload('send', { channel: 'slack', text: 'hello' })).toEqual({
      action: 'send',
      op: 'send',
      params: { channel: 'slack', text: 'hello' },
    });
  });

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
