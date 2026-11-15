import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { rootDir, knowledge, active, scripts, shared, resolve } from '@agent/core/path-resolver';

describe('system path-resolver', () => {
  it('should resolve semantic paths correctly', () => {
    expect(rootDir().length).toBeGreaterThan(0);

    expect(
      knowledge('product/incidents').endsWith(path.join('knowledge', 'product', 'incidents'))
    ).toBe(true);
    expect(active('missions').endsWith(path.join('active', 'missions'))).toBe(true);
    expect(scripts().endsWith('scripts')).toBe(true);
    expect(shared('test.json').endsWith(path.join('active', 'shared', 'test.json'))).toBe(true);
  });

  it('should handle logical resolution for active shared paths', () => {
    const res = resolve('active/shared/config.json');
    expect(res).toContain(path.join('active', 'shared', 'config.json'));
  });
});
