/**
 * §4 canary (CLAUDE_CLI_TENANT_CREDENTIAL_DESIGN_2026-11-16): a bound claude
 * CLI launch never reads operator settings, hooks, MCP or login, passes only
 * the binding's credential for its kind, runs in a tenant scratch cwd, and
 * fails closed — without spawning — when the binding cannot supply the kind's
 * credential. Unbound (operator) launches keep their argv/env unchanged.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import {
  withTaskCredentialBinding,
  type TaskCredentialBinding,
} from '../foundation/credential-binding.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync } from '../secure-io.js';
import { metrics } from '../analysis/metrics.js';
import { CLAUDE_TENANT_ISOLATION_ARGS } from '../provider/claude-cli-tenant-isolation.js';
import { ShellClaudeCliBackend } from './shell-claude-cli-backend.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});
// Hermetic: no active-child registry write (see shell-claude-cli-backend.test.ts).
vi.mock('../mission/delegation-concurrency.js', () => ({
  delegationChildHandleFromChildProcess: (child: {
    pid?: number;
    kill: (signal: NodeJS.Signals) => boolean;
  }) => ({
    pid: child.pid,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
  }),
  withWallClockBudget: (_opts: unknown, fn: () => Promise<unknown>) => fn(),
  DelegationWallClockExceededError: class DelegationWallClockExceededError extends Error {},
}));
vi.mock('../vcs/session-git-index.js', () => ({ prepareSessionGitIndex: () => null }));
vi.mock('../reasoning/reasoning-egress-scope.js', () => ({
  assertReasoningEgressAllowed: () => undefined,
}));

const TENANT = 'claude-iso';
const root = pathResolver.rootResolve(
  `active/shared/tmp/confidential/${TENANT}/provider-auth/vitest-claude-iso-${randomUUID()}`
);
const home = path.join(root, 'home');
const API_KEY = 'sk-ant-api-bound-tenant-key-0001';
const OAUTH_TOKEN = 'sk-ant-oat-bound-tenant-token-0001';

const asTenant = <T>(run: () => T): T =>
  withExecutionContext('sovereign_concierge', run, 'sovereign', TENANT);

function binding(overrides: Partial<TaskCredentialBinding> = {}): TaskCredentialBinding {
  return {
    tenantSlug: TENANT,
    secrets: {},
    providerEnvironments: {
      claude: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PATH: '/usr/bin:/bin' },
    },
    ...overrides,
  };
}

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function createChild(stdoutText: string): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  queueMicrotask(() => {
    child.stdout.write(stdoutText);
    child.stdout.end();
    child.stderr.end();
    child.exitCode = 0;
    child.emit('close', 0);
  });
  return child;
}

const textEnvelope = () => createChild(JSON.stringify({ type: 'result', result: 'ok' }));
const streamEnvelope = () =>
  createChild(
    [
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok.' } },
      },
      { type: 'result', result: 'ok.' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n'
  );

function spawned(index = 0): { args: string[]; env: NodeJS.ProcessEnv; cwd?: string } {
  const [, args, options] = spawnMock.mock.calls[index];
  return { args, env: options.env, cwd: options.cwd };
}

function containsSequence(args: readonly string[], sequence: readonly string[]): boolean {
  return args.some((_, index) => sequence.every((token, offset) => args[index + offset] === token));
}

beforeEach(() => {
  spawnMock.mockReset();
  vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
  vi.stubEnv('KYBERION_TIER', 'confidential');
  // Operator credentials and settings that a bound launch must never see.
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-operator-api-key-should-not-leak');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-operator-oauth-should-not-leak');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-operator-auth-should-not-leak');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/operator/.claude');
  asTenant(() => safeMkdir(home, { recursive: true }));
});

afterEach(() => {
  asTenant(() => safeRmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('bound claude CLI launch (§4)', () => {
  it('api_key: --bare + closed settings/MCP/hooks, only the bound API key, tenant scratch cwd', async () => {
    const backend = new ShellClaudeCliBackend({
      bin: 'claude',
      model: 'opus',
      extraArgs: ['--settings', '/operator/settings.json'],
    });
    spawnMock.mockImplementationOnce(textEnvelope);
    await asTenant(() =>
      withTaskCredentialBinding(
        binding({ secrets: { ANTHROPIC_API_KEY: API_KEY }, credentialKind: 'api_key' }),
        () => backend.delegateTask('do it')
      )
    );
    const { args, env, cwd } = spawned();
    expect(containsSequence(args, CLAUDE_TENANT_ISOLATION_ARGS)).toBe(true);
    expect(args).toContain('--bare');
    // Operator CLI extras (here: an operator settings file) never reach a bound launch.
    expect(args).not.toContain('/operator/settings.json');
    expect(env).toMatchObject({
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      ANTHROPIC_API_KEY: API_KEY,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      KYBERION_TENANT: TENANT,
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // Repository hooks/settings are not discoverable from the cwd.
    expect(cwd).toBeDefined();
    expect(path.relative(pathResolver.rootResolve('active/shared/tmp'), cwd!)).toMatch(
      new RegExp(`^confidential/${TENANT}/claude-cli/`)
    );
    expect(safeExistsSync(cwd!)).toBe(false);
  });

  it('subscription_token: no --bare, only CLAUDE_CODE_OAUTH_TOKEN, on every path', async () => {
    const backend = new ShellClaudeCliBackend({
      bin: 'claude',
      model: 'opus',
      promptedToolCalling: true,
    });
    spawnMock
      .mockImplementationOnce(textEnvelope)
      .mockImplementationOnce(streamEnvelope)
      .mockImplementationOnce(textEnvelope);
    await asTenant(() =>
      withTaskCredentialBinding(
        binding({
          secrets: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN },
          credentialKind: 'subscription_token',
        }),
        async () => {
          await backend.delegateTask('delegate');
          for await (const _delta of backend.streamPrompt('stream')) void _delta;
          await backend.generateWithTools!('tools', []);
        }
      )
    );
    expect(spawnMock).toHaveBeenCalledTimes(3);
    for (const index of [0, 1, 2]) {
      const { args, env, cwd } = spawned(index);
      expect(containsSequence(args, CLAUDE_TENANT_ISOLATION_ARGS)).toBe(true);
      // Exactly one closed surface even where the path already declared it.
      expect(args.filter((arg) => arg === '--setting-sources')).toHaveLength(1);
      expect(args).not.toContain('--bare');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH_TOKEN);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude'));
      expect(env.HOME).toBe(home);
      expect(cwd).toContain(`/confidential/${TENANT}/claude-cli/`);
    }
  });

  it.each([
    ['no credential kind', binding({ secrets: { ANTHROPIC_API_KEY: API_KEY } })],
    ['api_key without the key', binding({ credentialKind: 'api_key' })],
    [
      'subscription_token holding only an API key',
      binding({ secrets: { ANTHROPIC_API_KEY: API_KEY }, credentialKind: 'subscription_token' }),
    ],
  ])('refuses before spawn: %s', async (_label, bound) => {
    const backend = new ShellClaudeCliBackend({ bin: 'claude', model: 'opus' });
    await asTenant(() =>
      withTaskCredentialBinding(bound, async () => {
        await expect(backend.delegateTask('x')).rejects.toThrow('[CREDENTIAL_PROVIDER_DENIED]');
        const stream = backend.streamPrompt('x');
        await expect(stream.next()).rejects.toThrow('[CREDENTIAL_PROVIDER_DENIED]');
      })
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('masks the token in a stream error raised after a mid-stream revocation', async () => {
    const backend = new ShellClaudeCliBackend({ bin: 'claude', model: 'opus' });
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn();
      child.exitCode = null;
      child.signalCode = null;
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
          }) + '\n'
        );
        child.stderr.write(`auth failed for token ${OAUTH_TOKEN}`);
        setImmediate(() => {
          child.stdout.end();
          child.stderr.end();
          child.exitCode = 1;
          child.emit('close', 1);
        });
      });
      return child;
    });
    let revoked = false;
    let failure: unknown;
    await asTenant(() =>
      withTaskCredentialBinding(
        binding({
          secrets: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN },
          credentialKind: 'subscription_token',
          validate: () => {
            if (revoked) throw new Error('[CREDENTIAL_ALLOCATION_DENIED] revoked');
          },
        }),
        async () => {
          try {
            for await (const _delta of backend.streamPrompt('stream')) revoked = true;
          } catch (error) {
            failure = error;
          }
        }
      )
    );
    expect(revoked).toBe(true);
    expect(String((failure as Error)?.message)).toContain('streaming CLI exited with code 1');
    expect(String((failure as Error)?.message)).not.toContain(OAUTH_TOKEN);
  });

  it('refuses a CLAUDE_CONFIG_DIR outside the bound HOME', () => {
    expect(() =>
      asTenant(() =>
        withTaskCredentialBinding(
          binding({
            secrets: { ANTHROPIC_API_KEY: API_KEY },
            credentialKind: 'api_key',
            providerEnvironments: {
              claude: { HOME: home, CLAUDE_CONFIG_DIR: '/operator/.claude' },
            },
          }),
          () => undefined
        )
      )
    ).toThrow('[CREDENTIAL_HOME_REQUIRED]');
  });

  it('rejects an unknown credential kind at bind time', () => {
    expect(() =>
      asTenant(() =>
        withTaskCredentialBinding(binding({ credentialKind: 'cookie' as never }), () => undefined)
      )
    ).toThrow('[CREDENTIAL_BINDING_INVALID]');
  });
});

describe('unbound (operator) claude CLI launch', () => {
  it('keeps argv, env and cwd unchanged', async () => {
    const backend = new ShellClaudeCliBackend({
      bin: 'claude',
      model: 'opus',
      extraArgs: ['--verbose'],
    });
    spawnMock.mockImplementationOnce(textEnvelope).mockImplementationOnce(streamEnvelope);
    await backend.delegateTask('operator');
    for await (const _delta of backend.streamPrompt('operator')) void _delta;
    for (const index of [0, 1]) {
      const { args, env, cwd } = spawned(index);
      expect(args).toContain('--verbose');
      expect(args).not.toContain('--bare');
      expect(args).not.toContain('--setting-sources');
      expect(args).not.toContain('--strict-mcp-config');
      expect(cwd).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-operator-api-key-should-not-leak');
      // Pre-existing allowlist: these never passed to an operator child either.
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(env.DISABLE_AUTOUPDATER).toBeUndefined();
    }
  });
});
