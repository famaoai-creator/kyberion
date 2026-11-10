import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as io from '../secure-io.js';
import { readTextFile } from '../foundation/text.js';
import { pathResolver } from '../path-resolver.js';
import { loadKnowledgeHintsIfPossible } from './mission-context-pack-knowledge.js';
import type { MissionStateSummary } from './mission-context-pack-types.js';

// D8 / M1: a promoted record under knowledge/product/evolution/*/generated must
// reach the context pack of later, related work by relevance — without a pin.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) io.safeRmSync(root, { recursive: true, force: true });
});

function emptySlices(): string {
  const root = pathResolver.sharedTmp('promoted-knowledge-slices-' + randomUUID());
  roots.push(root);
  io.safeMkdir(root, { recursive: true });
  const file = path.join(root, 'knowledge-slices.json');
  io.safeWriteFile(file, JSON.stringify({ version: '0.5.0', slices: [] }));
  return file;
}

function mission(overrides: Partial<MissionStateSummary> = {}): MissionStateSummary {
  return {
    mission_id: 'MSN-PROMOTED-REPRO',
    mission_type: 'development',
    tier: 'public',
    status: 'active',
    assigned_persona: 'worker',
    git: { branch: 'fixture', start_commit: 'fixture', latest_commit: 'fixture', checkpoints: [] },
    history: [],
    ...overrides,
  };
}

describe('promoted knowledge reaches later work (repo corpus)', () => {
  it('includes a relevant promoted product lesson in a tenantless public mission pack', async () => {
    const dir = pathResolver.knowledge('product/evolution/wisdom/generated');
    const name = io
      .safeReaddir(dir)
      .filter((entry) => entry.endsWith('.md'))
      .sort()[0];
    expect(name).toBeTruthy();
    const title = readTextFile(path.join(dir, name)).match(/^#\s+(.+)$/m)?.[1];
    expect(title).toBeTruthy();

    const hints = await loadKnowledgeHintsIfPossible({
      missionState: mission(),
      taskSession: { goal: { summary: title } } as never,
      knowledgeSlicesPath: emptySlices(),
      estimatedScope: 'L',
    });

    expect(hints.map((hint) => hint.path)).toContain(
      `knowledge/product/evolution/wisdom/generated/${name}`
    );
  });
});
