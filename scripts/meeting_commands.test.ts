import { describe, expect, it, vi } from 'vitest';
import {
  parseMeetingCommand,
  runMeetingCommand,
  type MeetingCommandContext,
} from './meeting_commands.js';

function testContext(overrides: Partial<MeetingCommandContext> = {}): {
  context: MeetingCommandContext;
  outputs: string[];
  traces: Array<{ event: string; detail?: Record<string, unknown> }>;
} {
  const outputs: string[] = [];
  const traces: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  return {
    outputs,
    traces,
    context: {
      getSession: () => null,
      allowAdmit: false,
      onOutput: (message: string) => {
        outputs.push(message);
      },
      onTrace: (event: string, detail?: Record<string, unknown>) => {
        traces.push({ event, detail });
      },
      ...overrides,
    },
  };
}

describe('parseMeetingCommand', () => {
  it('parses known verbs and flags blanks', () => {
    expect(parseMeetingCommand('')).toBeNull();
    expect(parseMeetingCommand('  ')).toBeNull();
    expect(parseMeetingCommand('help')).toEqual({ verb: 'help' });
    expect(parseMeetingCommand('STATUS')).toEqual({ verb: 'status' });
    expect(parseMeetingCommand('raise-hand')).toEqual({ verb: 'raise-hand' });
    expect(parseMeetingCommand('admit')).toEqual({ verb: 'admit' });
    expect(parseMeetingCommand('admit Taro Yamada')).toEqual({
      verb: 'admit',
      name: 'Taro Yamada',
    });
    expect(parseMeetingCommand('chat hello all')).toEqual({ verb: 'chat', text: 'hello all' });
    expect(parseMeetingCommand('quit')).toEqual({ verb: 'leave' });
    expect(parseMeetingCommand('dance')).toEqual({ verb: 'unknown', raw: 'dance' });
    expect(parseMeetingCommand('chat   ')).toEqual({ verb: 'unknown', raw: 'chat' });
  });
});

describe('runMeetingCommand', () => {
  it('refuses admit without the host-authority flag', async () => {
    const { context, outputs, traces } = testContext();
    const end = await runMeetingCommand(null, { verb: 'admit', name: 'Taro' }, context);
    expect(end).toBe(false);
    expect(outputs.join('\n')).toContain('--allow-admit');
    expect(traces.map((entry) => entry.event)).toContain('meeting_participation.admit_refused');
  });

  it('reports unsupported verbs per driver instead of failing', async () => {
    const { context, outputs } = testContext({
      getSession: () =>
        ({ state: { session_id: 's', platform: 'meet', status: 'in_meeting' } }) as any,
    });
    expect(await runMeetingCommand({} as any, { verb: 'raise-hand' }, context)).toBe(false);
    expect(outputs.join('\n')).toContain('not supported by this driver');
  });

  it('drives raise-hand, admit, chat, and leave through the session', async () => {
    const raiseHand = vi.fn(async () => ({ already: false }));
    const admit = vi.fn(async () => ({ admitted: 2 }));
    const chat = vi.fn(async () => undefined);
    const leave = vi.fn(async () => undefined);
    const session = {
      state: { session_id: 's', platform: 'meet', status: 'in_meeting' },
      raiseHand,
      admit,
      chat,
      leave,
    } as any;
    const { context, outputs, traces } = testContext({
      getSession: () => session,
      allowAdmit: true,
    });

    await runMeetingCommand(session, { verb: 'raise-hand' }, context);
    await runMeetingCommand(session, { verb: 'admit', name: 'Taro' }, context);
    await runMeetingCommand(session, { verb: 'chat', text: 'hi' }, context);
    expect(raiseHand).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith('Taro');
    expect(chat).toHaveBeenCalledWith('hi');
    expect(outputs.join('\n')).toContain('hand raised');
    expect(outputs.join('\n')).toContain('admitted 2');
    expect(traces.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        'meeting_participation.raise_hand',
        'meeting_participation.admit',
        'meeting_participation.chat',
      ])
    );

    const end = await runMeetingCommand(session, { verb: 'leave' }, context);
    expect(end).toBe(true);
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('handles no-session commands without throwing', async () => {
    const { context, outputs } = testContext();
    expect(await runMeetingCommand(null, { verb: 'status' }, context)).toBe(false);
    expect(await runMeetingCommand(null, { verb: 'raise-hand' }, context)).toBe(false);
    expect(outputs).toContain('not joined yet');
  });
});
