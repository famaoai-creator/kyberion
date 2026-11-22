import { describe, expect, it, vi } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { runSystemCommand } from './cli-system.js';

interface ExecCall {
  args: string[];
  input: Record<string, unknown>;
}

const execCalls: ExecCall[] = [];

// Intercept only safeExec: the input file is still written for real so the
// mock can read back exactly the ADF the actuator would receive.
vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  return {
    ...actual,
    safeExec: vi.fn((_cmd: string, args: string[]) => {
      const inputPath = args[args.indexOf('--input') + 1];
      execCalls.push({
        args,
        input: JSON.parse(String(safeReadFile(inputPath, { encoding: 'utf8' }))),
      });
      return JSON.stringify({ results: [{ status: 'success' }] });
    }),
  };
});

function capture() {
  const lines: string[] = [];
  return { lines, print: (line: string) => lines.push(line) };
}

describe('pnpm kyberion system', () => {
  it('lists the system op vocabulary grouped by kind', async () => {
    const out = capture();
    await runSystemCommand(['ops'], out.print);
    const grouped = JSON.parse(out.lines.join('\n')) as Record<string, string[]>;
    expect(grouped.capture).toContain('screenshot');
    expect(grouped.capture).toContain('get_screen_size');
  });

  it('filters the vocabulary with --kind', async () => {
    const out = capture();
    await runSystemCommand(['ops', '--kind', 'control'], out.print);
    const grouped = JSON.parse(out.lines.join('\n')) as Record<string, string[]>;
    expect(Object.keys(grouped)).toEqual(['control']);
    expect(grouped.control).toContain('while');
  });

  it.each(['exec', 'shell', 'run_js', 'run_applescript', 'run_shortcut'])(
    "keeps raw-command op '%s' off the interactive surface",
    async (op) => {
      await expect(runSystemCommand([op], () => {})).rejects.toThrow(
        new RegExp(`op '${op}' is not exposed on this surface`)
      );
      expect(execCalls).toHaveLength(0);
    }
  );

  it.each(['if', 'while'])(
    "keeps pipeline flow-control op '%s' off the interactive surface",
    async (op) => {
      await expect(runSystemCommand([op], () => {})).rejects.toThrow(
        new RegExp(`op '${op}' is not exposed on this surface`)
      );
      expect(execCalls).toHaveLength(0);
    }
  );

  it('rejects an invalid --kind filter', async () => {
    await expect(runSystemCommand(['ops', '--kind', 'bogus'], () => {})).rejects.toThrow(
      /--kind must be capture\|transform\|apply\|control/
    );
  });

  it('rejects an unknown op without spawning the actuator', async () => {
    await expect(runSystemCommand(['not_an_op'], () => {})).rejects.toThrow(
      /op 'not_an_op' is not exposed/
    );
    expect(execCalls).toHaveLength(0);
  });

  it('wraps a capture op in a one-step pipeline the actuator accepts', async () => {
    const out = capture();
    await runSystemCommand(['get_screen_size'], out.print);
    expect(execCalls).toHaveLength(1);
    expect(execCalls.at(-1)!.input).toEqual({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'get_screen_size', params: {} }],
    });
    expect(out.lines.join('\n')).toContain('success');
  });

  it('parses --params JSON and scalar --key options into step params', async () => {
    await runSystemCommand(
      ['probe', '--params', '{"depth":2}', '--pattern', '"*.ts"', '--limit', '5'],
      () => {}
    );
    expect(execCalls.at(-1)!.input).toMatchObject({
      steps: [
        {
          type: 'capture',
          op: 'probe',
          params: { depth: 2, pattern: '*.ts', limit: 5 },
        },
      ],
    });
  });

  it('strips a redundant system: prefix from the op name', async () => {
    await runSystemCommand(['system:window_list'], () => {});
    expect(execCalls.at(-1)!.input).toMatchObject({
      steps: [{ op: 'window_list' }],
    });
  });

  it('routes interact through computer_interaction with session and target', async () => {
    await runSystemCommand(
      [
        'interact',
        'left_click',
        '--session',
        'S-1',
        '--target',
        '{"x":10,"y":20}',
        '--params',
        '{"double":true}',
      ],
      () => {}
    );
    expect(execCalls.at(-1)!.input).toEqual({
      version: '0.1',
      kind: 'computer_interaction',
      action: { type: 'left_click', double: true },
      session_id: 'S-1',
      target: { x: 10, y: 20 },
    });
  });

  it('never lets --params override the positional action type or top-level fields', async () => {
    await runSystemCommand(
      [
        'interact',
        'key',
        '--params',
        '{"type":"screenshot","session_id":"S-evil","target":{"x":1},"key":"Enter"}',
      ],
      () => {}
    );
    const input = execCalls.at(-1)!.input;
    expect(input).toEqual({
      version: '0.1',
      kind: 'computer_interaction',
      action: { type: 'key', key: 'Enter' },
    });
    expect(input.session_id).toBeUndefined();
    expect(input.target).toBeUndefined();
  });

  it('forwards --dry-run to the actuator invocation', async () => {
    await runSystemCommand(['window_list', '--dry-run'], () => {});
    expect(execCalls.at(-1)!.args).toContain('--dry-run');
  });

  it('fails closed on malformed --params and missing interact type', async () => {
    await expect(runSystemCommand(['probe', '--params', '[1]'], () => {})).rejects.toThrow(
      /--params must be a JSON object/
    );
    await expect(runSystemCommand(['interact'], () => {})).rejects.toThrow(/interact needs <type>/);
    await expect(runSystemCommand([], () => {})).rejects.toThrow(/Usage: pnpm kyberion system/);
  });
});
