import { describe, expect, it } from 'vitest';
import {
  assertValidCodexProfileName,
  codexProfileRoot,
  resolveCodexHome,
  resolveCodexProfileName,
} from './codex-profile.js';

describe('codex profiles', () => {
  it('resolves named profiles below the host home directory', () => {
    const env = { HOME: '/home/operator', KYBERION_CODEX_PROFILE: 'work' };
    expect(resolveCodexProfileName(env)).toBe('work');
    expect(resolveCodexHome(undefined, env)).toBe('/home/operator/.codex-profiles/work');
    expect(codexProfileRoot(env)).toBe('/home/operator/.codex-profiles');
  });
  it('preserves the default CODEX_HOME', () => {
    expect(resolveCodexHome(undefined, { HOME: '/home/operator' })).toBe('/home/operator/.codex');
    expect(
      resolveCodexHome(undefined, { HOME: '/home/operator', CODEX_HOME: '/runtime/codex-home' })
    ).toBe('/runtime/codex-home');
  });
  it('rejects unsafe profile names', () => {
    expect(() => resolveCodexHome('../escape', { HOME: '/home/operator' })).toThrow('profile name');
    expect(() => assertValidCodexProfileName('default')).toThrow('non-default');
  });
});
