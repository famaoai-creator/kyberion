import { describe, it, expect } from 'vitest';
import { 
  rootDir, 
  knowledge, 
  active, 
  scripts, 
  shared, 
  resolve 
} from '../libs/core/path-resolver.js';

describe('system path-resolver', () => {
  it('should resolve semantic paths correctly', () => {
    expect(rootDir().length).toBeGreaterThan(0);
    
    expect(knowledge('incidents').endsWith('knowledge/incidents')).toBe(true);
    expect(active('missions').endsWith('active/missions')).toBe(true);
    expect(scripts().endsWith('scripts')).toBe(true);
    expect(shared('test.json').endsWith('active/shared/test.json')).toBe(true);
  });

  it('should handle logical resolution for active shared paths', () => {
    const res = resolve('active/shared/config.json');
    expect(res).toContain('active/shared/config.json');
  });
});
