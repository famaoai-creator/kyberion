import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContextAsync, withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import { publishDiscussionOutcomes } from './discussion-outcomes.js';
import { ensureDiscussionRunning } from './discussion-engine.js';
import {
  appendDiscussionEvent,
  claimDiscussionProviderExecution,
  createDiscussionRoom,
  normalizeDiscussionConfig,
  readDiscussionRoom,
  submitDiscussionCommand,
} from './discussion-store.js';
import { ReasoningDiscussionSpeaker } from './discussion-speaker.js';
import { reduceDiscussionRoom, summarizeDiscussionRoom } from './discussion-reducer.js';
import { getReasoningPayloadScope } from '../reasoning/reasoning-egress-scope.js';
import type { DiscussionConfig } from './discussion-types.js';

const transport = vi.hoisted(() => ({ generate: vi.fn(), resolve: vi.fn(), egress: vi.fn() }));
vi.mock('../reasoning/reasoning-egress-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../reasoning/reasoning-egress-scope.js')>()),
  assertReasoningEgressAllowed: transport.egress,
}));
vi.mock('../provider/isolated-text-generator.js', () => ({
  resolveIsolatedTextGenerator: transport.resolve,
}));
vi.mock('./discussion-outcomes.js', () => ({ publishDiscussionOutcomes: vi.fn() }));
vi.mock('./discussion-team.js', () => ({
  discussionRosterCandidates: () => ['planner', 'reviewer'],
  composeDiscussionTeam: () => ({
    participants: [
      'facilitator',
      'researcher',
      'devils_advocate',
      'scribe',
      'planner',
      'reviewer',
    ].map((role) => ({
      id: role,
      role,
      agent_id: role,
      name: role,
      rationale: 'fixture',
      fit: 1,
      capabilities: [],
    })),
    gaps: [],
    roster_source: 'llm',
  }),
}));
const ids: string[] = [];
const ROLE = 'chronos_localadmin';
const noSleep = async () => undefined;
function room(config: Partial<DiscussionConfig> = {}) {
  const id = 'test-disc-truth-' + randomUUID().slice(0, 8);
  ids.push(id);
  withExecutionContext(ROLE, () =>
    createDiscussionRoom({
      id,
      goal: 'Choose a plan',
      config: {
        speaker: 'reasoning',
        provider: 'claude',
        max_rounds: 1,
        max_provider_calls: 9,
        provider_timeout_ms: 1000,
        turn_delay_ms: 0,
        locale: 'en',
        ...config,
      },
    })
  );
  return id;
}
function run(id: string) {
  return withExecutionContextAsync(ROLE, () =>
    ensureDiscussionRunning(id, { sleep: noSleep, exitWhenIdle: true })
  );
}
function resultFor(label: string) {
  if (label.endsWith('roster')) return { roles: ['planner', 'reviewer'] };
  if (label.endsWith('summary'))
    return { summary: 'Observed summary', open_issues: [], agreements: ['Plan'] };
  if (label.endsWith('decision'))
    return {
      summary: 'Observed decision',
      agreements: ['Plan'],
      dissent: [],
      next_steps: ['Do it'],
    };
  if (label.includes('dialogue'))
    return {
      text: 'What is the goal?',
      suggestions: [],
      goal_patch: {},
      resolve: [],
      new_questions: [],
      consult: [],
    };
  return { text: 'Observed contribution', performative: 'inform', stance: 'support' };
}
beforeEach(() => {
  vi.mocked(publishDiscussionOutcomes).mockClear();
  transport.egress.mockReset();
  transport.generate
    .mockReset()
    .mockImplementation(async (input) => input.schema.parse(resultFor(input.metricsLabel)));
  transport.resolve.mockReset().mockImplementation((id) => ({
    id,
    reasoningBackend: id === 'claude' ? 'claude-agent' : 'codex-cli',
    isolation: 'structural',
    versionGated: false,
    generate: transport.generate,
  }));
});
afterEach(() => {
  vi.useRealTimers();
  withExecutionContext('mission_controller', () => {
    for (const id of ids.splice(0))
      safeRmSync(pathResolver.shared('runtime/discussions/' + id), {
        recursive: true,
        force: true,
      });
  });
});

describe('truthful bounded discussion providers', () => {
  it('preserves the single-model brief flag in room summaries without relabeling panels or legacy rooms', () => {
    const briefId = room({ single_pass: true, speaker: 'scripted' });
    const panelId = room({ speaker: 'scripted' });
    expect(summarizeDiscussionRoom(readDiscussionRoom(briefId)!)).toMatchObject({
      mode: 'panel',
      single_pass: true,
    });
    expect(summarizeDiscussionRoom(readDiscussionRoom(panelId)!).single_pass).toBe(false);
    expect(summarizeDiscussionRoom(reduceDiscussionRoom('legacy', [])).single_pass).toBe(false);
    expect(transport.generate).not.toHaveBeenCalled();
  });

  it('creates a single-model brief with one provider invocation and no synthetic panel transcript', async () => {
    const id = room({ single_pass: true, max_provider_calls: 32, max_rounds: 8 });
    await run(id);
    const state = readDiscussionRoom(id)!;
    expect(state.status).toBe('concluded');
    expect(state.config).toMatchObject({ max_rounds: 1, max_provider_calls: 1 });
    expect(state.participants.map((p) => p.role)).toEqual(['facilitator']);
    expect(state.messages).toHaveLength(0);
    expect(state.execution).toMatchObject({
      actual_mode: 'reasoning',
      provider: 'claude',
      model: null,
      call_budget: 1,
      internal_turn_limit: 3,
    });
    expect(transport.generate).toHaveBeenCalledTimes(1);
    expect(transport.generate.mock.calls[0][0].metricsLabel).toBe('discussion:decision');
    expect(transport.generate.mock.calls[0][0].userPrompt).toContain('Choose a plan');
    expect(transport.generate.mock.calls[0][0].systemPrompt).not.toContain('Choose a plan');
  });

  it('shows the single facilitator actively generating while the sole call is pending', async () => {
    let finish!: () => void;
    transport.generate.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          finish = () => resolve(input.schema.parse(resultFor(input.metricsLabel)));
        })
    );
    const id = room({ single_pass: true });
    const pending = run(id);
    await vi.waitFor(() => expect(transport.generate).toHaveBeenCalledTimes(1));
    expect(readDiscussionRoom(id)).toMatchObject({
      status: 'running',
      phase: 'converging',
      speaking: 'facilitator',
      messages: [],
    });
    finish();
    await pending;
    expect(readDiscussionRoom(id)).toMatchObject({ status: 'concluded', speaking: null });
  });

  it('applies room-scoped confidential egress policy before any provider invocation', async () => {
    let observed: unknown;
    transport.egress.mockImplementation(() => {
      observed = getReasoningPayloadScope();
      throw new Error('private policy details');
    });
    const id = room({ single_pass: true });
    await run(id);
    const state = readDiscussionRoom(id)!;
    expect(observed).toMatchObject({
      tier: 'confidential',
      training_use: 'zero_retention',
      purpose: 'discussion:decision',
    });
    expect(state.error).toContain('EGRESS_DENIED');
    expect(state.error).not.toContain('private policy');
    expect(state.execution?.attempts).toHaveLength(0);
    expect(transport.generate).not.toHaveBeenCalled();
  });

  it('rejects invalid numeric config and clamps room-lifetime hard limits', () => {
    expect(
      normalizeDiscussionConfig({ speaker: 'scripted', single_pass: true }).max_provider_calls
    ).toBe(0);
    expect(
      normalizeDiscussionConfig({ max_provider_calls: 999, provider_timeout_ms: 999999 })
    ).toMatchObject({ max_provider_calls: 32, provider_timeout_ms: 60000 });
    for (const value of [NaN, Infinity, 0, -1, 1.5])
      expect(() => normalizeDiscussionConfig({ max_provider_calls: value })).toThrow();
    expect(() => normalizeDiscussionConfig({ single_pass: true, mode: 'dialogue' })).toThrow();
  });

  it('rejects reasoning without an explicit provider rather than succeeding with stub/scripted prose', async () => {
    const id = room({ provider: undefined });
    await run(id);
    expect(readDiscussionRoom(id)?.status).toBe('failed');
    expect(readDiscussionRoom(id)?.decision).toBeNull();
    expect(transport.generate).not.toHaveBeenCalled();
  });

  it('does not silently turn auto into scripted', async () => {
    const id = room({ speaker: 'auto', provider: undefined });
    await run(id);
    expect(readDiscussionRoom(id)?.status).toBe('failed');
    expect(readDiscussionRoom(id)?.messages).toHaveLength(0);
  });

  it('runs exactly nine isolated calls for six seats and preserves provider/model truth', async () => {
    const id = room();
    await run(id);
    const state = readDiscussionRoom(id)!;
    expect(state.status).toBe('concluded');
    expect(transport.generate).toHaveBeenCalledTimes(9);
    expect(state.execution).toMatchObject({
      actual_mode: 'reasoning',
      requested_provider: 'claude',
      provider: 'claude',
      model: null,
      call_budget: 9,
    });
    expect(state.execution?.attempts).toHaveLength(9);
    expect(state.execution?.attempts.every((a) => a.status === 'succeeded')).toBe(true);
    expect(
      transport.generate.mock.calls.every(([input]) => input.allowUntestedVersion !== true)
    ).toBe(true);
  });

  it('fails on the first provider error without scripted substitution or raw error disclosure', async () => {
    transport.generate.mockRejectedValue(
      new Error('private provider stderr and credential details')
    );
    const id = room();
    await run(id);
    const state = readDiscussionRoom(id)!;
    expect(state.status).toBe('failed');
    expect(state.messages).toHaveLength(0);
    expect(state.decision).toBeNull();
    expect(state.execution?.provider).toBeNull();
    expect(state.execution?.attempts).toMatchObject([{ status: 'failed' }]);
    expect(state.error).not.toContain('private provider');
    expect(transport.generate).toHaveBeenCalledTimes(1);
  });

  it('persists and exhausts the lifetime budget, including extra human commands', async () => {
    const id = room({ max_provider_calls: 9 });
    withExecutionContext(ROLE, () =>
      submitDiscussionCommand(id, 'human', {
        kind: 'ask',
        text: 'Consider costs',
        target: 'researcher',
      })
    );
    await run(id);
    expect(transport.generate).toHaveBeenCalledTimes(9);
    expect(readDiscussionRoom(id)?.status).toBe('failed');
    expect(readDiscussionRoom(id)?.decision).toBeNull();
    expect(readDiscussionRoom(id)?.error).toContain('BUDGET');
    await run(id);
    expect(transport.generate).toHaveBeenCalledTimes(9);
  });

  it('captures provider resolver/constructor failures as a durable failed room', async () => {
    transport.resolve.mockImplementation(() => {
      throw new Error('secret resolver internals');
    });
    const id = room();
    await expect(run(id)).resolves.toBeUndefined();
    expect(readDiscussionRoom(id)?.status).toBe('failed');
    expect(readDiscussionRoom(id)?.error).not.toContain('secret resolver');
  });

  it('keeps explicit scripted rooms visibly scripted and legacy provenance unknown', async () => {
    const id = room({ speaker: 'scripted', provider: undefined, max_provider_calls: 0 });
    await run(id);
    expect(readDiscussionRoom(id)?.execution).toMatchObject({
      actual_mode: 'scripted',
      provider: null,
      model: null,
      call_budget: 0,
      attempts: [],
    });
    expect(transport.generate).not.toHaveBeenCalled();
    expect(reduceDiscussionRoom('legacy', []).execution).toBeNull();
  });

  it('does not retry a panel with a persisted interrupted attempt after restart', async () => {
    const id = room();
    withExecutionContext(ROLE, () => {
      appendDiscussionEvent(id, {
        type: 'execution_initialized',
        execution: {
          requested_mode: 'reasoning',
          actual_mode: 'reasoning',
          requested_provider: 'claude',
          provider: null,
          model: null,
          call_budget: 9,
          timeout_ms: 1000,
          internal_turn_limit: 3,
        },
      });
      appendDiscussionEvent(id, {
        type: 'provider_call_started',
        id: 'call-1',
        operation: 'roster',
        provider: 'claude',
      });
    });
    await run(id);
    expect(readDiscussionRoom(id)?.status).toBe('failed');
    expect(readDiscussionRoom(id)?.error).toContain('RESTART');
    expect(readDiscussionRoom(id)?.execution?.attempts).toHaveLength(1);
    expect(transport.generate).not.toHaveBeenCalled();
  });

  it('allows only one session to claim a room even before any call receipt exists', async () => {
    const id = room({ single_pass: true });
    const snapshot = readDiscussionRoom(id)!;
    let first!: ReasoningDiscussionSpeaker;
    withExecutionContext(ROLE, () => {
      first = new ReasoningDiscussionSpeaker(snapshot);
      expect(() => new ReasoningDiscussionSpeaker(snapshot)).toThrow(/RESTART_REQUIRED/);
    });
    const facilitator = {
      id: 'facilitator',
      role: 'facilitator',
      agent_id: 'fixture',
      name: 'Fixture',
      rationale: 'fixture',
      fit: 1,
      capabilities: [],
    };
    await withExecutionContextAsync(ROLE, () =>
      first.conclude({ room: snapshot, participant: facilitator, intent: 'conclude' })
    );
    expect(transport.generate).toHaveBeenCalledTimes(1);
    expect(readDiscussionRoom(id)?.execution?.attempts).toHaveLength(1);
  });

  it('fails closed when a prior permanent claim survives but execution receipts are absent', async () => {
    const id = room({ single_pass: true });
    withExecutionContext(ROLE, () => claimDiscussionProviderExecution(id));
    await run(id);
    const state = readDiscussionRoom(id)!;
    expect(state.status).toBe('failed');
    expect(state.error).toContain('outcome may be unknown');
    expect(state.execution).toBeNull();
    expect(transport.generate).not.toHaveBeenCalled();
  });

  it('rejects malformed provider output without manufacturing a successful contribution', async () => {
    transport.generate.mockResolvedValue({
      summary: '',
      agreements: [],
      dissent: [],
      next_steps: [],
    });
    const id = room({ single_pass: true });
    await run(id);
    expect(readDiscussionRoom(id)?.status).toBe('failed');
    expect(readDiscussionRoom(id)?.decision).toBeNull();
    expect(readDiscussionRoom(id)?.execution?.provider).toBeNull();
    expect(transport.generate).toHaveBeenCalledTimes(1);
  });

  it.each(['succeeded', 'failed', 'timed_out'] as const)(
    'fails closed at a dialogue restart after an uncommitted %s call',
    async (status) => {
      const id = room({ mode: 'dialogue' });
      withExecutionContext(ROLE, () => {
        appendDiscussionEvent(id, {
          type: 'execution_initialized',
          execution: {
            requested_mode: 'reasoning',
            actual_mode: 'reasoning',
            requested_provider: 'claude',
            provider: null,
            model: null,
            call_budget: 9,
            timeout_ms: 1000,
            internal_turn_limit: 3,
          },
        });
        appendDiscussionEvent(id, {
          type: 'provider_call_started',
          id: 'call-cut',
          operation: 'dialogue-open',
          provider: 'claude',
        });
        appendDiscussionEvent(id, { type: 'provider_call_finished', id: 'call-cut', status });
      });
      await run(id);
      expect(readDiscussionRoom(id)?.status).toBe('failed');
      expect(readDiscussionRoom(id)?.error).toContain('RESTART_REQUIRED');
      expect(readDiscussionRoom(id)?.execution?.attempts).toHaveLength(1);
      expect(transport.generate).not.toHaveBeenCalled();
    }
  );

  it('keeps Codex model and internal-turn count unknown without relaxing its version gate', async () => {
    const id = room({ single_pass: true, provider: 'codex' });
    await run(id);
    expect(readDiscussionRoom(id)?.execution).toMatchObject({
      provider: 'codex',
      model: null,
      internal_turn_limit: null,
    });
    expect(transport.resolve).toHaveBeenCalledWith('codex');
    expect(transport.generate.mock.calls[0][0].allowUntestedVersion).toBeUndefined();
  });

  it('aborts an active provider invocation on a human stop command without retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let aborted = false;
    transport.generate.mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          input.abortController.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('stop'));
            },
            { once: true }
          );
        })
    );
    const id = room({ single_pass: true });
    const pending = run(id);
    await vi.advanceTimersByTimeAsync(10);
    withExecutionContext(ROLE, () => {
      submitDiscussionCommand(id, 'human', { kind: 'stop' });
      submitDiscussionCommand(id, 'human', { kind: 'stop' });
    });
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(aborted).toBe(true);
    expect(readDiscussionRoom(id)?.status).toBe('stopped');
    expect(readDiscussionRoom(id)?.pending_commands).toHaveLength(0);
    expect(readDiscussionRoom(id)?.error).toBeUndefined();
    expect(publishDiscussionOutcomes).not.toHaveBeenCalled();
    expect(readDiscussionRoom(id)?.decision).toBeNull();
    expect(readDiscussionRoom(id)?.execution?.attempts).toMatchObject([{ status: 'aborted' }]);
    expect(transport.generate).toHaveBeenCalledTimes(1);
  });

  it('discards a single-pass response when stop arrives before the next abort poll', async () => {
    const id = room({ single_pass: true });
    transport.generate.mockImplementation(async (input) => {
      withExecutionContext(ROLE, () => submitDiscussionCommand(id, 'human', { kind: 'stop' }));
      return input.schema.parse(resultFor(input.metricsLabel));
    });
    await run(id);
    expect(readDiscussionRoom(id)).toMatchObject({
      status: 'stopped',
      decision: null,
      pending_commands: [],
    });
    expect(readDiscussionRoom(id)?.execution?.attempts).toMatchObject([{ status: 'aborted' }]);
    expect(publishDiscussionOutcomes).not.toHaveBeenCalled();
    expect(transport.generate).toHaveBeenCalledTimes(1);
  });

  it('preserves a genuine provider failure even if a stop command is also pending', async () => {
    const id = room({ single_pass: true });
    transport.generate.mockImplementation(async () => {
      withExecutionContext(ROLE, () => submitDiscussionCommand(id, 'human', { kind: 'stop' }));
      throw new Error('actual private provider failure');
    });
    await run(id);
    expect(readDiscussionRoom(id)?.status).toBe('failed');
    expect(readDiscussionRoom(id)?.error).toContain('DISCUSSION_PROVIDER_FAILED');
    expect(readDiscussionRoom(id)?.execution?.attempts).toMatchObject([{ status: 'failed' }]);
    expect(publishDiscussionOutcomes).not.toHaveBeenCalled();
    expect(transport.generate).toHaveBeenCalledTimes(1);
  });

  it('aborts the underlying invocation on timeout and never starts another call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let aborted = false;
    transport.generate.mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          input.abortController.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true }
          );
        })
    );
    const id = room();
    const pending = run(id);
    await vi.advanceTimersByTimeAsync(1100);
    await pending;
    expect(aborted).toBe(true);
    expect(transport.generate).toHaveBeenCalledTimes(1);
    expect(readDiscussionRoom(id)?.status).toBe('failed');
    expect(readDiscussionRoom(id)?.execution?.attempts).toMatchObject([{ status: 'timed_out' }]);
  });
});
