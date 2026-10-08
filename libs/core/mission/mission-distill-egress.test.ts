import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

/**
 * Distill sends the mission state and evidence to an LLM. Above `public`, a
 * provider must clear the tier egress gate (provider-egress-policy.json)
 * before it sees that content; a denied provider is never invoked and
 * distillation falls back to the structural (no-LLM) path.
 */

const hoisted = vi.hoisted(() => ({ missionPath: '', llmCalls: [] as string[] }));

// The real adaptive loop and egress gate run; only the policy and command
// availability are pinned so the verdict does not depend on locally
// installed CLIs. `claude` is declared training_use 'unknown' in the shipped
// provider-egress-policy.json, and no tenant attests it here.
vi.mock('./mission-llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mission-llm.js')>();
  return {
    ...actual,
    runAdaptiveStructuredLlmProfile: <T>(
      purpose: string,
      prompt: string,
      schema: ZodType<T>,
      options: Parameters<typeof actual.runAdaptiveStructuredLlmProfile>[3] = {}
    ) =>
      actual.runAdaptiveStructuredLlmProfile<T>(purpose, prompt, schema, {
        ...options,
        policy: {
          default_profile: 'claude',
          profiles: { claude: { command: 'claude', args: [], adapter: 'distill-egress-claude' } },
        },
        isCommandAvailable: () => ({ available: true }),
      }),
  };
});
vi.mock('../ops-alert.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../knowledge/memory-promotion-queue.js', () => ({
  enqueueMemoryPromotionCandidate: vi.fn(),
}));
vi.mock('../path-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../path-resolver.js')>();
  return { ...actual, findMissionPath: vi.fn(() => hoisted.missionPath) };
});
vi.mock('../ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ledger.js')>();
  return { ...actual, ledger: { ...actual.ledger, record: vi.fn() } };
});

import * as pathResolver from '../path-resolver.js';
import { withExecutionContext } from '../authority.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { registerStructuredRunner } from './mission-llm.js';
import { distillMission } from './mission-distill.js';
import { loadState } from './mission-state.js';

const MISSION_ID = 'MSN-DISTILL-EGRESS-001';
hoisted.missionPath = pathResolver.shared(`tmp/mission-distill-egress-${process.pid}`);

function writeMissionState(tier: 'public' | 'confidential'): void {
  withExecutionContext('ecosystem_architect', () => {
    safeRmSync(hoisted.missionPath, { recursive: true, force: true });
    safeMkdir(hoisted.missionPath, { recursive: true });
    safeWriteFile(
      `${hoisted.missionPath}/mission-state.json`,
      JSON.stringify({
        mission_id: MISSION_ID,
        tier,
        status: 'distilling',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'worker',
        confidence_score: 1,
        git: { branch: 'test', start_commit: 'abc123', latest_commit: 'abc123', checkpoints: [] },
        history: [{ ts: '2026-10-08T00:00:00.000Z', event: 'VERIFY', note: 'ready' }],
      })
    );
  });
}

async function runDistill(): Promise<void> {
  const previousRole = process.env.MISSION_ROLE;
  const previousPersona = process.env.KYBERION_PERSONA;
  process.env.MISSION_ROLE = 'ecosystem_architect';
  process.env.KYBERION_PERSONA = 'ecosystem_architect';
  try {
    await distillMission(MISSION_ID, pathResolver.rootDir());
  } finally {
    if (previousRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = previousRole;
    if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = previousPersona;
  }
}

describe('distillMission provider egress gate', () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    hoisted.llmCalls.length = 0;
    dispose = registerStructuredRunner('distill-egress-claude', async ({ prompt }) => {
      hoisted.llmCalls.push(prompt);
      return {
        title: 'LLM wisdom',
        category: 'Operations',
        tags: ['llm'],
        importance: 3,
        sections: {
          summary: 'llm summary',
          key_learnings: [],
          patterns_discovered: [],
          failures_and_recoveries: [],
          reusable_artifacts: [],
        },
      };
    });
  });

  afterEach(() => {
    dispose?.();
  });

  afterAll(() => {
    withExecutionContext('ecosystem_architect', () => {
      safeRmSync(hoisted.missionPath, { recursive: true, force: true });
    });
  });

  it('does not send a confidential mission to a non-attested provider and falls back to structural', async () => {
    writeMissionState('confidential');
    await runDistill();

    expect(hoisted.llmCalls).toEqual([]);
    expect(loadState(MISSION_ID)?.distillation).toMatchObject({
      mode: 'structural',
      llm_used: false,
    });
  });

  it('still sends a public mission to the provider', async () => {
    writeMissionState('public');
    await runDistill();

    expect(hoisted.llmCalls).toHaveLength(1);
    expect(hoisted.llmCalls[0]).toContain(MISSION_ID);
    expect(loadState(MISSION_ID)?.distillation).toMatchObject({ mode: 'llm', llm_used: true });
  });
});
