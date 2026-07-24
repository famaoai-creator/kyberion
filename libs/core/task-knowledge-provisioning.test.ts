import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// KP-01: provisionTaskKnowledge wraps resolveMissionContextPack (selection +
// budget pruning) + saveMissionContextPack (persistence) +
// renderMissionContextPack/render-form (presentation). Selection itself
// (knowledge search, tags, scoring) is already covered by
// mission-context-pack.test.ts and distill-knowledge-injector.test.ts; here
// we mock resolveMissionContextPack to a deterministic fixture pack (built
// with buildMissionContextPack + explicit knowledgeHints, exactly like
// mission-context-pack.test.ts does) so these tests stay hermetic and focus
// on provisionTaskKnowledge's own responsibility: form selection + save
// forwarding.

const mocks = vi.hoisted(() => ({
  resolveMissionContextPack: vi.fn(),
}));

vi.mock('./mission-context-pack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mission-context-pack.js')>();
  return {
    ...actual,
    resolveMissionContextPack: mocks.resolveMissionContextPack,
  };
});

import {
  buildMissionContextPack,
  renderMissionContextPack,
  type MissionContextPack,
} from './mission-context-pack.js';
import { provisionTaskKnowledge } from './task-knowledge-provisioning.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';

// buildMissionContextPack's internal pruning step writes a context rollup
// under `missionPath` (default: the real `active/missions/public/<id>`
// directory, which the test persona is not authorized to write to). Route it
// under the governed tmp root instead, same as mission-context-pack.test.ts.
const fixtureRollupPath = pathResolver.sharedTmp(
  `kp01-provisioning-test/fixture-rollup-${process.pid}`
);

function buildFixturePack(
  overrides: { contextPackId?: string; projectId?: string } = {}
): MissionContextPack {
  const projectId = overrides.projectId ?? `PRJ-KP01-FIXTURE-${process.pid}`;
  return buildMissionContextPack({
    contextPackId: overrides.contextPackId ?? 'CPK-KP01-FIXTURE-TEST-00000001',
    missionPath: fixtureRollupPath,
    missionState: {
      mission_id: 'MSN-KP01-FIXTURE',
      tier: 'public',
      status: 'active',
      execution_mode: 'local',
      priority: 3,
      assigned_persona: 'worker',
      confidence_score: 1,
      git: { branch: 'main', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
      history: [],
    },
    teamRole: 'implementer',
    recipientKind: 'agent',
    assigneePeerId: 'agent-1',
    workItem: {
      item_id: 'WIT-KP01-FIXTURE',
      title: 'Implement the KP-01 provisioning seam',
      description: 'Wrap resolve/save/render behind one entry point.',
      status: 'ready',
      priority: 'normal',
      source: 'local',
      source_ref: 'mission:MSN-KP01-FIXTURE:T1',
      project_id: projectId,
      labels: ['mission:MSN-KP01-FIXTURE'],
      dependencies: [],
      version: 1,
      created_at: '2026-07-25T00:00:00.000Z',
      updated_at: '2026-07-25T00:00:00.000Z',
    },
    knowledgeHints: [
      {
        path: 'knowledge/product/architecture/kp01-fixture-hint.md',
        title: 'KP-01 Fixture Hint',
        excerpt:
          'Deterministic knowledge hint content used only by the KP-01 provisioning test fixture.',
        tags: ['kp-01'],
        score: 0.5,
      },
    ],
  });
}

beforeEach(() => {
  mocks.resolveMissionContextPack.mockReset();
});

afterEach(() => {
  safeRmSync(fixtureRollupPath, { recursive: true, force: true });
});

describe('provisionTaskKnowledge', () => {
  it('form "pack" renders byte-identical output to calling renderMissionContextPack directly', async () => {
    const pack = buildFixturePack();
    mocks.resolveMissionContextPack.mockResolvedValue(pack);

    const result = await provisionTaskKnowledge({
      form: 'pack',
      missionId: pack.scope.mission_id,
      teamRole: 'implementer',
    });

    expect(result.pack).toBe(pack);
    expect(result.text).toBe(renderMissionContextPack(pack));
  });

  it('defaults to form "pack" when the form option is omitted', async () => {
    const pack = buildFixturePack();
    mocks.resolveMissionContextPack.mockResolvedValue(pack);

    const result = await provisionTaskKnowledge({ missionId: pack.scope.mission_id });

    expect(result.text).toBe(renderMissionContextPack(pack));
  });

  it('form "system_prompt" is a role-scoped rendering that carries the knowledge hints and work item', async () => {
    const pack = buildFixturePack();
    mocks.resolveMissionContextPack.mockResolvedValue(pack);

    const result = await provisionTaskKnowledge({
      form: 'system_prompt',
      missionId: pack.scope.mission_id,
    });

    expect(result.text).toContain('stable prefix');
    expect(result.text).toContain('KP-01 Fixture Hint');
    expect(result.text).toContain('knowledge/product/architecture/kp01-fixture-hint.md');
    expect(result.text).toContain(pack.work_item!.title);
    // Distinct rendering from the full pack form (not a re-export of it).
    expect(result.text).not.toBe(renderMissionContextPack(pack));
  });

  it('form "context_string" is compact and still carries the knowledge hints', async () => {
    const pack = buildFixturePack();
    mocks.resolveMissionContextPack.mockResolvedValue(pack);

    const result = await provisionTaskKnowledge({
      form: 'context_string',
      missionId: pack.scope.mission_id,
    });

    expect(result.text).toContain('KP-01 Fixture Hint');
    expect(result.text.length).toBeLessThan(renderMissionContextPack(pack).length);
  });

  it('returns a null pack and empty text when resolution yields no pack', async () => {
    mocks.resolveMissionContextPack.mockResolvedValue(null);

    const result = await provisionTaskKnowledge({ missionId: 'MSN-DOES-NOT-EXIST' });

    expect(result.pack).toBeNull();
    expect(result.text).toBe('');
    expect(result.missionContextPackPath).toBeUndefined();
  });

  describe('persistence', () => {
    const missionPath = pathResolver.sharedTmp(`kp01-provisioning-test/${process.pid}`);

    afterEach(() => {
      safeRmSync(missionPath, { recursive: true, force: true });
    });

    it('persists the pack via saveMissionContextPack when missionPath is provided', async () => {
      const pack = buildFixturePack({ contextPackId: 'CPK-KP01-SAVE-TEST-00000001' });
      mocks.resolveMissionContextPack.mockResolvedValue(pack);

      const result = await provisionTaskKnowledge({
        form: 'pack',
        missionId: pack.scope.mission_id,
        missionPath,
      });

      const expectedPath = `${missionPath}/coordination/context-packs/${pack.context_pack_id}.json`;
      expect(result.missionContextPackPath).toBe(expectedPath);
      expect(safeExistsSync(expectedPath)).toBe(true);
      const saved = JSON.parse(safeReadFile(expectedPath, { encoding: 'utf8' }) as string);
      expect(saved.context_pack_id).toBe(pack.context_pack_id);
    });

    it('does not persist when missionPath is omitted', async () => {
      const pack = buildFixturePack();
      mocks.resolveMissionContextPack.mockResolvedValue(pack);

      const result = await provisionTaskKnowledge({
        form: 'pack',
        missionId: pack.scope.mission_id,
      });

      expect(result.missionContextPackPath).toBeUndefined();
    });
  });
});
