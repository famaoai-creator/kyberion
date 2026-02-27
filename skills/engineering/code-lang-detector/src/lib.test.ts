import { describe, it, expect } from 'vitest';
import { detectLanguage } from './lib';

describe('detectLanguage', () => {
  it('should detect language by extension', () => {
    expect(detectLanguage('test.js', '').lang).toBe('javascript');
    expect(detectLanguage('test.py', '').lang).toBe('python');
    expect(detectLanguage('test.rs', '').lang).toBe('rust');
  });

  it('should detect language by content keywords', () => {
    const pyCode = 'def hello():\\n    print("world")';
    const jsCode = 'const x = 1;\\nconsole.log(x);';

    expect(detectLanguage('unknown.txt', pyCode).lang).toBe('python');
    expect(detectLanguage('unknown.txt', jsCode).lang).toBe('javascript');
  });

  it('should return unknown for ambiguous content', () => {
    expect(detectLanguage('file.txt', 'hello world').lang).toBe('unknown');
  });
});
