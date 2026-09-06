import { describe, expect, it } from 'vitest';
import { readChronosOptionalStringParam, readChronosStringParam } from './request-input';

describe('Chronos request input', () => {
  it('accepts only trimmed strings at the framework boundary', () => {
    expect(readChronosStringParam('  path/to/file.md  ')).toBe('path/to/file.md');
    expect(readChronosStringParam('   ')).toBe('');
    expect(readChronosStringParam(undefined)).toBe('');
    expect(readChronosStringParam(null)).toBe('');
    expect(readChronosStringParam(['path/to/file.md'])).toBe('');
    expect(readChronosStringParam({ value: 'path/to/file.md' })).toBe('');
  });

  it('maps empty values to an absent optional parameter', () => {
    expect(readChronosOptionalStringParam('  tenant-a  ')).toBe('tenant-a');
    expect(readChronosOptionalStringParam('')).toBeUndefined();
    expect(readChronosOptionalStringParam(['tenant-a'])).toBeUndefined();
  });
});
