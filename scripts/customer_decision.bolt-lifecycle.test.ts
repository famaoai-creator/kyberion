/**
 * CD-10 end to end through the real mission lifecycle (no injected mission
 * loader or case resolver): mission A is finished (and so archived), the
 * operator drafts A's bolt review, mission B of the same project starts, and
 * A's review passes `bolt-after:A`.
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The real lifecycle notifies the operator and checks the operator profile;
// neither is what this test is about (and CI has no profile).
vi.mock('@agent/core/surface/operator-notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/operator-notifications')>()),
  notifyOperator: vi.fn().mockResolvedValue(true),
  notifyOperatorWithReceiptSync: vi.fn(() => ({ status: 'suppressed' as const })),
}));
vi.mock('@agent/core/mission/mission-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/mission/mission-state')>()),
  checkPrerequisites: vi.fn(),
}));
vi.mock('@agent/core/governance/audit-chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/governance/audit-chain')>();
  return { ...actual, auditChain: { ...actual.auditChain, record: vi.fn(), loadAll: () => [] } };
});

import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { readAgenda, listAgendaIds } from '@agent/core/customer-decision';
import { withExecutionContext } from '@agent/core/authority';
import { finishMission } from '@agent/core/mission/mission-lifecycle';
import { startMission } from '@agent/core/mission/mission-creation';
import { loadMissionStateIncludingArchive } from '@agent/core/mission/mission-state';
import { transitionStatus } from '@agent/core/mission/mission-status';
import { runCustomerDecision } from './customer_decision.js';

const suffix = `${process.pid}${Date.now().toString(36)}`.toUpperCase();
const TENANT = 'cdten-lifecycle';
const CASE = `PRJ-CD10-${suffix}`;
const MISSION_A = `MSN-CD10-A-${suffix}`;
const MISSION_B = `MSN-CD10-B-${suffix}`;
/** A CONFIDENTIAL tenant bolt: its archive is a protected tier store (D1). */
const MISSION_C = `MSN-CD10-C-${suffix}`;
const NOW = '2026-10-24T00:00:00.000Z';
const location = { tenantSlug: TENANT, caseId: CASE };
type Tier = 'public' | 'confidential';
const missionPath = (id: string, tier: Tier = 'public') =>
  pathResolver.missionDir(id, tier, TENANT);
const queuePath = pathResolver.sharedTmp(`cd10-lifecycle-queue-${suffix}/queue.jsonl`);

function writeMission(id: string, status: string, tier: Tier = 'public'): void {
  const dir = missionPath(id, tier);
  safeMkdir(`${dir}/evidence`, { recursive: true });
  const head = safeExec('git', ['rev-parse', 'HEAD'], { cwd: pathResolver.rootDir() }).trim();
  safeWriteFile(
    `${dir}/mission-state.json`,
    JSON.stringify(
      {
        mission_id: id,
        tier,
        tenant_slug: TENANT,
        status,
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'tester',
        confidence_score: 1,
        git: { branch: 'test', start_commit: 'abc123', latest_commit: head, checkpoints: [] },
        history: [],
        context: {},
        relationships: { project: { project_id: CASE, relationship_type: 'belongs_to' } },
        outcome_contract: {
          outcome_id: `outcome-${id}`,
          requested_result: 'Mission closeout complete.',
          success_criteria: ['The closeout note is saved'],
          deliverable_kind: 'markdown',
          evidence_required: true,
          expected_artifacts: [{ kind: 'markdown', storage_class: 'mission' }],
          verification_method: 'self_check',
        },
      },
      null,
      2
    )
  );
  safeWriteFile(`${dir}/evidence/closeout.md`, '# Closeout\nMission closeout complete.');
  safeWriteFile(
    `${dir}/NEXT_TASKS.json`,
    JSON.stringify([
      {
        task_id: 'task-1',
        status: 'completed',
        assigned_to: { role: 'operator', agent_id: 'implementation-architect' },
        description: 'Close out the mission',
        deliverable: 'evidence/closeout.md',
        target_path: 'evidence/closeout.md',
      },
    ])
  );
}

let caseCreated = false;
/** The project's decision case exists once any agenda is drafted in it. */
async function ensureCase(): Promise<void> {
  if (caseCreated) return;
  await runCustomerDecision(
    ['draft', '--tenant', TENANT, '--case', CASE, '--customer', 'acme', '--locale', 'en'],
    { now: () => NOW }
  );
  caseCreated = true;
}

describe('bolt review through the real mission lifecycle (CD-10)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const key of ['MISSION_ROLE', 'KYBERION_PERSONA', 'KYBERION_MEMORY_QUEUE_PATH'])
      saved[key] = process.env[key];
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'worker';
    process.env.KYBERION_MEMORY_QUEUE_PATH = queuePath;
  });
  afterAll(() => {
    for (const id of [MISSION_A, MISSION_B])
      safeRmSync(missionPath(id), { recursive: true, force: true });
    safeRmSync(missionPath(MISSION_C, 'confidential'), { recursive: true, force: true });
    safeRmSync(pathResolver.archivedMissionDir(MISSION_A, { tier: 'public', tenant: TENANT }), {
      recursive: true,
      force: true,
    });
    safeRmSync(
      pathResolver.archivedMissionDir(MISSION_C, { tier: 'confidential', tenant: TENANT }),
      { recursive: true, force: true }
    );
    withExecutionContext(
      'decision_ledger',
      () =>
        safeRmSync(pathResolver.rootResolve(`knowledge/confidential/${TENANT}/decisions/${CASE}`), {
          recursive: true,
          force: true,
        }),
      undefined,
      TENANT
    );
    safeRmSync(pathResolver.rootResolve(`customer/${TENANT}`), { recursive: true, force: true });
    safeRmSync(path.dirname(queuePath), { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('a finished (archived) bolt is reviewed, and the next bolt start passes bolt-after:<A>', async () => {
    // The project's decision case exists (any agenda creates it).
    await ensureCase();

    writeMission(MISSION_A, 'completed');
    await finishMission(MISSION_A, false, {
      // The production archive root (mission-system.ts), as `pnpm mission finish` uses.
      archiveDir: pathResolver.archivedMissionsRoot(),
      agentRuntimeEventPath: `${missionPath(MISSION_A)}/runtime-events.jsonl`,
      getGitHash: (cwd: string) => safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
      sealMission: async () => undefined,
      syncProjectLedgerIfLinked: async () => undefined,
      transitionStatus,
    });
    expect(safeExistsSync(`${missionPath(MISSION_A)}/mission-state.json`)).toBe(false);
    expect(loadMissionStateIncludingArchive(MISSION_A, { tenantSlug: TENANT })?.status).toBe(
      'archived'
    );

    const summary = pathResolver.sharedTmp(`cd10-lifecycle-summary-${suffix}.md`);
    safeWriteFile(summary, 'The order form saves drafts.');
    try {
      const drafted = (await runCustomerDecision(
        [
          'bolt-review',
          '--tenant',
          TENANT,
          '--case',
          CASE,
          '--mission',
          MISSION_A,
          '--customer',
          'acme',
          '--summary-file',
          summary,
        ],
        { now: () => NOW }
      )) as { agenda_id: string; bolt_mission_id: string };
      expect(drafted.bolt_mission_id).toBe(MISSION_A);

      writeMission(MISSION_B, 'planned');
      await startMission({
        id: MISSION_B,
        tier: 'public',
        tenantSlug: TENANT,
        rootDir: pathResolver.rootDir(),
      });

      const agenda = withExecutionContext(
        'decision_ledger',
        () => readAgenda(location, drafted.agenda_id),
        undefined,
        TENANT
      );
      expect(agenda?.milestones_passed).toEqual([`bolt-after:${MISSION_A}`]);
      // Only the review agenda changed; the other agenda of the case did not.
      const others = withExecutionContext(
        'decision_ledger',
        () =>
          listAgendaIds(location)
            .filter((id) => id !== drafted.agenda_id)
            .map((id) => readAgenda(location, id)),
        undefined,
        TENANT
      );
      expect(others.every((other) => !other?.milestones_passed?.length)).toBe(true);
    } finally {
      safeRmSync(summary, { force: true });
    }
  }, 60_000);
  it('a finished CONFIDENTIAL tenant bolt is reviewed by an operator CLI without MISSION_ROLE (D1, D5, D7)', async () => {
    // The case exists (the first test, or this draft).
    await ensureCase();
    writeMission(MISSION_C, 'completed', 'confidential');
    const success = vi.spyOn(logger, 'success');
    try {
      // `pnpm mission finish` runs as mission_controller (mission_controller.ts sets it).
      await finishMission(MISSION_C, false, {
        archiveDir: pathResolver.archivedMissionsRoot(),
        agentRuntimeEventPath: `${missionPath(MISSION_C, 'confidential')}/runtime-events.jsonl`,
        getGitHash: (cwd: string) => safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
        sealMission: async () => undefined,
        syncProjectLedgerIfLinked: async () => undefined,
        transitionStatus,
      });
      // D7: the bolt-review command is the operator's closing line, after the archive line.
      const lines = success.mock.calls.map(([line]) => String(line));
      const archived = lines.findIndex((line) => line.includes(`${MISSION_C} archived`));
      const next = lines.findIndex((line) =>
        line.includes(`bolt-review --tenant ${TENANT} --case ${CASE} --mission ${MISSION_C}`)
      );
      expect(archived).toBeGreaterThanOrEqual(0);
      expect(next).toBeGreaterThan(archived);
    } finally {
      success.mockRestore();
    }
    const archivedDir = pathResolver.findArchivedMissionDir(MISSION_C) ?? '';
    expect(pathResolver.toRepoRelative(archivedDir)).toBe(
      `active/archive/missions/confidential/${TENANT}/${MISSION_C}`
    );

    // The operator's own CLI: no MISSION_ROLE / KYBERION_PERSONA.
    const role = process.env.MISSION_ROLE;
    const persona = process.env.KYBERION_PERSONA;
    delete process.env.MISSION_ROLE;
    delete process.env.KYBERION_PERSONA;
    const summary = pathResolver.sharedTmp(`cd10-lifecycle-summary-c-${suffix}.md`);
    safeWriteFile(summary, 'The stock search shows the bin.');
    let drafted: { agenda_id: string; bolt_mission_id: string };
    try {
      drafted = (await runCustomerDecision(
        [
          'bolt-review',
          '--tenant',
          TENANT,
          '--case',
          CASE,
          '--mission',
          MISSION_C,
          '--customer',
          'acme',
          '--summary-file',
          summary,
        ],
        { now: () => NOW }
      )) as { agenda_id: string; bolt_mission_id: string };
      // Another tenant does not see it (not found, not a denial).
      await expect(
        runCustomerDecision(
          [
            'bolt-review',
            '--tenant',
            'cdten-other',
            '--case',
            CASE,
            '--mission',
            MISSION_C,
            '--customer',
            'acme',
            '--summary-file',
            summary,
          ],
          { now: () => NOW }
        )
      ).rejects.toThrow(/was not found or has no decision case/u);
    } finally {
      process.env.MISSION_ROLE = role;
      process.env.KYBERION_PERSONA = persona;
      safeRmSync(summary, { force: true });
    }
    expect(drafted.bolt_mission_id).toBe(MISSION_C);
    const agenda = withExecutionContext(
      'decision_ledger',
      () => readAgenda(location, drafted.agenda_id),
      undefined,
      TENANT
    );
    // D5: the review agenda (and so its bolt WorkItem) carries the mission's project.
    expect(agenda?.project_id).toBe(CASE);
    // D4: the customer reads no internal "bolt" wording.
    const entry = agenda?.entries[0];
    expect(`${entry?.question} ${entry?.background}`).not.toMatch(/\bbolt\b/iu);
  }, 90_000);
});
