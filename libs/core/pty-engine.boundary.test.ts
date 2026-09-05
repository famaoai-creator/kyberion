import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { parsePtyAdfPayload } from './pty-engine.js';
import { safeReadFile } from './secure-io.js';

describe('PTY ADF payload boundary', () => {
  it('routes the default shell through the governed environment accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/pty-engine.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('process.env.SHELL');
    expect(source).toContain("getRegisteredEnvText('SHELL')");
  });

  it('accepts a safe object payload', () => {
    expect(parsePtyAdfPayload('{"steps":[]}')).toEqual({ steps: [] });
  });

  it('rejects arrays and nested dangerous keys', () => {
    expect(parsePtyAdfPayload('[]')).toBeUndefined();
    expect(parsePtyAdfPayload('{"steps":[],"meta":{"__proto__":{}}}')).toBeUndefined();
  });
});
