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
  sendOpsAlert: vi.fn(),
}));

vi.mock('./mission-context-pack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mission-context-pack.js')>();
  return {
    ...actual,
    resolveMissionContextPack: mocks.resolveMissionContextPack,
  };
});

// XP-03: checkProviderEgress emits an ops-alert on denial (acceptance
// criterion 3). Mocked here rather than exercised for real so this suite
// never touches the shared ops-alerts.jsonl sink.
vi.mock('./ops-alert.js', () => ({ sendOpsAlert: mocks.sendOpsAlert }));

import {
  buildMissionContextPack,
  renderMissionContextPack,
  type MissionContextPack,
} from './mission-context-pack.js';
import { provisionTaskKnowledge } from './task-knowledge-provisioning.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import {
  knowledgeDeliveryLogDir,
  loadKnowledgeUsageAggregate,
} from './src/knowledge-feedback-loop.js';
import {
  resetProviderEgressPolicyCache,
  type ProviderEgressPolicyFile,
} from './provider-egress-gate.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';
import * as path from 'node:path';

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

// KP-05: provisionTaskKnowledge records delivery telemetry as a side effect.
// Route it under the governed tmp root (same reasoning as fixtureRollupPath
// above) so this suite never touches the real
// active/shared/runtime/feedback-loop/ files.
const deliveryDirOverride = pathResolver.sharedTmp(
  `kp05-provisioning-test/delivery-${process.pid}`
);
const usagePathOverride = pathResolver.sharedTmp(
  `kp05-provisioning-test/usage-${process.pid}.json`
);
let originalDeliveryDir: string | undefined;
let originalUsagePath: string | undefined;

beforeEach(() => {
  mocks.resolveMissionContextPack.mockReset();
  mocks.sendOpsAlert.mockReset();
  originalDeliveryDir = process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR;
  originalUsagePath = process.env.KYBERION_KNOWLEDGE_USAGE_PATH;
  process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = deliveryDirOverride;
  process.env.KYBERION_KNOWLEDGE_USAGE_PATH = usagePathOverride;
});

afterEach(() => {
  safeRmSync(fixtureRollupPath, { recursive: true, force: true });
  safeRmSync(deliveryDirOverride, { recursive: true, force: true });
  safeRmSync(usagePathOverride, { recursive: true, force: true });
  if (originalDeliveryDir === undefined) delete process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR;
  else process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = originalDeliveryDir;
  if (originalUsagePath === undefined) delete process.env.KYBERION_KNOWLEDGE_USAGE_PATH;
  else process.env.KYBERION_KNOWLEDGE_USAGE_PATH = originalUsagePath;
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

  describe('KP-05 delivery telemetry', () => {
    it('records a delivery record and exposes deliveredKnowledgeRefs when hints are delivered', async () => {
      const pack = buildFixturePack();
      mocks.resolveMissionContextPack.mockResolvedValue(pack);

      const result = await provisionTaskKnowledge({
        form: 'pack',
        missionId: pack.scope.mission_id,
        teamRole: 'implementer',
        workItem: pack.work_item ?? undefined,
      });

      expect(result.deliveredKnowledgeRefs).toEqual([
        {
          path: 'knowledge/product/architecture/kp01-fixture-hint.md',
          title: 'KP-01 Fixture Hint',
          score: 0.5,
        },
      ]);

      const dir = knowledgeDeliveryLogDir();
      expect(safeExistsSync(dir)).toBe(true);
      const aggregate = loadKnowledgeUsageAggregate();
      const entry = aggregate.find(
        (e) => e.document_path === 'knowledge/product/architecture/kp01-fixture-hint.md'
      );
      expect(entry).toMatchObject({ delivered_count: 1, occurrences: 1 });
    });

    it('does not write a delivery record when the pack has no knowledge hints', async () => {
      const pack = buildFixturePack();
      pack.knowledge_hints = [];
      mocks.resolveMissionContextPack.mockResolvedValue(pack);

      const result = await provisionTaskKnowledge({
        form: 'pack',
        missionId: pack.scope.mission_id,
      });

      expect(result.deliveredKnowledgeRefs).toEqual([]);
      expect(safeExistsSync(knowledgeDeliveryLogDir())).toBe(false);
    });
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

  // XP-03: gate before persisting/rendering — a denied provider must never
  // see any rendering of this mission's knowledge, not even a truncated one.
  describe('XP-03 tier x egress gate', () => {
    const policyDir = pathResolver.sharedTmp(`kp01-provisioning-test/egress-policy-${process.pid}`);
    const policyPath = path.join(policyDir, 'provider-egress-policy.json');
    let originalPolicyPath: string | undefined;

    function writePolicy(policy: ProviderEgressPolicyFile): void {
      safeMkdir(policyDir, { recursive: true });
      safeWriteFile(policyPath, JSON.stringify(policy), { encoding: 'utf8' });
    }

    beforeEach(() => {
      originalPolicyPath = process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH;
      process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH = policyPath;
      writePolicy({
        version: '1.0.0',
        providers: { claude: { egress: 'external-api' }, codex: { egress: 'external-api' } },
        tier_policy: {
          confidential: { mode: 'approved-only', approved_providers: ['claude'] },
          personal: { mode: 'local-only-or-approved', approved_providers: [] },
        },
      });
      resetProviderEgressPolicyCache();
    });

    afterEach(() => {
      safeRmSync(policyDir, { recursive: true, force: true });
      if (originalPolicyPath === undefined) delete process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH;
      else process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH = originalPolicyPath;
      resetProviderEgressPolicyCache();
    });

    it('returns a typed refusal (not a silent empty pack) when the resolved provider is not approved for the mission tier', async () => {
      const pack = buildFixturePack();
      pack.mission.tier = 'confidential';
      mocks.resolveMissionContextPack.mockResolvedValue(pack);

      const result = await provisionTaskKnowledge({
        form: 'pack',
        missionId: pack.scope.mission_id,
        provider: 'codex',
      });

      expect(result.pack).toBeNull();
      expect(result.text).toBe('');
      expect(result.deliveredKnowledgeRefs).toEqual([]);
      expect(result.egressDenied).toBeDefined();
      expect(result.egressDenied).toMatchObject({ provider: 'codex', dataTier: 'confidential' });
      expect(result.egressDenied!.reason).toContain('PROVIDER_EGRESS_DENIED');
      // No KP-05 delivery record for a denied render.
      expect(safeExistsSync(knowledgeDeliveryLogDir())).toBe(false);
      expect(mocks.sendOpsAlert).toHaveBeenCalledTimes(1);
    });

    it('delivers the pack when the resolved provider is approved for the mission tier', async () => {
      const pack = buildFixturePack();
      pack.mission.tier = 'confidential';
      mocks.resolveMissionContextPack.mockResolvedValue(pack);

      const result = await provisionTaskKnowledge({
        form: 'pack',
        missionId: pack.scope.mission_id,
        provider: 'claude',
      });

      expect(result.pack).toBe(pack);
      expect(result.egressDenied).toBeUndefined();
      expect(mocks.sendOpsAlert).not.toHaveBeenCalled();
    });

    it('does not gate when no provider is supplied or resolvable', async () => {
      const pack = buildFixturePack();
      pack.mission.tier = 'confidential';
      mocks.resolveMissionContextPack.mockResolvedValue(pack);

      const result = await provisionTaskKnowledge({
        form: 'pack',
        missionId: pack.scope.mission_id,
      });

      expect(result.pack).toBe(pack);
      expect(result.egressDenied).toBeUndefined();
    });
  });
});
