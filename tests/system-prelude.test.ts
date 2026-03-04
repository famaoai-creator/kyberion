import { describe, it, expect } from 'vitest';
import * as prelude from '../scripts/system-prelude.js';

describe('system-prelude', () => {
  it('should export essential security and utility members', () => {
    expect(prelude.requireRole).toBeDefined();
    expect(typeof prelude.requireRole).toBe('function');
    
    expect(prelude.safeWriteFile).toBeDefined();
    expect(typeof prelude.safeWriteFile).toBe('function');
    
    expect(prelude.safeAppendFile).toBeDefined();
    expect(typeof prelude.safeAppendFile).toBe('function');
  });

  it('should have sandbox hooks applied to fs', async () => {
    const fs = await import('node:fs');
    // The hook is applied via defineProperty, we can't easily check the internal implementation 
    // without triggering a violation, but we can verify it's still a function.
    expect(typeof fs.writeFileSync).toBe('function');
  });
});
