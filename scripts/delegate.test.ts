import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import type {
  ReasoningBackend,
  ReasoningCallOptions,
} from '@agent/core/reasoning/reasoning-backend';
import { main, parseDelegateArgs, delegateUsage } from './delegate.js';

const STORE_OVERRIDE = `active/shared/tmp/delegate-cli-tests/store-${process.pid}`;
const TRACE_OVERRIDE = `active/shared/tmp/delegate-cli-tests/trace-${process.pid}.jsonl`;

function cleanup(): void {
  const dir = pathResolver.rootResolve(STORE_OVERRIDE);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
  const tracePath = pathResolver.rootResolve(TRACE_OVERRIDE);
  if (safeExistsSync(tracePath)) safeRmSync(tracePath);
}

beforeEach(() => {
  process.env.KYBERION_DELEGATION_STORE_DIR = STORE_OVERRIDE;
  process.env.KYBERION_DELEGATION_TRACE_PATH = TRACE_OVERRIDE;
  cleanup();
});

afterAll(() => {
  cleanup();
  delete process.env.KYBERION_DELEGATION_STORE_DIR;
  delete process.env.KYBERION_DELEGATION_TRACE_PATH;
});

describe('parseDelegateArgs', () => {
  it('reads positional instruction, defaults to implementer profile', () => {
    const args = parseDelegateArgs(['fix the flaky test']);
    expect(args.instruction).toBe('fix the flaky test');
    expect(args.profile).toBe('implementer');
  });

  it('parses flags and keeps them out of positionals', () => {
    const args = parseDelegateArgs([
      '--profile',
      'explorer',
      '--context',
      'mission evidence',
      '--mission',
      'MSN-X-1',
      '--inactivity-timeout-ms',
      '5000',
      'do the thing',
    ]);
    expect(args).toMatchObject({
      instruction: 'do the thing',
      profile: 'explorer',
      context: 'mission evidence',
      missionId: 'MSN-X-1',
      inactivityTimeoutMs: 5000,
    });
  });

  it('rejects a non-numeric inactivity timeout', () => {
    expect(() => parseDelegateArgs(['--inactivity-timeout-ms', 'soon'])).toThrow(
      '--inactivity-timeout-ms'
    );
  });

  it('rejects out-of-range inactivity timeouts', () => {
    for (const value of ['0', '2147483648']) {
      expect(() => parseDelegateArgs(['--inactivity-timeout-ms', value])).toThrow(
        '--inactivity-timeout-ms'
      );
    }
  });

  it('rejects conflicting instruction sources', () => {
    for (const argv of [
      ['positional', '--task', 'flag'],
      ['positional', '--task-file', 'brief.md'],
      ['--task', 'flag', '--task-file', 'brief.md'],
    ]) {
      expect(() => parseDelegateArgs(argv)).toThrow('conflicting instruction sources');
    }
  });

  it('usage names the KD-05 tiers and the charter hint', () => {
    const usage = delegateUsage();
    expect(usage).toContain('implementer');
    expect(usage).toContain('explorer');
    expect(usage).toContain('delegation-cli-playbook.md');
  });
});

function fakeBackend(captured: { options?: ReasoningCallOptions }): ReasoningBackend {
  return {
    name: 'stub',
    delegateTask: async (
      _instruction: string,
      _context?: string,
      options?: ReasoningCallOptions
    ) => {
      captured.options = options;
      return 'sub-agent rollup text';
    },
  } as unknown as ReasoningBackend;
}

describe('delegate main', () => {
  it('dispatches through delegateTask with the chosen KD-05 profile', async () => {
    const captured: { options?: ReasoningCallOptions } = {};
    const printed: string[] = [];
    await main(
      ['--profile', 'explorer', '--mission', 'MSN-T-1', 'investigate X'],
      (v) => printed.push(String(v)),
      false,
      {
        getBackend: () => fakeBackend(captured),
        installBackends: () => undefined,
      }
    );
    expect(captured.options?.profile).toBe('explorer');
    expect(printed.join('\n')).toContain('sub-agent rollup text');
  });

  it('prints structured output under --json', async () => {
    const captured: { options?: ReasoningCallOptions } = {};
    const printed: unknown[] = [];
    await main(['--json', 'investigate X'], (v) => printed.push(v), true, {
      getBackend: () => fakeBackend(captured),
      installBackends: () => undefined,
    });
    const out = printed[0] as Record<string, unknown>;
    expect(out.status).toBe('ok');
    expect(out.profile).toBe('implementer');
    expect(out.result).toBe('sub-agent rollup text');
    expect(typeof out.delegation_id).toBe('string');
  });

  it('throws for an unknown capability tier before dispatching', async () => {
    let dispatched = false;
    await expect(
      main(['--profile', 'root', 'x'], () => undefined, false, {
        getBackend: () => {
          dispatched = true;
          return fakeBackend({});
        },
        installBackends: () => undefined,
      })
    ).rejects.toThrow('SUBAGENT_PROFILE_UNKNOWN');
    expect(dispatched).toBe(false);
  });

  it('requires an instruction', async () => {
    await expect(
      main([], () => undefined, false, {
        getBackend: () => fakeBackend({}),
        installBackends: () => undefined,
      })
    ).rejects.toThrow('missing instruction');
  });
});
