import { describe, expect, it } from 'vitest';
import {
  parseWorkCoordinationJson,
  resolveWorkCoordinationInputPath,
} from './work_coordination.js';

describe('work coordination resource boundary', () => {
  it('rejects repository-external issue input', () => {
    expect(() => resolveWorkCoordinationInputPath('/tmp/issue.json')).toThrow(
      /RESOURCE_PATH_SCOPE/u
    );
  });

  it('accepts JSON objects and rejects non-object or dangerous input', () => {
    expect(parseWorkCoordinationJson('{"tenant_slug":"acme"}')).toEqual({
      tenant_slug: 'acme',
    });
    expect(() => parseWorkCoordinationJson('[]')).toThrow('safe JSON object');
    expect(() => parseWorkCoordinationJson('{"constructor":{"polluted":true}}')).toThrow(
      'safe JSON object'
    );
    expect(() => parseWorkCoordinationJson('{"nested":{"__proto__":true}}')).toThrow(
      'safe JSON object'
    );
  });
});
