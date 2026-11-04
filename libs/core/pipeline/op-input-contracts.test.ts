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

  it('accepts browser content capture without a selector (full page)', () => {
    expect(validateOpInput('browser', 'content', { export_as: 'page_html' })).toEqual({
      valid: true,
    });
    expect(
      validateOpInput('browser', 'content', {
        selector: 'main',
        export_as: 'main_text',
      })
    ).toEqual({ valid: true });
  });

  it('rejects file writes without a path', () => {
    const result = validateOpInput('file', 'write', { content: 'hello' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(' ')).toMatch(/path/);
    }
  });

  it('accepts governed pipeline metadata without reopening the operation envelope', () => {
    expect(
      validateOpInput('system', 'probe_active_profile', {
        path: 'my-identity.json',
        _facets: { audience: 'operator' },
        _reasoning_policy: { mode: 'deterministic' },
        _step_id: 'probe-profile',
      })
    ).toEqual({ valid: true });
  });

  describe('typed system contracts', () => {
    it('accepts the audited shell params and rejects the legacy `command` key', () => {
      expect(
        validateOpInput('system', 'shell', {
          cmd: 'pnpm build',
          env: { FOO: 'bar' },
          retry: { maxRetries: 2 },
          timeout_ms: 30_000,
          export_as: 'out',
        })
      ).toEqual({ valid: true });
      const result = validateOpInput('system', 'shell', { command: 'pnpm build' });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.errors.join(' ')).toMatch(/cmd|additional/);
    });

    it('accepts the full exec param space and rejects unknown keys', () => {
      expect(
        validateOpInput('system', 'exec', {
          command: 'pnpm',
          args: ['build'],
          env: {},
          cwd: 'libs',
          timeout_ms: 5000,
          input: 'y\n',
          allow_error: true,
          retry: {},
          export_as: 'result',
        })
      ).toEqual({ valid: true });
      const result = validateOpInput('system', 'exec', { command: 'ls', typo: true });
      expect(result.valid).toBe(false);
    });

    it('accepts file-io ops with their delegated param space', () => {
      expect(
        validateOpInput('system', 'write_file', {
          path: 'active/shared/tmp/a.txt',
          content: 'hi',
          format: 'text',
          export_as: 'wrote',
        })
      ).toEqual({ valid: true });
      expect(
        validateOpInput('system', 'write_artifact', {
          output_path: 'active/shared/tmp/b.txt',
          from: 'last_capture',
        })
      ).toEqual({ valid: true });
      expect(
        validateOpInput('system', 'read_file', {
          path: 'a.txt',
          format: 'text',
          export_as: 'content',
        })
      ).toEqual({ valid: true });
    });

    it('accepts `ms` or `duration_ms` for wait and rejects other keys', () => {
      expect(validateOpInput('system', 'wait', { ms: 1000 })).toEqual({ valid: true });
      expect(validateOpInput('system', 'wait', { duration_ms: 1000 })).toEqual({ valid: true });
      expect(validateOpInput('system', 'wait', { seconds: 1 }).valid).toBe(false);
    });

    it('still accepts governed metadata alongside strict system params', () => {
      expect(
        validateOpInput('system', 'read_json', {
          path: 'a/b.json',
          _step_id: 'read-step',
          _facets: {},
        })
      ).toEqual({ valid: true });
    });
  });

  describe('typed file contracts', () => {
    it('rejects unknown keys on strict file ops', () => {
      const result = validateOpInput('file', 'read', { path: 'a.txt', typo: true });
      expect(result.valid).toBe(false);
    });

    it('accepts audited capture/export params', () => {
      expect(
        validateOpInput('file', 'tail', { path: 'a.log', pos_key: 'p', export_as: 'tail' })
      ).toEqual({ valid: true });
      expect(
        validateOpInput('file', 'search', { path: 'src', pattern: 'x', export_as: 'hits' })
      ).toEqual({ valid: true });
    });

    it('accepts either path or output_path on write_file/write_artifact', () => {
      expect(validateOpInput('file', 'write_file', { output_path: 'o.txt' })).toEqual({
        valid: true,
      });
      expect(validateOpInput('file', 'write_artifact', { path: 'o.txt', data: {} })).toEqual({
        valid: true,
      });
      expect(validateOpInput('file', 'write_file', {})).toEqual(
        expect.objectContaining({ valid: false })
      );
    });

    it('accepts audited append params and rejects the write_file append flag', () => {
      expect(
        validateOpInput('file', 'append', { path: 'a.txt', content: 'x', newline: false })
      ).toEqual({ valid: true });
      const result = validateOpInput('file', 'write_file', { path: 'a.txt', append: true });
      expect(result.valid).toBe(false);
    });
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
