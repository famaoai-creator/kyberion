import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { registerLockIo, type LockIo } from '../foundation/lock-utils.js';

const transcripts = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../authority.js', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('../workforce/artifact-store.js', () => ({
  readGovernedArtifactJson: (file: string) => structuredClone(transcripts.get(file) ?? null),
  writeGovernedArtifactJson: (_role: string, file: string, value: unknown) =>
    transcripts.set(file, structuredClone(value)),
}));
import {
  conversationRef,
  reserveConversationTurn,
  completeConversationTurn,
  markConversationTurnUncertain,
  readConversationHistory,
} from './front-desk-conversation-store.js';

const viewer = {
  principalId: 'human:alice',
  role: 'localadmin',
  source: 'token',
  tenantSlugs: ['tenant-a'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public'],
} as const;
const requestId = '00000000-0000-4000-8000-000000000001';
const deadPid = 2147483647;
let files: Map<string, string>;
let previous: LockIo | undefined;
let onPublish: ((file: string) => void) | undefined;
let now: number;
const error = (code: string) => Object.assign(new Error(code), { code });
const lockFile = () =>
  path.join(
    pathResolver.rootDir(),
    'active/shared/runtime/locks',
    'concierge-history-' +
      conversationRef({
        ...viewer,
        tenantSlugs: [...viewer.tenantSlugs],
        organizationIds: [...viewer.organizationIds],
        projectIds: [...viewer.projectIds],
        tierAccess: [...viewer.tierAccess],
      }).key +
      '.lock'
  );
const owner = () => ({
  ...viewer,
  tenantSlugs: [...viewer.tenantSlugs],
  organizationIds: [...viewer.organizationIds],
  projectIds: [...viewer.projectIds],
  tierAccess: [...viewer.tierAccess],
});
beforeEach(() => {
  files = new Map();
  transcripts.clear();
  onPublish = undefined;
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(Atomics, 'wait').mockImplementation(() => {
    now += 5_000;
    return 'timed-out';
  });
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === deadPid) throw error('ESRCH');
    return true;
  });
  const publish = (file: string, text: string) => {
    if (files.has(file)) throw error('EEXIST');
    files.set(file, text);
    onPublish?.(file);
  };
  previous = registerLockIo({
    exists: (file) => files.has(file) || file.endsWith('/locks'),
    mkdir: () => {},
    createExclusive: publish,
    publishExclusive: publish,
    unlink: (file) => {
      files.delete(file);
    },
    loadJson: <T,>(file: string): T => {
      if (!files.has(file)) throw error('ENOENT');
      return JSON.parse(files.get(file)!) as T;
    },
    rename: (from, to) => {
      if (!files.has(from)) throw error('ENOENT');
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    linkExclusive: (from, to) => {
      if (files.has(to)) throw error('EEXIST');
      if (!files.has(from)) throw error('ENOENT');
      files.set(to, files.get(from)!);
    },
  });
});
afterEach(() => {
  registerLockIo(previous);
  vi.restoreAllMocks();
});

describe('conversation reservations with the real shared lock primitive', () => {
  it('blocks an overlapping same-ID reservation, then replays the one persisted turn', () => {
    let nested = false;
    onPublish = (file) => {
      if (file !== lockFile() || nested) return;
      nested = true;
      expect(() => reserveConversationTurn(owner(), 'request', requestId)).toThrow('LOCK_TIMEOUT');
    };
    expect(reserveConversationTurn(owner(), 'request', requestId)).toMatchObject({ created: true });
    onPublish = undefined;
    expect(reserveConversationTurn(owner(), 'request', requestId)).toMatchObject({
      created: false,
      reply: undefined,
    });
    completeConversationTurn(owner(), requestId, 'completed');
    expect(reserveConversationTurn(owner(), 'request', requestId)).toMatchObject({
      created: false,
      reply: 'completed',
    });
    expect(readConversationHistory(owner()).messages).toHaveLength(2);
    expect(files.size).toBe(0);
  });
  it('recovers a dead main owner without losing an uncertain durable receipt', () => {
    reserveConversationTurn(owner(), 'request', requestId);
    markConversationTurnUncertain(owner(), requestId);
    files.set(lockFile(), JSON.stringify({ pid: deadPid }));
    expect(reserveConversationTurn(owner(), 'request', requestId)).toMatchObject({
      created: false,
      uncertain: true,
    });
    expect(files.size).toBe(0);
    expect(readConversationHistory(owner()).pending).toBe(1);
  });
  it('retains the pending receipt through exceptional guard recovery, never reserving duplicate work', () => {
    reserveConversationTurn(owner(), 'request', requestId);
    const before = structuredClone([...transcripts]);
    files.set(lockFile(), JSON.stringify({ pid: deadPid }));
    files.set(lockFile() + '.reclaim', JSON.stringify({ pid: deadPid }));
    expect(() => reserveConversationTurn(owner(), 'request', requestId)).toThrow(
      /LOCK_TIMEOUT.*never reclaimed automatically/
    );
    expect([...transcripts]).toEqual(before);
    expect(files.has(lockFile() + '.reclaim')).toBe(true);
    // Model completed operator recovery while this test's only contender is stopped.
    files.delete(lockFile() + '.reclaim');
    expect(reserveConversationTurn(owner(), 'request', requestId)).toMatchObject({
      created: false,
      reply: undefined,
    });
    expect(readConversationHistory(owner()).messages).toHaveLength(1);
    expect(files.size).toBe(0);
  });
});
