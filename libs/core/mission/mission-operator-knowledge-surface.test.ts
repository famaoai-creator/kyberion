import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as io from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { loadKnowledgeUsageAggregate } from '../knowledge/knowledge-feedback-loop.js';
import { surfacePromotedKnowledgeForOperator } from './mission-operator-knowledge-surface.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) io.safeRmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = pathResolver.sharedTmp('operator-surface-' + randomUUID());
  roots.push(root);
  const documentPath = 'knowledge/public/common/wisdom/generated/mem-surface-test.md';
  const absolute = path.join(root, documentPath);
  io.safeMkdir(path.dirname(absolute), { recursive: true });
  io.safeWriteFile(
    absolute,
    [
      '---',
      'record_id: mem-surface-test',
      'kind: wisdom',
      'tier: public',
      '---',
      '',
      '# Mission evidence recording needs positional arguments',
      '',
      'Lessons about mission evidence: record-evidence takes positional task ids,',
      'and flag forms do not close the task even when they print recorded.',
      '',
    ].join('\n')
  );
  return root;
}

describe('surfacePromotedKnowledgeForOperator', () => {
  it('returns display lines and records delivery for a matching promoted record', async () => {
    const lines = await surfacePromotedKnowledgeForOperator({
      missionId: 'MSN-TEST-SURFACE',
      topic: 'mission evidence recording positional arguments',
      scope: { tier: 'public', mission_id: 'MSN-TEST-SURFACE' },
      rootDir: fixtureRoot(),
    });
    expect(lines.join('\n')).toContain('mem-surface-test');
    const delivered = loadKnowledgeUsageAggregate({ tier: 'public' }).some(
      (entry) => entry.document_path.endsWith('mem-surface-test.md') && entry.delivered_count > 0
    );
    expect(delivered).toBe(true);
  });

  it('returns [] for a blank topic without touching the aggregate', async () => {
    const lines = await surfacePromotedKnowledgeForOperator({
      missionId: 'MSN-TEST-SURFACE',
      topic: '   ',
      scope: { tier: 'public' },
      rootDir: fixtureRoot(),
    });
    expect(lines).toEqual([]);
  });

  it('fails open when the knowledge base is absent', async () => {
    const empty = pathResolver.sharedTmp('operator-surface-empty-' + randomUUID());
    roots.push(empty);
    io.safeMkdir(empty, { recursive: true });
    const lines = await surfacePromotedKnowledgeForOperator({
      missionId: 'MSN-TEST-SURFACE',
      topic: 'anything',
      scope: { tier: 'public' },
      rootDir: empty,
    });
    expect(lines).toEqual([]);
  });
});
