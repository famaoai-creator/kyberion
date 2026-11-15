import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './export_audit.js';

describe('export_audit entrypoint', () => {
  it('keeps output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/audit/export_audit.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('context.print(');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.warn(');
  });

  it('emits the verify report with ok and finding fields', async () => {
    const report = (await main(['--verify-only'])) as Record<string, unknown>;
    expect(report).toHaveProperty('ok');
    expect(report).toHaveProperty('valid');
    expect(report).toHaveProperty('corrupted');
    expect(report).toHaveProperty('tenant_mirrors');
  });

  it('exports JSONL and rejects inverted date windows', async () => {
    await expect(main(['--from', '2026-01-02', '--to', '2026-01-01'])).rejects.toThrow(
      '--from must not be after --to'
    );
    await expect(main(['--from', '2026-13-99'])).rejects.toThrow(
      '--from must be a valid YYYY-MM-DD date'
    );
  });

  it('exports entries between --from and --to as one JSON object per line', async () => {
    const output = await main([]);
    expect(typeof output).toBe('string');
    for (const line of String(output).split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('currentHash');
    }
  });
});
