import { describe, expect, it } from 'vitest';
import { parseServicePidRegistry } from './service-pid-registry.js';

describe('service pid registry parser', () => {
  it('accepts a finite positive pid registry', () => {
    expect(parseServicePidRegistry({ slack: 1234, github: 5678 })).toEqual({
      slack: 1234,
      github: 5678,
    });
  });

  it('rejects malformed persisted process state', () => {
    expect(parseServicePidRegistry(null)).toBeNull();
    expect(parseServicePidRegistry([])).toBeNull();
    expect(parseServicePidRegistry({ slack: 0 })).toBeNull();
    expect(parseServicePidRegistry({ slack: 1.5 })).toBeNull();
    expect(parseServicePidRegistry({ slack: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(parseServicePidRegistry({ 'bad service': 1234 })).toBeNull();
    expect(parseServicePidRegistry({ slack: 1234, github: '5678' })).toBeNull();
    expect(parseServicePidRegistry(JSON.parse('{"__proto__":{"polluted":true}}'))).toBeNull();
  });
});
