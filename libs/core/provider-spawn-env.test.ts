import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionIndexMocks = vi.hoisted(() => ({
  prepareSessionGitIndex: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('./session-git-index.js', () => ({
  prepareSessionGitIndex: sessionIndexMocks.prepareSessionGitIndex,
}));

import {
  buildDelegationSpawnEnv,
  disposeOnChildExit,
  isSessionGitIndexEnabled,
  newDelegationSessionId,
} from './provider-spawn-env.js';

const fakeBaseEnv = (): NodeJS.ProcessEnv =>
  ({
    PATH: '/usr/bin:/bin',
    HOME: '/home/test',
    ANTHROPIC_API_KEY: 'fake-anthropic-key',
    OPENAI_API_KEY: 'fake-openai-key',
    GH_TOKEN: 'fake-gh-token',
    GIT_INDEX_FILE: '/inherited/index',
    KYBERION_DELEGATION_DEPTH: '0',
    KYBERION_SESSION_GIT_INDEX: '1',
  }) as NodeJS.ProcessEnv;

beforeEach(() => {
  sessionIndexMocks.prepareSessionGitIndex.mockReset();
  sessionIndexMocks.dispose.mockReset();
  sessionIndexMocks.prepareSessionGitIndex.mockImplementation(({ sessionId }) => ({
    sessionId,
    env: { GIT_INDEX_FILE: `/private/index/${sessionId}` },
    dispose: sessionIndexMocks.dispose,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildDelegationSpawnEnv', () => {
  it('injects a private GIT_INDEX_FILE for implementer delegations only', () => {
    const spawnEnv = buildDelegationSpawnEnv({
      provider: 'claude',
      sessionId: 's1',
      cwd: '/repo',
      profile: 'implementer',
      baseEnv: fakeBaseEnv(),
    });
    expect(spawnEnv.env.GIT_INDEX_FILE).toBe('/private/index/s1');
    expect(sessionIndexMocks.prepareSessionGitIndex).toHaveBeenCalledWith({
      sessionId: 's1',
      cwd: '/repo',
    });
    spawnEnv.dispose();
    expect(sessionIndexMocks.dispose).toHaveBeenCalledTimes(1);

    for (const profile of ['explorer', 'planner', undefined] as const) {
      const other = buildDelegationSpawnEnv({
        provider: 'claude',
        sessionId: 's2',
        ...(profile ? { profile } : {}),
        baseEnv: fakeBaseEnv(),
      });
      expect(other.env.GIT_INDEX_FILE).toBeUndefined();
    }
    expect(sessionIndexMocks.prepareSessionGitIndex).toHaveBeenCalledTimes(1);
  });

  it('KYBERION_SESSION_GIT_INDEX=0 disables the private index', () => {
    const spawnEnv = buildDelegationSpawnEnv({
      provider: 'codex',
      sessionId: 's1',
      profile: 'implementer',
      baseEnv: { ...fakeBaseEnv(), KYBERION_SESSION_GIT_INDEX: '0' },
    });
    expect(spawnEnv.env.GIT_INDEX_FILE).toBeUndefined();
    expect(sessionIndexMocks.prepareSessionGitIndex).not.toHaveBeenCalled();
  });

  it('is on by default outside Vitest and off by default inside it', () => {
    const { KYBERION_SESSION_GIT_INDEX: _unset, ...defaults } = fakeBaseEnv();
    expect(isSessionGitIndexEnabled(defaults)).toBe(false);
    vi.stubEnv('VITEST', '');
    expect(isSessionGitIndexEnabled(defaults)).toBe(true);
    expect(isSessionGitIndexEnabled({ ...defaults, KYBERION_SESSION_GIT_INDEX: '0' })).toBe(false);
  });

  it('shares the real index when no private index could be prepared', () => {
    sessionIndexMocks.prepareSessionGitIndex.mockReturnValue(null);
    const spawnEnv = buildDelegationSpawnEnv({
      provider: 'claude',
      sessionId: 's1',
      profile: 'implementer',
      baseEnv: fakeBaseEnv(),
    });
    expect(spawnEnv.env.GIT_INDEX_FILE).toBeUndefined();
    expect(() => spawnEnv.dispose()).not.toThrow();
  });

  it('preserves XP-02 credential stripping and adds the delegation depth', () => {
    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '2');
    const spawnEnv = buildDelegationSpawnEnv({
      provider: 'claude',
      sessionId: 's1',
      profile: 'implementer',
      baseEnv: fakeBaseEnv(),
    });
    expect(spawnEnv.env.ANTHROPIC_API_KEY).toBe('fake-anthropic-key');
    expect(spawnEnv.env.OPENAI_API_KEY).toBeUndefined();
    expect(spawnEnv.env.GH_TOKEN).toBeUndefined();
    expect(spawnEnv.env.PATH).toBe('/usr/bin:/bin');
    expect(spawnEnv.env.KYBERION_DELEGATION_DEPTH).toBe('3');
  });

  it('never forwards an inherited GIT_INDEX_FILE to non-implementer delegations', () => {
    const spawnEnv = buildDelegationSpawnEnv({
      provider: 'claude',
      sessionId: 's1',
      profile: 'explorer',
      baseEnv: fakeBaseEnv(),
    });
    expect(spawnEnv.env.GIT_INDEX_FILE).toBeUndefined();
  });
});

describe('disposeOnChildExit', () => {
  it('disposes on close and on error (dispose itself is idempotent)', () => {
    const dispose = vi.fn();
    const child = new EventEmitter();
    disposeOnChildExit(child, { env: {}, dispose });
    child.emit('error', new Error('spawn failed'));
    child.emit('close', 1);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('mints provider-prefixed session ids', () => {
    expect(newDelegationSessionId('grok')).toMatch(/^grok-[0-9a-f-]{36}$/);
  });
});
