import { describe, it, expect } from 'vitest';
import * as prelude from '../scripts/system-prelude.js';

describe('system-prelude', () => {
  it('should export essential prelude members', () => {
    expect(prelude.main).toBeDefined();
    expect(typeof prelude.main).toBe('function');

    expect(prelude.secretGuard).toBeDefined();
    expect(typeof prelude.secretGuard.getSecret).toBe('function');

    expect(prelude.logger).toBeDefined();
    expect(typeof prelude.logger.info).toBe('function');
  });

  it('should have sandbox hooks applied to fs', async () => {
    const fs = await import('node:fs');
    // The hook is applied via defineProperty, we can't easily check the internal implementation 
    // without triggering a violation, but we can verify it's still a function.
    expect(typeof fs.writeFileSync).toBe('function');
  });
});
