import { describe, expect, it } from 'vitest';
import { runOpsCommand } from './cli-ops.js';

function capture() {
  const lines: string[] = [];
  return {
    lines,
    print: (line: string) => lines.push(line),
    json: () => JSON.parse(lines.join('\n')) as Record<string, unknown>,
  };
}

describe('pnpm kyberion ops', () => {
  it('lists actuator domains with op counts', async () => {
    const out = capture();
    await runOpsCommand([], out.print);
    const summary = out.json();
    expect(summary.system).toBeGreaterThan(0);
    expect(summary.browser).toBeGreaterThan(0);
  });

  it('groups a domain op vocabulary by step kind', async () => {
    const out = capture();
    await runOpsCommand(['system'], out.print);
    const grouped = out.json() as { domain: string; capture?: string[] };
    expect(grouped.domain).toBe('system');
    expect(grouped.capture).toContain('screenshot');
  });

  it('filters a domain listing by kind', async () => {
    const out = capture();
    await runOpsCommand(['system', '--kind', 'control'], out.print);
    const grouped = out.json() as Record<string, string[]>;
    expect(Object.keys(grouped).sort()).toEqual(['control', 'domain']);
    expect(grouped.control).toContain('if');
  });

  it('rejects an unknown domain with the available list', async () => {
    await expect(runOpsCommand(['bogus'], () => {})).rejects.toThrow(
      /unknown actuator domain 'bogus'.*system/s
    );
  });

  it('rejects unknown options and prints usage on --help', async () => {
    await expect(runOpsCommand(['--bogus'], () => {})).rejects.toThrow(/unknown option --bogus/);
    const out = capture();
    await runOpsCommand(['--help'], out.print);
    expect(out.lines[0]).toContain('Usage: pnpm kyberion ops');
  });
});
