import { describe, expect, it, vi } from 'vitest';
import { runEffect, missionControllerArgs, type EffectDeps } from './effects.js';
import { approvalSpec, attachSpec } from './handoff.js';

function deps(
  overrides: Partial<EffectDeps> = {}
): EffectDeps & { audit: ReturnType<typeof vi.fn> } {
  const audit = vi.fn();
  return {
    run: vi.fn(async () => ({ ok: true, output: 'line one\nsent\n' })),
    converse: vi.fn(async () => ({
      text: '  done  ',
      intentResolution: {
        normalized_intent: 'summarise PR',
        resolution_shape: 'task_session',
        next_action: { label: 'run review' },
      },
    })) as unknown as EffectDeps['converse'],
    enqueue: vi.fn(async () => ({ id: 'q-1' })) as unknown as EffectDeps['enqueue'],
    ...overrides,
    audit,
  } as EffectDeps & { audit: ReturnType<typeof vi.fn> };
}

describe('runEffect', () => {
  it('asks through the surface conversation and returns the intent summary', async () => {
    const d = deps();
    const result = await runEffect(
      { op: 'ask', text: 'summarise', threadTs: 't1', locale: 'ja' },
      d
    );
    expect(result).toEqual({
      ok: true,
      message: 'done',
      intent: {
        understood: 'summarise PR',
        shape: 'task_session',
        next: 'run review',
        missing: [],
      },
    });
    const call = (d.converse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call).toMatchObject({
      text: 'summarise',
      threadTs: 't1',
      locale: 'ja',
      channel: 'mission-deck',
    });
    expect(d.audit).toHaveBeenCalledWith('ask', expect.objectContaining({ ok: true }));
  });

  it('reports a conversation failure instead of throwing', async () => {
    const d = deps({
      converse: vi.fn(async () => {
        throw new Error('backend down');
      }) as unknown as EffectDeps['converse'],
    });
    await expect(runEffect({ op: 'ask', text: 'x', threadTs: 't' }, d)).resolves.toEqual({
      ok: false,
      message: 'backend down',
    });
    expect(d.audit).toHaveBeenCalledWith('ask', { ok: false, message: 'backend down' });
  });

  it('queues a steer through the agent input queue', async () => {
    const d = deps();
    const result = await runEffect(
      { op: 'steer', missionId: 'M1', text: 'focus tests', delivery: 'steer', tier: 'public' },
      d
    );
    expect(result).toEqual({ ok: true, message: 'q-1' });
    expect(d.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'M1',
        delivery: 'steer',
        text: 'focus tests',
        tier: 'public',
      })
    );
    expect(d.audit).toHaveBeenCalledWith('steer', expect.anything(), {
      missionId: 'M1',
      delivery: 'steer',
    });
  });

  it('prompts and interrupts herdr agents with bounded commands', async () => {
    const d = deps();
    expect(await runEffect({ op: 'agentPrompt', target: 'p1', text: 'hi' }, d)).toEqual({
      ok: true,
      message: 'sent',
    });
    await runEffect({ op: 'agentInterrupt', target: 'p1' }, d);
    const run = d.run as ReturnType<typeof vi.fn>;
    expect(run.mock.calls[0]![1]).toEqual(['agent', 'prompt', 'p1', 'hi']);
    expect(run.mock.calls[1]![1]).toEqual(['agent', 'send-keys', 'p1', 'esc']);
    expect(d.audit).toHaveBeenCalledWith('agent_interrupt', expect.anything(), { target: 'p1' });
  });

  it('runs mission lifecycle verbs through mission_controller', async () => {
    const d = deps({ run: vi.fn(async () => ({ ok: false, output: 'locked' })) });
    const result = await runEffect({ op: 'mission', verb: 'pause', missionId: 'M1' }, d);
    expect(result).toEqual({ ok: false, message: 'locked' });
    const args = (d.run as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
    expect(args[0]).toMatch(/mission_controller\.js$/);
    expect(args.slice(1)).toEqual(['pause', 'M1']);
    expect(d.audit).toHaveBeenCalledWith('mission_pause', result, { missionId: 'M1' });
  });
});

describe('missionControllerArgs', () => {
  it('passes the deck as checkpoint actor with a default note', () => {
    expect(missionControllerArgs('checkpoint', 'M1').slice(1)).toEqual([
      'checkpoint',
      'M1',
      'mission-deck',
      'checkpoint from mission deck',
    ]);
  });
});

describe('handoff specs', () => {
  it('hands approvals to the governed approvals CLI', () => {
    const spec = approvalSpec('req-1', 'deny', 'banner');
    expect(spec.kind).toBe('approval');
    expect(spec.args.slice(1)).toEqual(['approvals', '--deny', 'req-1']);
    expect(spec.args[0]).toMatch(/kyberion_cli_entry\.mjs$/);
  });
  it('attaches to a herdr agent', () => {
    expect(attachSpec('p1', 'b').args).toEqual(['agent', 'attach', 'p1']);
  });
});
