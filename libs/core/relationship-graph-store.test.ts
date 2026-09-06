import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('./path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./path-resolver.js')>('./path-resolver.js');
  return {
    ...actual,
    rootResolve: vi.fn(),
  };
});

vi.mock('./tier-guard.js', () => ({
  validateWritePermission: () => ({ allowed: true }),
  validateReadPermission: () => ({ allowed: true }),
  detectTier: () => 'confidential',
}));

vi.mock('./policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true, action: 'allow' }) },
}));

import { pathResolver, rootResolve } from './path-resolver.js';
import { safeMkdir, safeSymlinkSync, safeUnlinkSync, safeWriteFile } from './secure-io.js';
import {
  getTrustLevel,
  listNgTopics,
  readNode,
  recordInteraction,
  suggestFieldUpdate,
} from './relationship-graph-store.js';

describe('relationship-graph-store', () => {
  let tmpDir = '';
  const mockResolve = rootResolve as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = pathResolver.sharedTmp(`rel-graph-${process.pid}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    mockResolve.mockImplementation((rel: string) => path.join(tmpDir, rel));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('recordInteraction', () => {
    it('creates a new node with neutral trust when none exists', () => {
      const node = recordInteraction({
        personSlug: 'alice-example',
        org: 'nbs',
        source: 'voice-actuator',
        interaction: {
          at: '2026-04-20T10:00:00Z',
          summary: 'First voice call — introduction.',
          channel: 'phone',
        },
      });
      expect(node.identity.person_slug).toBe('alice-example');
      expect(node.trust_level.current).toBe(3);
      expect(node.history).toHaveLength(1);
      expect(node.history[0].summary).toContain('introduction');
    });

    it('appends to an existing history', () => {
      recordInteraction({
        personSlug: 'bob',
        org: 'nbs',
        source: 'presence-actuator',
        interaction: { at: '2026-04-20T10:00:00Z', summary: 'meeting 1' },
      });
      const node = recordInteraction({
        personSlug: 'bob',
        org: 'nbs',
        source: 'voice-actuator',
        interaction: { at: '2026-04-20T11:00:00Z', summary: 'meeting 2' },
      });
      expect(node.history).toHaveLength(2);
      expect(node.history.map((entry) => entry.summary)).toEqual(['meeting 1', 'meeting 2']);
    });

    it('caps rolling history at 20 entries', () => {
      for (let i = 0; i < 25; i++) {
        recordInteraction({
          personSlug: 'carol',
          org: 'nbs',
          source: 'voice-actuator',
          interaction: { at: new Date(2026, 3, 20, 10, i).toISOString(), summary: `entry ${i}` },
        });
      }
      const node = readNode('nbs', 'carol');
      expect(node?.history).toHaveLength(20);
      expect(node?.history[0].summary).toBe('entry 5');
      expect(node?.history[19].summary).toBe('entry 24');
    });

    it('rejects untrusted sources', () => {
      expect(() =>
        recordInteraction({
          personSlug: 'eve',
          org: 'nbs',
          source: 'some-random-actuator' as unknown as 'voice-actuator',
          interaction: { at: '2026-04-20T10:00:00Z', summary: 'attempted write' },
        })
      ).toThrow(/unsupported source/);
    });

    it('rejects schema-invalid interactions before writing a new node', () => {
      expect(() =>
        recordInteraction({
          personSlug: 'invalid-interaction',
          org: 'nbs',
          source: 'voice-actuator',
          interaction: {
            at: 'not-a-timestamp',
            summary: 'must not be persisted',
          } as unknown as {
            at: string;
            summary: string;
          },
        })
      ).toThrow(/Invalid catalog relationship-node|valid timestamp/);
      expect(readNode('nbs', 'invalid-interaction')).toBeNull();
    });

    it('rejects path-traversal in slugs', () => {
      expect(() =>
        recordInteraction({
          personSlug: '../etc/passwd',
          org: 'nbs',
          source: 'voice-actuator',
          interaction: { at: '2026-04-20T10:00:00Z', summary: 'x' },
        })
      ).toThrow(/illegal path segment/);
    });

    it('rejects a relationship organization directory that traverses a symbolic link', () => {
      const realDir = path.join(tmpDir, 'real-relationships');
      const linkedDir = path.join(tmpDir, 'knowledge/confidential/relationships/linked-org');
      fs.mkdirSync(realDir, { recursive: true });
      fs.mkdirSync(path.dirname(linkedDir), { recursive: true });
      safeSymlinkSync(realDir, linkedDir, 'dir');
      try {
        expect(() => readNode('linked-org', 'person')).toThrow('[RESOURCE_PATH_SYMLINK]');
      } finally {
        safeUnlinkSync(linkedDir);
      }
    });
  });

  describe('suggestFieldUpdate', () => {
    it('queues a proposal on pending_suggestions', () => {
      recordInteraction({
        personSlug: 'dan',
        org: 'nbs',
        source: 'presence-actuator',
        interaction: { at: '2026-04-20T10:00:00Z', summary: 'first contact' },
      });
      const node = suggestFieldUpdate({
        personSlug: 'dan',
        org: 'nbs',
        source: 'voice-actuator',
        fieldPath: 'trust_level.current',
        proposedValue: 4,
      });
      expect(node.pending_suggestions).toHaveLength(1);
      expect(node.pending_suggestions?.[0].field_path).toBe('trust_level.current');
      expect(node.trust_level.current).toBe(3);
    });

    it('refuses to suggest on a missing node', () => {
      expect(() =>
        suggestFieldUpdate({
          personSlug: 'nobody',
          org: 'nbs',
          source: 'voice-actuator',
          fieldPath: 'trust_level.current',
          proposedValue: 5,
        })
      ).toThrow(/node missing/);
    });
  });

  describe('read helpers', () => {
    it('returns null from readNode when absent', () => {
      expect(readNode('nbs', 'nobody')).toBeNull();
    });

    it('rejects malformed persisted nodes before relationship data is used', () => {
      const file = path.join(tmpDir, 'knowledge/confidential/relationships/nbs/malformed.json');
      safeWriteFile(
        file,
        JSON.stringify({
          identity: { name: 'Malformed', org: 'nbs', person_slug: 'malformed' },
          trust_level: {
            current: 99,
            updated_at: '2026-04-20T10:00:00.000Z',
          },
          history: [],
          updated_at: '2026-04-20T10:00:00.000Z',
        }),
        { encoding: 'utf8', mkdir: true }
      );

      expect(() => readNode('nbs', 'malformed')).toThrow(/trust_level.current/);
    });

    it('rejects a relationship node path that is a directory', () => {
      const directoryPath = path.join(
        tmpDir,
        'knowledge/confidential/relationships/nbs/directory.json'
      );
      safeMkdir(directoryPath, { recursive: true });

      expect(() => readNode('nbs', 'directory')).toThrow(/regular file/);
    });

    it('returns defaults for missing fields', () => {
      recordInteraction({
        personSlug: 'frank',
        org: 'nbs',
        source: 'voice-actuator',
        interaction: { at: '2026-04-20T10:00:00Z', summary: 'hi' },
      });
      expect(listNgTopics('nbs', 'frank')).toEqual([]);
      expect(getTrustLevel('nbs', 'frank')).toBe(3);
    });
  });
});
