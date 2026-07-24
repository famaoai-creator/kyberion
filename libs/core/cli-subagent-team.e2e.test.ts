import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HarnessSubagentDispatcher } from './agent-dispatch.js';
import type { ReasoningBackend } from './reasoning-backend.js';
import { resolveCapabilityProfileForTeamRole } from './subagent-capability-profiles.js';
import { extractSurfaceBlocks } from './surface-response-blocks.js';
import { PlanningReviewVerdictSchema } from './structured-output-contracts.js';
import type { TaskResultBlock } from './channel-surface-types.js';
import {
  WorkCoordinationError,
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  getWorkItem,
  importExternalWorkItem,
  releaseWorkItem,
  setWorkCoordinationNamespace,
} from './work-coordination.js';

/**
 * CT-03: minimal CLI subagent team, exercised end-to-end purely on file
 * contracts — no A2A bridge, no real processes, no SDK.
 *
 * Every "worker" in this test is the real {@link HarnessSubagentDispatcher}
 * (CT-02) wired to a scripted `loadRuntime` (the injectable seam it already
 * exposes for tests — see agent-dispatch.test.ts), so the only thing that is
 * faked is the governed Agent SDK call (`runTask`); dispatch-side profile
 * resolution, prompt assembly, and result parsing (`extractSurfaceBlocks` /
 * `PlanningReviewVerdictSchema`) all run for real.
 *
 * Acceptance criteria this file proves:
 *  1. A two-task team (B depends on A) can be planned as PlannedNextTask-shaped
 *     contracts, dispatched through HarnessSubagentDispatcher, and B's dispatch
 *     provably carries A's upstream result in its prompt context.
 *  2. Work-item claim exclusivity: importExternalWorkItem + claimWorkItem give
 *     each task's work item a single writable owner; a second claim attempt on
 *     an already-leased item is rejected (WorkCoordinationError/lease_conflict)
 *     — the "write = claim holder only" rule.
 *  3. A devils_advocate-profile review can run 3 lens-diverse dispatches in
 *     parallel over a task's artifact, and the resulting verdicts (each
 *     validated against the real PlanningReviewVerdictSchema — the
 *     approve/gaps/rationale judge contract this codebase's planning-review
 *     gate and MO-07 best-of-judge lineage both use) aggregate by majority
 *     into a record that itself satisfies the same schema, persisted to the
 *     mission workspace.
 */

// --- fixtures --------------------------------------------------------------

/**
 * Minimal PlannedNextTask-shaped fixture. mission-orchestration-worker.ts's
 * own `PlannedNextTask` interface is not exported, so this local shape
 * mirrors the fields this test needs (task_id, dependencies, deliverable,
 * team_role) rather than importing an internal type.
 */
interface FixturePlannedTask {
  task_id: string;
  team_role: string;
  description: string;
  deliverable: string;
  dependencies: string[];
}

function taskResultFence(block: TaskResultBlock): string {
  return ['```task_result', JSON.stringify(block), '```'].join('\n');
}

/** Minimal fake ReasoningBackend — HarnessSubagentDispatcher only touches it on the SDK-unavailable fallback path, which these tests never take. */
function makeFakeBackend(): ReasoningBackend {
  return {
    name: 'fake',
    delegateTask: vi.fn(async (instruction: string) => `spawned:${instruction}`),
    prompt: vi.fn(async (p: string) => `prompted:${p}`),
    extractRequirements: vi.fn(async () => ({ requirements: [] })),
    extractDesignSpec: vi.fn(async () => ({})),
    extractTestPlan: vi.fn(async () => ({})),
    decomposeIntoTasks: vi.fn(async () => ({ tasks: [] })),
    divergePersonas: vi.fn(async () => []),
    crossCritique: vi.fn(async () => ({})),
    synthesizePersona: vi.fn(async () => ({})),
    forkBranches: vi.fn(async () => []),
    simulateBranches: vi.fn(async () => ({})),
  } as unknown as ReasoningBackend;
}

function makeFakeRuntime(runTaskImpl: (params: any) => Promise<{ text: string }>) {
  return {
    runTask: vi.fn(async (params: any) => ({
      text: (await runTaskImpl(params)).text,
      sessionId: 'fake-session',
      totalCostUsd: 0,
      numTurns: 1,
    })),
    buildGovernedAgentSystemPrompt: vi.fn(({ base, missionContext }: any) =>
      [base, missionContext ? `Mission context:\n${missionContext}` : '']
        .filter(Boolean)
        .join('\n\n')
    ),
    buildKyberionMcpServerConfig: vi.fn(() => ({ kyberion: {} }) as any),
    createKyberionCanUseTool: vi.fn(() => vi.fn() as any),
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'NotebookRead',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
    ],
  };
}

type ReviewVerdict = { approve: boolean; gaps: string[]; rationale: string };

describe('CT-03: CLI subagent team — hermetic file-contract E2E', () => {
  let tmpDir: string;
  let namespace: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-cli-subagent-team-'));
    namespace = `cli-subagent-team-e2e-${crypto.randomUUID()}`;
    setWorkCoordinationNamespace(namespace);
    clearWorkCoordinationStore();
  });

  afterEach(() => {
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dispatches a two-task team, claims/hands off work items exclusively, runs a lens-diverse review, and lands both tasks done', async () => {
    // ---- Arrange: two PlannedNextTask-shaped contracts, B depends on A ----
    const taskA: FixturePlannedTask = {
      task_id: 'TASK-A',
      team_role: 'implementer',
      description: 'Implement the parsing helper and write its output artifact.',
      deliverable: 'artifacts/task-a-output.md',
      dependencies: [],
    };
    const taskB: FixturePlannedTask = {
      task_id: 'TASK-B',
      team_role: 'implementer',
      description: 'Build the report that consumes TASK-A output.',
      deliverable: 'artifacts/task-b-output.md',
      dependencies: ['TASK-A'],
    };
    fs.writeFileSync(path.join(tmpDir, 'NEXT_TASKS.json'), JSON.stringify([taskA, taskB], null, 2));

    const backend = makeFakeBackend();

    // ---- 1. Dispatch task A, then task B, through HarnessSubagentDispatcher ----
    const taskAResult: TaskResultBlock = {
      summary: 'Implemented the parsing helper; wrote artifacts/task-a-output.md.',
      artifacts: [{ path: taskA.deliverable, kind: 'doc' }],
      verification_done: ['ran unit tests for the parsing helper'],
      gaps: [],
      needs: [],
    };
    const taskBResult: TaskResultBlock = {
      summary: 'Built the report consuming TASK-A output; wrote artifacts/task-b-output.md.',
      artifacts: [{ path: taskB.deliverable, kind: 'doc' }],
      verification_done: ['confirmed report references the TASK-A artifact'],
      gaps: [],
      needs: [],
    };

    const teamRuntimeCalls: any[] = [];
    const teamRuntime = makeFakeRuntime(async (params) => {
      teamRuntimeCalls.push(params);
      // TASK-B's own instruction text also mentions "TASK-A" (it depends on
      // it), so match the more specific "Execute TASK-B" marker first.
      if (params.userPrompt.includes('Execute TASK-B')) {
        return { text: taskResultFence(taskBResult) };
      }
      return { text: taskResultFence(taskAResult) };
    });
    const teamDispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => teamRuntime });

    const profileA = resolveCapabilityProfileForTeamRole(taskA.team_role);
    expect(profileA).toBe('implementer');
    const responseA = await teamDispatcher.dispatch(
      `Execute ${taskA.task_id}: ${taskA.description}`,
      `Mission workspace: ${tmpDir}\nDeliverable: ${taskA.deliverable}`,
      backend,
      { profile: profileA }
    );

    // Real parser (extractSurfaceBlocks), not a re-implementation.
    const parsedA = extractSurfaceBlocks(responseA);
    expect(parsedA.taskResultErrors ?? []).toEqual([]);
    expect(parsedA.taskResults?.[0]).toEqual(taskAResult);

    // B's dispatch context must carry A's upstream summary — the crux of
    // "the team saw the dependency's result", not just "B ran after A".
    const upstreamContext = [
      `Upstream result for ${taskA.task_id}:`,
      `Summary: ${parsedA.taskResults![0].summary}`,
      `Artifacts: ${parsedA.taskResults![0].artifacts.map((a) => a.path).join(', ')}`,
    ].join('\n');

    const profileB = resolveCapabilityProfileForTeamRole(taskB.team_role);
    const responseB = await teamDispatcher.dispatch(
      `Execute ${taskB.task_id}: ${taskB.description}`,
      `Mission workspace: ${tmpDir}\nDeliverable: ${taskB.deliverable}\n${upstreamContext}`,
      backend,
      { profile: profileB }
    );

    const parsedB = extractSurfaceBlocks(responseB);
    expect(parsedB.taskResultErrors ?? []).toEqual([]);
    expect(parsedB.taskResults?.[0]).toEqual(taskBResult);

    // Assert on what the fake actually received — the dispatch prompt for
    // TASK-B's call must contain TASK-A's summary text.
    expect(teamRuntimeCalls).toHaveLength(2);
    const taskBCall = teamRuntimeCalls[1];
    const taskBFullPrompt = `${taskBCall.systemPrompt}\n${taskBCall.userPrompt}`;
    expect(taskBFullPrompt).toContain(taskAResult.summary);
    expect(taskBFullPrompt).toContain(taskA.deliverable);

    // ---- 2. Work-item claim exclusivity ----
    const itemA = importExternalWorkItem({
      source: 'local',
      sourceRef: taskA.task_id,
      title: taskA.task_id,
      description: taskA.description,
      status: 'ready',
    });
    const itemB = importExternalWorkItem({
      source: 'local',
      sourceRef: taskB.task_id,
      title: taskB.task_id,
      description: taskB.description,
      status: 'ready',
      dependencies: [itemA.item_id],
    });

    const claimedA = claimWorkItem({
      itemId: itemA.item_id,
      actorPeerId: 'agent-implementer-a',
      purpose: `execute ${taskA.task_id}`,
      expectedVersion: itemA.version,
    });
    expect(claimedA.item.status).toBe('in_progress');
    expect(claimedA.item.claimed_by_peer_id).toBe('agent-implementer-a');

    // Regression: a second claim attempt on the same (already-leased) item
    // by a different actor must fail — write access belongs to the claim
    // holder only.
    let secondClaimError: unknown;
    try {
      claimWorkItem({
        itemId: itemA.item_id,
        actorPeerId: 'agent-implementer-rogue',
        purpose: `execute ${taskA.task_id}`,
        expectedVersion: claimedA.item.version,
      });
    } catch (err) {
      secondClaimError = err;
    }
    expect(secondClaimError).toBeInstanceOf(WorkCoordinationError);
    expect((secondClaimError as WorkCoordinationError).code).toBe('lease_conflict');
    // The item is unaffected by the rejected second claim.
    expect(getWorkItem(itemA.item_id)?.claimed_by_peer_id).toBe('agent-implementer-a');

    const releasedA = releaseWorkItem({
      itemId: itemA.item_id,
      leaseId: claimedA.lease.lease_id,
      actorPeerId: 'agent-implementer-a',
      expectedVersion: claimedA.item.version,
      nextStatus: 'done',
      summary: parsedA.taskResults![0].summary,
    });
    expect(releasedA.item.status).toBe('done');

    const claimedB = claimWorkItem({
      itemId: itemB.item_id,
      actorPeerId: 'agent-implementer-b',
      purpose: `execute ${taskB.task_id}`,
      expectedVersion: itemB.version,
    });

    let secondClaimErrorB: unknown;
    try {
      claimWorkItem({
        itemId: itemB.item_id,
        actorPeerId: 'agent-implementer-rogue',
        purpose: `execute ${taskB.task_id}`,
        expectedVersion: claimedB.item.version,
      });
    } catch (err) {
      secondClaimErrorB = err;
    }
    expect(secondClaimErrorB).toBeInstanceOf(WorkCoordinationError);
    expect((secondClaimErrorB as WorkCoordinationError).code).toBe('lease_conflict');

    const releasedB = releaseWorkItem({
      itemId: itemB.item_id,
      leaseId: claimedB.lease.lease_id,
      actorPeerId: 'agent-implementer-b',
      expectedVersion: claimedB.item.version,
      nextStatus: 'done',
      summary: parsedB.taskResults![0].summary,
    });
    expect(releasedB.item.status).toBe('done');

    // ---- 3. Lens-diverse devils_advocate review over TASK-A's artifact ----
    const reviewProfile = resolveCapabilityProfileForTeamRole('devils_advocate');
    expect(reviewProfile).toBe('explorer'); // read-only tier, per TEAM_ROLE_CAPABILITY_PROFILE

    const lensVerdicts: Record<'correctness' | 'completeness' | 'risk', ReviewVerdict> = {
      correctness: {
        approve: true,
        gaps: [],
        rationale: 'Parsing logic matches acceptance criteria.',
      },
      completeness: { approve: true, gaps: [], rationale: 'All declared artifacts are present.' },
      risk: {
        approve: false,
        gaps: ['no rollback plan documented for the parsing helper'],
        rationale: 'Missing risk mitigation — refuted pending a rollback plan.',
      },
    };
    const lenses = Object.keys(lensVerdicts) as Array<keyof typeof lensVerdicts>;

    const reviewRuntime = makeFakeRuntime(async (params) => {
      const lens = lenses.find((candidate) => params.userPrompt.includes(`lens: ${candidate}`));
      if (!lens) throw new Error(`unrecognized review lens in prompt: ${params.userPrompt}`);
      return { text: JSON.stringify(lensVerdicts[lens]) };
    });
    const reviewDispatcher = new HarnessSubagentDispatcher({
      loadRuntime: async () => reviewRuntime,
    });

    const reviewResponses = await Promise.all(
      lenses.map((lens) =>
        reviewDispatcher
          .dispatch(
            `Review artifact ${taskA.deliverable} for ${taskA.task_id} — lens: ${lens}`,
            `Artifact under review: ${taskA.deliverable}\nSummary: ${taskAResult.summary}\nReturn JSON only: {"approve": boolean, "gaps": string[], "rationale": string}`,
            backend,
            { profile: reviewProfile }
          )
          .then((text) => ({ lens, text }))
      )
    );

    // Validate each scripted verdict against the real judge/verdict contract
    // (PlanningReviewVerdictSchema: approve/gaps/rationale — the same shape
    // mission-orchestration-worker.ts's parsePlanningReviewVerdict validates
    // review verdicts against, and the lineage MO-07's best-of-2 judge
    // verdict — { winner, rationale, merge_hints } — belongs to).
    const parsedVerdicts = reviewResponses.map(({ lens, text }) => ({
      lens,
      verdict: PlanningReviewVerdictSchema.parse(JSON.parse(text)),
    }));
    expect(parsedVerdicts).toHaveLength(3);
    expect(parsedVerdicts.filter((v) => v.verdict.approve)).toHaveLength(2); // 2 real
    expect(parsedVerdicts.filter((v) => !v.verdict.approve)).toHaveLength(1); // 1 refuted

    const approveCount = parsedVerdicts.filter((v) => v.verdict.approve).length;
    const refuteCount = parsedVerdicts.length - approveCount;
    const majorityApprove = approveCount > refuteCount;
    const aggregate = PlanningReviewVerdictSchema.parse({
      approve: majorityApprove,
      gaps: parsedVerdicts.flatMap((v) => v.verdict.gaps),
      rationale: `majority ${approveCount}/${parsedVerdicts.length} lenses approve (2 real / 1 refuted, per devils_advocate review)`,
    });
    expect(aggregate.approve).toBe(true);
    expect(aggregate.gaps).toContain('no rollback plan documented for the parsing helper');

    // Persist the aggregation — MO-07's best-of judge keeps the losing
    // candidate as evidence rather than discarding it (see
    // mission-orchestration-worker.ts's "Keep the losing candidate" rule);
    // this mirrors that by persisting all 3 lens verdicts alongside the
    // majority decision, not just the winner.
    const evidenceDir = path.join(tmpDir, 'evidence', 'alternatives');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const aggregateRecord = {
      task_id: taskA.task_id,
      reviewed_artifact: taskA.deliverable,
      team_role: 'devils_advocate',
      capability_profile: reviewProfile,
      lens_verdicts: parsedVerdicts.map(({ lens, verdict }) => ({ lens, ...verdict })),
      majority: aggregate,
    };
    const aggregatePath = path.join(evidenceDir, `${taskA.task_id}-review-aggregate.json`);
    fs.writeFileSync(aggregatePath, JSON.stringify(aggregateRecord, null, 2));

    // ---- 4. Assert end state ----
    const persisted = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
    expect(persisted.task_id).toBe(taskA.task_id);
    expect(persisted.lens_verdicts).toHaveLength(3);
    // Required fields of the judge/verdict contract are present on the
    // persisted majority record.
    expect(persisted.majority).toMatchObject({
      approve: true,
      gaps: expect.any(Array),
      rationale: expect.any(String),
    });
    // Re-validate the persisted (round-tripped through JSON) majority record
    // against the real schema once more — proves the on-disk shape is still
    // contract-compatible, not just the in-memory one.
    expect(() => PlanningReviewVerdictSchema.parse(persisted.majority)).not.toThrow();

    expect(getWorkItem(itemA.item_id)?.status).toBe('done');
    expect(getWorkItem(itemB.item_id)?.status).toBe('done');
  });
});
