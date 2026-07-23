import { describe, expect, it } from 'vitest';
import {
  getOpInputContract,
  listOpInputContracts,
  resolveOpAccessClaims,
  validateOpInput,
} from './op-input-contracts.js';

describe('op-input-contracts', () => {
  it('exposes browser and system input contracts', () => {
    expect(getOpInputContract('browser', 'click')).toEqual(
      expect.objectContaining({
        summary: expect.stringContaining('Click'),
        examples: expect.arrayContaining([
          expect.objectContaining({ selector: expect.any(String) }),
        ]),
      })
    );
    expect(getOpInputContract('system', 'write_file')).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({ type: 'object' }),
      })
    );
    expect(getOpInputContract('system', 'read_json')).toEqual(
      expect.objectContaining({
        examples: expect.arrayContaining([
          expect.objectContaining({ path: 'knowledge/product/config.json' }),
        ]),
      })
    );
    expect(getOpInputContract('system', 'notify')).toEqual(
      expect.objectContaining({
        examples: expect.arrayContaining([
          expect.objectContaining({ title: 'Kyberion', message: 'Build finished' }),
        ]),
      })
    );
    expect(getOpInputContract('system', 'process_kill')).toEqual(
      expect.objectContaining({
        examples: expect.arrayContaining([expect.objectContaining({ pid: 1234 })]),
      })
    );
    expect(listOpInputContracts('file').write_artifact).toEqual(
      expect.objectContaining({
        examples: expect.arrayContaining([
          expect.objectContaining({ output_path: expect.any(String) }),
        ]),
      })
    );
  });

  it('rejects browser input missing selector or ref', () => {
    const result = validateOpInput('browser', 'click', { text: 'ignored' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(' ')).toMatch(/selector|ref/);
    }
  });

  it('rejects file writes without a path', () => {
    const result = validateOpInput('file', 'write', { content: 'hello' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(' ')).toMatch(/path/);
    }
  });

  describe('resolveOpAccessClaims (KD-07)', () => {
    it('resolves a declared read-only op to a file read claim from its path param', () => {
      expect(
        resolveOpAccessClaims('file', 'read_file', { path: 'knowledge/product/README.md' })
      ).toEqual([
        {
          kind: 'file',
          operation: 'read',
          path: 'knowledge/product/README.md',
          recursive: undefined,
        },
      ]);
      expect(resolveOpAccessClaims('system', 'read_json', { path: 'a/b.json' })).toEqual([
        { kind: 'file', operation: 'read', path: 'a/b.json', recursive: undefined },
      ]);
    });

    it('marks recursive search claims as covering the subtree', () => {
      expect(
        resolveOpAccessClaims('file', 'search', { path: 'knowledge/product', pattern: 'AR-03' })
      ).toEqual([{ kind: 'file', operation: 'read', path: 'knowledge/product', recursive: true }]);
    });

    it('is conservative ({kind:"all"}) for an op with no accesses declaration', () => {
      expect(resolveOpAccessClaims('system', 'shell', { command: 'ls' })).toEqual([
        { kind: 'all' },
      ]);
      expect(resolveOpAccessClaims('file', 'write', { path: 'a.txt' })).toEqual([{ kind: 'all' }]);
    });

    it('is conservative when a declared path param is missing or not a string', () => {
      expect(resolveOpAccessClaims('file', 'read', {})).toEqual([{ kind: 'all' }]);
      expect(resolveOpAccessClaims('file', 'read', { path: 123 })).toEqual([{ kind: 'all' }]);
    });
  });
});
