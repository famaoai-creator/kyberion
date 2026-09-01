import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { evidenceChain, queryEvidence, summarizeEvidence } from './evidence-chain.js';

const REGISTRY_PATH = path.resolve(process.cwd(), 'active/shared/registry/evidence_chain.json');

describe('evidence-chain', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(REGISTRY_PATH)) {
      fs.unlinkSync(REGISTRY_PATH);
    }
  });

  it('queries entries from the canonical shared registry path', () => {
    fs.writeFileSync(
      REGISTRY_PATH,
      JSON.stringify(
        {
          chain: [
            {
              id: 'EVD-AAAA1111',
              hash: 'hash-a',
              path: 'missions/MSN-1/evidence/a.txt',
              missionId: 'MSN-1',
              agentId: 'agent-a',
              timestamp: '2026-03-25T00:00:00.000Z',
            },
          ],
        },
        null,
        2
      )
    );

    const entries = queryEvidence({ missionId: 'MSN-1' });

    expect(entries).toHaveLength(1);
    expect(entries[0].evidenceId).toBe('EVD-AAAA1111');
    expect(entries[0].registeredAt).toBe('2026-03-25T00:00:00.000Z');
  });

  it('summarizes normalized entries from the shared registry', () => {
    fs.writeFileSync(
      REGISTRY_PATH,
      JSON.stringify(
        {
          chain: [
            {
              id: 'EVD-AAAA1111',
              hash: 'hash-a',
              path: 'missions/MSN-2/evidence/report.pdf',
              missionId: 'MSN-2',
              timestamp: '2026-03-25T00:00:00.000Z',
            },
            {
              id: 'EVD-BBBB2222',
              hash: 'hash-b',
              path: 'missions/MSN-2/evidence/shot.png',
              missionId: 'MSN-2',
              timestamp: '2026-03-25T01:00:00.000Z',
            },
          ],
        },
        null,
        2
      )
    );

    const summary = summarizeEvidence('MSN-2');

    expect(summary.total).toBe(2);
    expect(summary.byType.pdf).toBe(1);
    expect(summary.byType.png).toBe(1);
    expect(summary.dateRange.from).toBe('2026-03-25T00:00:00.000Z');
    expect(summary.dateRange.to).toBe('2026-03-25T01:00:00.000Z');
  });

  it('ignores malformed registry entries during query projection', () => {
    fs.writeFileSync(
      REGISTRY_PATH,
      JSON.stringify({
        chain: [
          null,
          { id: 'EVD-INCOMPLETE', path: 'missing-hash.txt' },
          {
            id: 'EVD-VALID3333',
            hash: 'hash-valid',
            path: 'missions/MSN-3/evidence/report.txt',
            timestamp: '2026-03-25T02:00:00.000Z',
          },
        ],
      })
    );

    expect(queryEvidence()).toEqual([
      expect.objectContaining({ evidenceId: 'EVD-VALID3333', hash: 'hash-valid' }),
    ]);
  });

  it('uses the same registry path for query as register', () => {
    expect(evidenceChain.registryPath).toBe(REGISTRY_PATH);
  });

  it('rejects evidence artifacts reached through a symbolic link', () => {
    const target = path.resolve(process.cwd(), 'active/shared/tmp/evidence-chain-target.txt');
    const linked = path.resolve(process.cwd(), 'active/shared/tmp/evidence-chain-linked.txt');
    try {
      fs.writeFileSync(target, 'sensitive evidence');
      fs.symlinkSync(target, linked);

      expect(evidenceChain.register(linked, 'agent-a')).toBeNull();
    } finally {
      if (fs.existsSync(linked)) fs.unlinkSync(linked);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  });
});
