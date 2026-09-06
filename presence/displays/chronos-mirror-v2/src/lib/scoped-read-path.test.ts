import { describe, expect, it } from 'vitest';
import { normalizeScopedReadPath } from './scoped-read-path';

describe('normalizeScopedReadPath', () => {
  it('keeps a canonical repository-relative path unchanged', () => {
    expect(normalizeScopedReadPath('knowledge/public/runbook.md')).toBe(
      'knowledge/public/runbook.md'
    );
  });

  it('rejects dot-segment traversal and absolute path forms', () => {
    for (const value of [
      'knowledge/public/../confidential/secret.md',
      'knowledge\\public\\..\\confidential\\secret.md',
      '/knowledge/public/runbook.md',
      'C:/knowledge/public/runbook.md',
    ]) {
      expect(normalizeScopedReadPath(value), value).toBeNull();
    }
  });
});
