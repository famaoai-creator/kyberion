import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { 
  rootDir, 
  skillDir, 
  resolve 
} from './path-resolver.js';

describe('path-resolver core', () => {
  it('should find the project root', () => {
    const root = rootDir();
    expect(root).toBeDefined();
    expect(root.endsWith('kyberion')).toBe(true); 
    expect(path.isAbsolute(root)).toBe(true);
  });

  it('should resolve skill directory via index or default path', () => {
    const dir = skillDir('security-scanner');
    expect(dir).toContain('security-scanner');
    expect(path.isAbsolute(dir)).toBe(true);
  });

  it('should resolve logical skill:// protocol', () => {
    const logical = 'skill://security-scanner/src/index.ts';
    const physical = resolve(logical);
    expect(physical).toContain('security-scanner');
    expect(physical.endsWith('src/index.ts')).toBe(true);
    expect(path.isAbsolute(physical)).toBe(true);
  });

  it('should handle absolute paths correctly', () => {
    const abs = '/tmp/test-path-resolver';
    expect(resolve(abs)).toBe(abs);
  });

  it('should resolve relative paths against project root', () => {
    const rel = 'knowledge/README.md';
    const physical = resolve(rel);
    expect(physical).toBe(path.join(rootDir(), rel));
  });
});
