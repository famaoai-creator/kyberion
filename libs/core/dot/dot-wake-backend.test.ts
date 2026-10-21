import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildFailoverReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
} from '../reasoning/reasoning-backend.js';
import {
  clearProviderHealth,
  reportProviderTemporarilyUnhealthy,
} from '../provider/provider-health-registry.js';
import { ShellClaudeCliBackend } from '../shell/shell-claude-cli-backend.js';
import type { DotCharter } from './dot-charter.js';
import {
  dotBackendIsUnconfiguredStub,
  isDotToolBackendUnavailableError,
  resolveDotWakeBackend,
  runDelegatedWake,
} from './dot-wake-backend.js';

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'repo-guardian',
  version: '1.0.0',
  title: 'Repo guardian',
  purpose: 'Keep the repository healthy.',
  status: 'active',
  scope: { tier: 'public' },
  goal: { statement: 'Keep CI green.' },
  attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-repo-guardian' },
};

const toolBackend: ReasoningBackend = {
  ...stubReasoningBackend,
  name: 'anthropic',
  generateWithTools: async () => ({ text: '', toolCalls: [] }) as never,
};
const textBackend: ReasoningBackend = { ...stubReasoningBackend, name: 'claude-cli' };

afterEach(() => {
  vi.unstubAllEnvs();
  clearProviderHealth();
});

describe('resolveDotWakeBackend', () => {
  it('refuses the process-default stub (no fake [STUB] deliveries)', () => {
    vi.stubEnv('KYBERION_REASONING_BACKEND', 'claude-cli');
    const resolution = resolveDotWakeBackend(CHARTER, stubReasoningBackend);
    expect(resolution.mode).toBe('unavailable');
    expect(resolution.mode === 'unavailable' && resolution.reason).toContain(
      'no real reasoning backend in this process'
    );
  });

  it('allows the stub when explicitly requested or injected', () => {
    expect(resolveDotWakeBackend(CHARTER, stubReasoningBackend, { injected: true }).mode).toBe(
      'fence'
    );
    vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
    expect(dotBackendIsUnconfiguredStub(stubReasoningBackend)).toBe(false);
    expect(resolveDotWakeBackend(CHARTER, stubReasoningBackend).mode).toBe('fence');
  });

  it('chooses tool only when a live tool candidate exists', () => {
    expect(resolveDotWakeBackend(CHARTER, toolBackend).mode).toBe('tool');
    expect(resolveDotWakeBackend(CHARTER, textBackend).mode).toBe('fence');

    const chain = buildFailoverReasoningBackend([
      { backend: toolBackend, provider: 'anthropic' },
      { backend: textBackend, provider: 'claude-cli' },
    ]);
    expect(resolveDotWakeBackend(CHARTER, chain).mode).toBe('tool');
    reportProviderTemporarilyUnhealthy('anthropic', { retryAfterMs: 60_000 });
    // The chain still advertises generateWithTools, but nothing live can serve it.
    expect(chain.generateWithTools).toBeTypeOf('function');
    expect(resolveDotWakeBackend(CHARTER, chain).mode).toBe('fence');
  });

  it('prefers charter.runtime.reasoning_backend when it resolves', () => {
    const charter = {
      ...CHARTER,
      runtime: { ...CHARTER.runtime, reasoning_backend: 'anthropic' },
    };
    const resolution = resolveDotWakeBackend(charter, textBackend, {
      backendFor: (name) => (name === 'anthropic' ? toolBackend : undefined),
    });
    expect(resolution).toEqual({ mode: 'tool', backend: toolBackend });
    // Unresolvable preference falls back to the process backend.
    expect(resolveDotWakeBackend(charter, textBackend, { backendFor: () => undefined }).mode).toBe(
      'fence'
    );
  });

  it('chooses tool when the live candidate is the claude CLI with prompted tool calling', () => {
    const claudeCli = new ShellClaudeCliBackend({ bin: 'claude' });
    expect(resolveDotWakeBackend(CHARTER, claudeCli, { injected: true }).mode).toBe('tool');

    // An API candidate demoted, the claude CLI still serves the tool loop.
    const chain = buildFailoverReasoningBackend([
      { backend: toolBackend, provider: 'anthropic' },
      { backend: claudeCli, provider: 'claude-cli' },
    ]);
    reportProviderTemporarilyUnhealthy('anthropic', { retryAfterMs: 60_000 });
    expect(resolveDotWakeBackend(CHARTER, chain).mode).toBe('tool');

    // Opt-in off: the same CLI is advice-only again.
    const offCli = new ShellClaudeCliBackend({ bin: 'claude', promptedToolCalling: false });
    expect(resolveDotWakeBackend(CHARTER, offCli, { injected: true }).mode).toBe('fence');
  });
});

describe('isDotToolBackendUnavailableError', () => {
  it('matches the no-tool-candidate failures seen in the wake ledger', () => {
    expect(
      isDotToolBackendUnavailableError(
        '[reasoning-backend:failover] generateWithTools failed across 0 candidate(s): '
      )
    ).toBe(true);
    expect(
      isDotToolBackendUnavailableError(
        '[GOAL_DRIVER] backend lacks generateWithTools — a goal loop needs a tool-use backend'
      )
    ).toBe(true);
    expect(isDotToolBackendUnavailableError('generateWithTools failed across 2 candidate(s)')).toBe(
      false
    );
  });
});

describe('runDelegatedWake', () => {
  it("routes the delegated turn on the charter's authority role", async () => {
    const delegateTask = vi.fn(async () => 'done');
    // Unnamed port: an explicit test seam, so no provider permission profile applies.
    await expect(runDelegatedWake(CHARTER, { delegateTask }, 'wake', 1_000)).resolves.toBe('done');
    expect(delegateTask).toHaveBeenCalledWith(
      'wake',
      undefined,
      expect.objectContaining({ role: 'infrastructure_sentinel', advisory: true })
    );
  });
});
