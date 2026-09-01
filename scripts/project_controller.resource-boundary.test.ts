import { describe, expect, it } from 'vitest';
import { parseProjectMetadata } from './project_controller.js';

describe('project controller resource boundaries', () => {
  it('accepts metadata objects and rejects unsafe or non-object JSON', () => {
    expect(parseProjectMetadata('{"owner":"ops"}')).toEqual({ owner: 'ops' });
    expect(() => parseProjectMetadata('[]')).toThrow('--metadata must be a JSON object');
    expect(() => parseProjectMetadata('{"__proto__":{"polluted":true}}')).toThrow(
      '--metadata contains a dangerous JSON key'
    );
  });
});
