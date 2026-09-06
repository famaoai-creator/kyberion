/**
 * XP-07: model-diverse best-of-N delegation.
 * See docs/developer/improvement-plans-2026-07/
 * CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md §XP-07.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import path from 'node:path';

const delegationSlotCalls: Array<{ provider?: string }> = [];

vi.mock('./delegation-concurrency.js', async () => {
  const actual = await vi.importActual<typeof import('./delegation-concurrency.js')>(
    './delegation-concurrency.js'
  );
  return {
    ...actual,
    withDelegationSlot: (opts: { provider?: string }, fn: () => Promise<unknown>) => {
      delegationSlotCalls.push(opts);
      return actual.withDelegationSlot(opts, fn);
    },
  };
});

// Seams out real provider-backend-resolver construction (shells out to CLIs
// in the real module) so the default-`seams.getBackend` / live-flag test
// below stays hermetic — it only needs to prove *whether* the resolver is
// consulted, not what a real CLI backend returns (that's
// provider-backend-resolver.test.ts's job).
const resolveProviderBackendCalls: string[] = [];
vi.mock('./provider-backend-resolver.js', () => ({
  resolveProviderBackend: (provider: string) => {
    resolveProviderBackendCalls.push(provider);
    return {
      async delegateTask(instruction: string) {
        return `live-resolver:${provider}:${instruction}`;
      },
    };
  },
}));

import {
  runBestOfProviders,
  defaultBestOfProvidersJudge,
  peekBestOfProvidersVerdictLog,
  BEST_OF_PROVIDERS_LIVE_ENV_VAR,
  type BestOfProviderBackend,
} from './best-of-providers.js';
import { PlanningReviewVerdictSchema } from './structured-output-contracts.js';
import {
  _resetProviderEgressPolicyCacheForTests,
  type ProviderEgressPolicyFile,
} from './provider-egress-gate.js';
import { resetDelegationConcurrencyStateForTests } from './delegation-concurrency.js';

const POLICY_DIR = pathResolver.sharedTmp(`best-of-providers-test-policy-${process.pid}`);
const POLICY_PATH = path.join(POLICY_DIR, 'provider-egress-policy.json');

const VERDICT_LOG_DIR = pathResolver.sharedTmp(`best-of-providers-test-log-${process.pid}`);
const VERDICT_LOG_PATH = path.join(VERDICT_LOG_DIR, 'verdicts.jsonl');

function writePolicy(policy: ProviderEgressPolicyFile): void {
  safeMkdir(POLICY_DIR, { recursive: true });
  safeWriteFile(POLICY_PATH, JSON.stringify(policy), { encoding: 'utf8' });
}

function fakeBackend(output: string): BestOfProviderBackend {
  return {
    async delegateTask() {
      return output;
    },
  };
}

function throwingBackend(message: string): BestOfProviderBackend {
  return {
    async delegateTask() {
      throw new Error(message);
    },
  };
}

beforeEach(() => {
  delegationSlotCalls.length = 0;
  resolveProviderBackendCalls.length = 0;
  resetDelegationConcurrencyStateForTests();
});

afterEach(() => {
  safeRmSync(POLICY_DIR, { recursive: true, force: true });
  safeRmSync(VERDICT_LOG_DIR, { recursive: true, force: true });
  delete process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH;
  delete process.env[BEST_OF_PROVIDERS_LIVE_ENV_VAR];
  _resetProviderEgressPolicyCacheForTests();
  resetDelegationConcurrencyStateForTests();
});

describe('runBestOfProviders', () => {
  it('fans out to 3 providers concurrently, judges, and records an MO-07-compatible verdict', async () => {
    const backends: Record<string, BestOfProviderBackend> = {
      claude: fakeBackend('add a null check before dereferencing user.name'),
      codex: fakeBackend('add a null check before dereferencing user.name to avoid a crash'),
      agy: fakeBackend('rewrite the whole module with a completely different architecture'),
    };

    const result = await runBestOfProviders({
      instruction: 'fix the null-pointer bug',
      context: 'user.name is sometimes undefined',
      dataTier: 'public',
      providers: ['claude', 'codex', 'agy'],
      seams: {
        getBackend: (provider) => backends[provider] ?? null,
        verdictLogPath: VERDICT_LOG_PATH,
      },
    });

    // All three ran, none excluded, all three produced output.
    expect(result.excluded).toEqual([]);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((c) => c.output !== null)).toBe(true);
    expect(result.verdictRecord.participants.sort()).toEqual(['agy', 'claude', 'codex']);

    // Winner is one of the two lexically-similar candidates (claude/codex),
    // not the outlier (agy) — the deterministic heuristic prefers agreement.
    expect(['claude', 'codex']).toContain(result.winner?.provider);
    expect(result.verdictRecord.winner).toBe(result.winner?.provider);

    // votes recorded for every participant.
    expect(Object.keys(result.verdictRecord.votes).sort()).toEqual(['agy', 'claude', 'codex']);

    // MO-07-compatible verdict shape (PlanningReviewVerdictSchema: approve/gaps/rationale).
    const parsed = PlanningReviewVerdictSchema.safeParse(result.verdictRecord.verdict);
    expect(parsed.success).toBe(true);
    expect(result.verdictRecord.verdict.approve).toBe(true);
    expect(result.verdictRecord.degraded).toBeUndefined();

    // No LLM judge call — content stays out of the persisted record.
    const persisted = peekBestOfProvidersVerdictLog(VERDICT_LOG_PATH);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].instruction_digest).toBe(result.verdictRecord.instruction_digest);
    expect(persisted[0].data_tier).toBe('public');
    expect(JSON.stringify(persisted[0])).not.toContain('null-pointer');

    safeWriteFile(
      VERDICT_LOG_PATH,
      [
        JSON.stringify(persisted[0]),
        JSON.stringify({ ...persisted[0], participants: [42] }),
        '{"constructor":{"polluted":true}}',
      ].join('\n') + '\n'
    );
    expect(peekBestOfProvidersVerdictLog(VERDICT_LOG_PATH)).toHaveLength(1);
  });

  it('treats a directory at the verdict log path as empty history', () => {
    safeMkdir(VERDICT_LOG_PATH, { recursive: true });

    expect(peekBestOfProvidersVerdictLog(VERDICT_LOG_PATH)).toEqual([]);
  });

  it('auto-excludes an egress-ineligible provider and surfaces the exclusion', async () => {
    process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH = POLICY_PATH;
    _resetProviderEgressPolicyCacheForTests();
    writePolicy({
      version: '1.0.0',
      providers: {
        claude: { egress: 'external-api' },
        codex: { egress: 'external-api' },
      },
      tier_policy: {
        confidential: { mode: 'approved-only', approved_providers: ['claude'] },
        personal: { mode: 'local-only-or-approved', approved_providers: [] },
      },
    });

    const result = await runBestOfProviders({
      instruction: 'review this confidential design doc',
      dataTier: 'confidential',
      providers: ['claude', 'codex'],
      seams: {
        getBackend: (provider) =>
          provider === 'claude' ? fakeBackend('looks fine') : fakeBackend('unreachable'),
        verdictLogPath: VERDICT_LOG_PATH,
      },
    });

    expect(result.excluded).toEqual([
      { provider: 'codex', reason: expect.stringContaining('PROVIDER_EGRESS_DENIED') },
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].provider).toBe('claude');
    expect(result.verdictRecord.excluded).toEqual(result.excluded);
    // Only one *eligible* provider after the gate -> natural single-provider degradation.
    expect(result.verdictRecord.degraded).toBe('single-provider');
    expect(result.winner?.provider).toBe('claude');
  });

  it('degrades naturally to a single-provider run when only one provider is available (never fails)', async () => {
    const result = await runBestOfProviders({
      instruction: 'summarize the incident',
      dataTier: 'public',
      providers: ['claude'],
      seams: {
        getBackend: () => fakeBackend('summary text'),
        verdictLogPath: VERDICT_LOG_PATH,
      },
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.winner).toEqual({ provider: 'claude', output: 'summary text' });
    expect(result.verdictRecord.degraded).toBe('single-provider');
    expect(result.verdictRecord.verdict.approve).toBe(true);
    expect(result.excluded).toEqual([]);
  });

  it('keeps judging the others when one provider call throws', async () => {
    const result = await runBestOfProviders({
      instruction: 'plan the migration',
      dataTier: 'public',
      providers: ['claude', 'codex'],
      seams: {
        getBackend: (provider) =>
          provider === 'claude'
            ? throwingBackend('cli crashed')
            : fakeBackend('migration plan text'),
        verdictLogPath: VERDICT_LOG_PATH,
      },
    });

    expect(result.candidates).toHaveLength(2);
    const failed = result.candidates.find((c) => c.provider === 'claude');
    const succeeded = result.candidates.find((c) => c.provider === 'codex');
    expect(failed?.output).toBeNull();
    expect(failed?.error).toContain('cli crashed');
    expect(succeeded?.output).toBe('migration plan text');

    // The whole run did not fail; the surviving candidate was judged and won.
    expect(result.winner?.provider).toBe('codex');
    expect(result.verdictRecord.verdict.approve).toBe(true);
    expect(result.verdictRecord.participants).toEqual(['codex']);
    expect(result.verdictRecord.verdict.gaps.join(' ')).toContain('claude');
  });

  it('wraps every eligible provider call in withDelegationSlot', async () => {
    await runBestOfProviders({
      instruction: 'assess risk',
      dataTier: 'public',
      providers: ['claude', 'codex', 'agy'],
      seams: {
        getBackend: (provider) => fakeBackend(`${provider} output`),
        verdictLogPath: VERDICT_LOG_PATH,
      },
    });

    expect(delegationSlotCalls).toHaveLength(3);
    expect(delegationSlotCalls.map((c) => c.provider).sort()).toEqual(['agy', 'claude', 'codex']);
  });
});

describe('default seams.getBackend (KYBERION_BEST_OF_PROVIDERS_LIVE opt-in)', () => {
  it('stays inert (no backend, resolver never consulted) when no seams.getBackend is injected and the live flag is unset', async () => {
    delete process.env[BEST_OF_PROVIDERS_LIVE_ENV_VAR];

    const result = await runBestOfProviders({
      instruction: 'assess risk',
      dataTier: 'public',
      providers: ['claude'],
      seams: { verdictLogPath: VERDICT_LOG_PATH }, // no getBackend override
    });

    expect(resolveProviderBackendCalls).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].output).toBeNull();
    expect(result.candidates[0].error).toContain('no backend available');
  });

  it('delegates to the live provider-backend-resolver when no seams.getBackend is injected and KYBERION_BEST_OF_PROVIDERS_LIVE=1', async () => {
    process.env[BEST_OF_PROVIDERS_LIVE_ENV_VAR] = '1';

    const result = await runBestOfProviders({
      instruction: 'assess risk',
      dataTier: 'public',
      providers: ['claude'],
      seams: { verdictLogPath: VERDICT_LOG_PATH }, // no getBackend override
    });

    expect(resolveProviderBackendCalls).toEqual(['claude']);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].output).toBe('live-resolver:claude:assess risk');
  });

  it('an explicit seams.getBackend still wins over the live-flag default', async () => {
    process.env[BEST_OF_PROVIDERS_LIVE_ENV_VAR] = '1';

    const result = await runBestOfProviders({
      instruction: 'assess risk',
      dataTier: 'public',
      providers: ['claude'],
      seams: {
        getBackend: (provider) => fakeBackend(`explicit:${provider}`),
        verdictLogPath: VERDICT_LOG_PATH,
      },
    });

    expect(resolveProviderBackendCalls).toEqual([]);
    expect(result.candidates[0].output).toBe('explicit:claude');
  });
});

describe('defaultBestOfProvidersJudge', () => {
  it('never calls an LLM: pure function over already-produced candidate text', async () => {
    const verdict = await defaultBestOfProvidersJudge({
      instruction: 'x',
      candidates: [
        { provider: 'a', output: 'same text here' },
        { provider: 'b', output: 'same text here' },
      ],
    });
    expect(verdict.approve).toBe(true);
    expect(verdict.winnerProvider).toBe('a'); // tie -> first by input order
    expect(verdict.votes.a).toBe(1);
    expect(verdict.votes.b).toBe(1);
  });
});
