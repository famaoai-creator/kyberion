import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  runEffect,
  missionControllerArgs,
  deckChildEnv,
  setOperatorBaseRole,
  runningFromSource,
  type EffectDeps,
} from './effects.js';
import { approvalSpec, attachSpec, createHandoffRunner, type HandoffIo } from './handoff.js';

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

  it('keeps option-looking values from being read as herdr flags', async () => {
    const d = deps();
    await runEffect({ op: 'agentPrompt', target: 'p1', text: '--wait now' }, d);
    const run = d.run as ReturnType<typeof vi.fn>;
    expect(run.mock.calls[0]![1]).toEqual(['agent', 'prompt', 'p1', ' --wait now']);
    for (const request of [
      { op: 'agentPrompt' as const, target: '--help', text: 'hi' },
      { op: 'agentInterrupt' as const, target: '-x' },
      { op: 'mission' as const, verb: 'pause' as const, missionId: '--all' },
    ]) {
      expect(await runEffect(request, d)).toMatchObject({ ok: false });
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs mission lifecycle verbs through mission_controller', async () => {
    const d = deps({ run: vi.fn(async () => ({ ok: false, output: 'locked' })) });
    const result = await runEffect({ op: 'mission', verb: 'pause', missionId: 'M1' }, d);
    expect(result).toEqual({ ok: false, message: 'locked' });
    const args = (d.run as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
    // vitest runs this module from source, so the source entry is used.
    expect(args.slice(0, 3).join(' ')).toMatch(/mission_controller\.ts$/);
    expect(args.slice(3)).toEqual(['pause', 'M1']);
    expect(d.audit).toHaveBeenCalledWith('mission_pause', result, { missionId: 'M1' });
  });
});

describe('child env', () => {
  it("gives children the operator's base role, not the deck's sovereign read role", () => {
    const saved = process.env.KYBERION_BASE_ROLE;
    process.env.KYBERION_BASE_ROLE = 'sovereign';
    try {
      setOperatorBaseRole('worker');
      expect(deckChildEnv().KYBERION_BASE_ROLE).toBe('worker');
      setOperatorBaseRole(undefined);
      // '' = no base role, and it overrides anything inherited
      expect(deckChildEnv().KYBERION_BASE_ROLE).toBe('');
      expect(deckChildEnv()).not.toHaveProperty('KYBERION_PERSONA');
    } finally {
      if (saved === undefined) delete process.env.KYBERION_BASE_ROLE;
      else process.env.KYBERION_BASE_ROLE = saved;
      setOperatorBaseRole(undefined);
    }
  });
});

describe('missionControllerArgs', () => {
  it('runs the source mission_controller when the deck runs from source', () => {
    expect(runningFromSource('file:///x/effects.ts')).toBe(true);
    expect(runningFromSource('file:///x/effects.js')).toBe(false);
    const fromSource = missionControllerArgs('pause', 'M1', undefined, true);
    expect(fromSource[0]).toBe('--import');
    expect(fromSource[1]).toMatch(/^file:.*ts-loader\.mjs$/);
    expect(fromSource[2]).toMatch(/scripts[\\/]mission_controller\.ts$/);
    expect(fromSource.slice(3)).toEqual(['pause', 'M1']);
    const built = missionControllerArgs('pause', 'M1', undefined, false);
    expect(built[0]).toMatch(/dist[\\/]scripts[\\/]mission_controller\.js$/);
  });

  it('passes the deck as checkpoint actor with a default note', () => {
    expect(missionControllerArgs('checkpoint', 'M1', undefined, false).slice(1)).toEqual([
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

describe('runHandoff', () => {
  function io(order: string[], exitCode = 0) {
    const child = new EventEmitter();
    const spawn = vi.fn((_command: string, _args: string[], options: { env?: object }) => {
      order.push('spawn');
      setTimeout(() => child.emit('exit', exitCode), 0);
      return Object.assign(child, { options });
    });
    const value: HandoffIo = {
      spawn: spawn as unknown as HandoffIo['spawn'],
      stdin: { pause: () => (order.push('pause'), undefined) as never },
      write: () => undefined,
    };
    return { value, spawn };
  }

  it('pauses the deck stdin before the child takes the terminal', async () => {
    const order: string[] = [];
    const { value, spawn } = io(order);
    setOperatorBaseRole('analyst');
    try {
      expect(await createHandoffRunner(value)(attachSpec('p1', 'banner'))).toBe(0);
    } finally {
      setOperatorBaseRole(undefined);
    }
    expect(order).toEqual(['pause', 'spawn']);
    const options = spawn.mock.calls[0]![2] as { env: Record<string, string>; stdio: string };
    expect(options.stdio).toBe('inherit');
    expect(options.env.KYBERION_BASE_ROLE).toBe('analyst');
  });

  it('refuses a target or request id that looks like an option', async () => {
    const order: string[] = [];
    const { value, spawn } = io(order);
    expect(await createHandoffRunner(value)(attachSpec('--help', 'b'))).toBeNull();
    expect(await createHandoffRunner(value)(approvalSpec('-x', 'approve', 'b'))).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });
});
