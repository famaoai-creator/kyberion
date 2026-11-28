import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScopeContext } from '@agent/core/scope-context';
import {
  loadExecutionFeedbackStore,
  resolveExecutionFeedbackPath,
} from '@agent/core/execution-feedback';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';

const fixture = vi.hoisted(() => ({
  owner: '',
  scope: { tier: 'public' } as ScopeContext,
  agent: null as string | null,
}));
vi.mock('@agent/core/governance/cli-operator-principal', () => ({
  detectCliAgentPrincipal: () => fixture.agent,
  resolveCliOperatorIdentity: () => ({ principalId: fixture.owner }),
}));
vi.mock('@agent/core/scope-context', async (load) => ({
  ...(await load<typeof import('@agent/core/scope-context')>()),
  currentScope: () => fixture.scope,
}));

import { recordSetupAskPreference, setupAskFeedbackActions } from './setup-ask-preferences.js';
import { resolveSetupAskGuidanceWithJudgment } from './setup-ask-judgment.js';

const question = 'Kyberion を通して会話するには？';
let originalOwner: string;
beforeEach(() => {
  originalOwner = `user:guidance-v1-vitest-${process.pid}`;
  fixture.owner = originalOwner;
  fixture.scope = { tier: 'public' };
  fixture.agent = null;
});
afterEach(() => {
  safeRmSync(resolveExecutionFeedbackPath({ tier: 'personal', owner_nhi: originalOwner }), {
    force: true,
  });
});

it('reuses an explicit preference in a later request and supports clearing it', async () => {
  expect(recordSetupAskPreference('guide preference conversation: channel')).toMatchObject({
    ok: true,
    preferred: 'channel',
  });
  const guidance = await resolveSetupAskGuidanceWithJudgment(question, true);
  expect(guidance?.recommended?.domain).toBe('channel');
  expect(guidance?.explanation?.decision).toBe('operator_preference');
  expect(guidance?.clarification?.choices).toHaveLength(3);
  expect(recordSetupAskPreference('guide preference conversation: clear')).toMatchObject({
    ok: true,
    preferred: null,
  });
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
});

it('does not reuse preferences for other operators, tiers, or agent sessions', async () => {
  expect(recordSetupAskPreference('guide preference conversation: channel')?.ok).toBe(true);
  fixture.owner = 'user:another-vitest-operator';
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
  fixture.owner = originalOwner;
  fixture.scope = { tier: 'personal' };
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
  fixture.agent = 'agent:worker';
  expect(recordSetupAskPreference('guide preference conversation: channel')?.ok).toBe(false);
});

it('learns from repeated evaluations and withdraws the highlight after conflicting feedback', async () => {
  const helpful = 'guide feedback conversation: channel helpful';
  for (const id of ['attempt-a', 'attempt-b', 'attempt-c', 'attempt-d'])
    setupAskFeedbackActions('conversation', id);
  expect(recordSetupAskPreference(helpful, 'attempt-a')).toMatchObject({
    kind: 'lifecycle_feedback',
    ok: true,
    target: 'channel',
    outcome: 'satisfied',
  });
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
  expect(recordSetupAskPreference(helpful, 'attempt-b')?.ok).toBe(true);
  const learned = await resolveSetupAskGuidanceWithJudgment(question, true);
  expect(learned?.recommended?.domain).toBe('channel');
  expect(learned?.explanation).toMatchObject({
    decision: 'feedback_preference',
    feedback_evidence: { evaluated_attempts: 2, net_score: 2 },
  });
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.explanation).toBeUndefined();
  expect(learned?.clarification?.choices).toHaveLength(3);

  fixture.scope = { tier: 'personal' };
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
  fixture.scope = { tier: 'public' };

  expect(
    recordSetupAskPreference('guide feedback conversation: channel missed', 'attempt-c')?.ok
  ).toBe(true);
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
  expect(recordSetupAskPreference(helpful, 'attempt-d')?.ok).toBe(true);
  expect(recordSetupAskPreference('guide preference conversation: coordination')?.ok).toBe(true);
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended?.domain).toBe(
    'coordination'
  );
  expect(recordSetupAskPreference('guide preference conversation: clear')?.ok).toBe(true);
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
});

it('rejects incomplete feedback and feedback submitted by agent sessions', () => {
  expect(recordSetupAskPreference('guide feedback conversation: channel')).toMatchObject({
    ok: false,
    reason: 'invalid_syntax',
  });
  fixture.agent = 'agent:worker';
  expect(recordSetupAskPreference('guide feedback conversation: channel helpful')).toMatchObject({
    ok: false,
    reason: 'operator_scope_required',
  });
});

it('counts each correlated attempt once and uses its latest evaluation', async () => {
  const helpful = 'guide feedback conversation: channel helpful';
  const missed = 'guide feedback conversation: channel missed';
  setupAskFeedbackActions('conversation', 'guidance:first');
  setupAskFeedbackActions('conversation', 'guidance:second');
  expect(recordSetupAskPreference(helpful, 'guidance:first')).toMatchObject({
    ok: true,
    correlation_id: 'guidance:first',
  });
  expect(recordSetupAskPreference(helpful, 'guidance:first')?.ok).toBe(true);
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
  expect(recordSetupAskPreference(helpful, 'guidance:second')?.ok).toBe(true);
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended?.domain).toBe(
    'channel'
  );
  expect(recordSetupAskPreference(missed, 'guidance:second')?.ok).toBe(true);
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
});

it('offers runnable feedback actions for the scoped operator and omits them for agents', () => {
  const id = 'guidance:sample';
  const action = setupAskFeedbackActions('conversation', id)?.channel?.helpful;
  expect(action).toEqual([
    'pnpm',
    'kyberion',
    'ask',
    'guide feedback conversation: channel helpful',
    '--correlation-id',
    id,
  ]);
  expect(recordSetupAskPreference(action![3]!, action![5])).toMatchObject({
    ok: true,
    correlation_id: id,
  });
  fixture.agent = 'agent:worker';
  expect(setupAskFeedbackActions('conversation', id)).toBeUndefined();
});

it('keeps a saved preference from overriding a conflicting hint in the current question', async () => {
  expect(recordSetupAskPreference('guide preference conversation: coordination')?.ok).toBe(true);
  const currentQuestion = 'Kyberion を通してチーム内で会話するには？';
  const guidance = await resolveSetupAskGuidanceWithJudgment(currentQuestion, true);
  expect(guidance?.explanation?.decision).not.toBe('operator_preference');
  expect(guidance?.recommended?.domain).not.toBe('coordination');
  expect(guidance?.clarification?.choices).toHaveLength(3);
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended?.domain).toBe(
    'coordination'
  );
});

it('retains unlinked feedback without treating repeated submissions as distinct attempts', async () => {
  const feedback = 'guide feedback conversation: channel helpful';
  for (let i = 0; i < 3; i += 1) {
    expect(recordSetupAskPreference(feedback)).toMatchObject({
      ok: true,
      counts_toward_recommendation: false,
    });
  }
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
});

it('requires an issued ID for the same topic and scope', () => {
  setupAskFeedbackActions('conversation', 'guidance:issued');
  const rejected = { ok: false, reason: 'unknown_guidance_attempt' };
  expect(
    recordSetupAskPreference('guide feedback recovery: mission helpful', 'guidance:issued')
  ).toMatchObject(rejected);
  expect(
    recordSetupAskPreference('guide feedback conversation: channel helpful', 'guidance:missing')
  ).toMatchObject(rejected);
  fixture.scope = { tier: 'personal' };
  expect(
    recordSetupAskPreference('guide feedback conversation: channel helpful', 'guidance:issued')
  ).toMatchObject(rejected);
});

it('reports route changes and helpful recommendations from the original advice', async () => {
  for (const [id, recommended] of [
    ['first', 'coordination'],
    ['second', 'channel'],
  ] as const) {
    setupAskFeedbackActions('conversation', id, recommended);
    expect(recordSetupAskPreference('guide feedback conversation: channel helpful', id)?.ok).toBe(
      true
    );
  }
  const guidance = await resolveSetupAskGuidanceWithJudgment(question, true);
  expect(guidance?.explanation?.feedback_evidence?.recommendations).toEqual({
    evaluated: 2,
    switched: 1,
    helpful: 1,
  });
});

it('ages out learned advice while retaining explicit preferences', async () => {
  const clock = vi.spyOn(Date, 'now');
  const start = Date.now();
  clock.mockReturnValue(start);
  const feedback = 'guide feedback conversation: channel helpful';
  try {
    for (const id of ['age-first', 'age-second']) {
      setupAskFeedbackActions('conversation', id);
      expect(recordSetupAskPreference(feedback, id)?.ok).toBe(true);
    }
    expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended?.domain).toBe(
      'channel'
    );
    clock.mockReturnValue(start + 31 * 24 * 60 * 60 * 1000);
    expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
    expect(recordSetupAskPreference(feedback, 'age-first')).toMatchObject({
      ok: false,
      reason: 'expired_guidance_attempt',
    });
    expect(recordSetupAskPreference('guide preference conversation: channel')?.ok).toBe(true);
    clock.mockReturnValue(start + 90 * 24 * 60 * 60 * 1000);
    expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended?.domain).toBe(
      'channel'
    );
  } finally {
    clock.mockRestore();
  }
});

it('reuses the same learning contract for ambiguous onboarding', async () => {
  const question = '初期設定は何から始めればいいですか？';
  const first = await resolveSetupAskGuidanceWithJudgment(question);
  expect(first?.clarification).toMatchObject({
    kind: 'installation',
    readiness_command: 'pnpm kyberion setup report --persona first-time-user',
  });
  expect(first?.clarification?.choices.map(({ domain }) => domain)).toEqual([
    'installation',
    'tenant',
    'runtime',
  ]);
  for (const id of ['onboarding-first', 'onboarding-second']) {
    setupAskFeedbackActions('installation', id);
    expect(recordSetupAskPreference('guide feedback installation: tenant helpful', id)?.ok).toBe(
      true
    );
  }
  const learned = await resolveSetupAskGuidanceWithJudgment(question, true);
  expect(learned?.recommended?.domain).toBe('tenant');
  expect(learned?.explanation?.first_check).toBe(
    'pnpm kyberion setup report --persona first-time-user'
  );
  const explicit = await resolveSetupAskGuidanceWithJudgment('API キーの初期設定の方法は？');
  expect(explicit?.routes[0]?.id).toBe('credentials');
  expect(explicit?.recommended).toBeUndefined();
});

it('reports scoped learning counts before enough evidence exists to recommend a route', () => {
  setupAskFeedbackActions('conversation', 'status-attempt', 'coordination');
  setupAskFeedbackActions('conversation', 'status-attempt', 'coordination');
  setupAskFeedbackActions('conversation', 'status-unreported');
  expect(
    recordSetupAskPreference('guide feedback conversation: channel helpful', 'status-attempt')?.ok
  ).toBe(true);
  expect(recordSetupAskPreference('guide status conversation')).toMatchObject({
    kind: 'lifecycle_learning_status',
    ok: true,
    explicit_preference: null,
    learned_preference: null,
    evaluated_attempts: 1,
    recommendations: { evaluated: 1, switched: 1, helpful: 0 },
    feedback_coverage: { issued: 2, reported: 1 },
  });
  fixture.scope = { tier: 'personal' };
  expect(recordSetupAskPreference('guide status conversation')).toMatchObject({
    ok: true,
    evaluated_attempts: 0,
    feedback_coverage: { issued: 0, reported: 0 },
  });
  fixture.agent = 'agent:worker';
  expect(recordSetupAskPreference('guide status conversation')?.ok).toBe(false);
});

it('starts learning again only from guidance issued after a reset', async () => {
  const feedback = 'guide feedback conversation: channel helpful';
  for (const id of ['before-reset-one', 'before-reset-two']) {
    setupAskFeedbackActions('conversation', id);
    expect(recordSetupAskPreference(feedback, id)?.ok).toBe(true);
  }
  expect(recordSetupAskPreference('guide preference conversation: clear')?.ok).toBe(true);
  for (const id of ['before-reset-one', 'before-reset-two']) {
    expect(recordSetupAskPreference(feedback, id)).toMatchObject({
      ok: false,
      reason: 'guidance_attempt_before_reset',
    });
  }
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
  expect(recordSetupAskPreference('guide status conversation')).toMatchObject({
    feedback_coverage: { issued: 0, reported: 0 },
  });
  for (const id of ['after-reset-one', 'after-reset-two']) {
    setupAskFeedbackActions('conversation', id);
    expect(recordSetupAskPreference(feedback, id)?.ok).toBe(true);
  }
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended?.domain).toBe(
    'channel'
  );
});

it('stops feedback collection and restarts with fresh guidance when re-enabled', async () => {
  const feedback = 'guide feedback conversation: channel helpful';
  for (const id of ['off-one', 'off-two']) {
    expect(setupAskFeedbackActions('conversation', id)).toBeDefined();
    expect(recordSetupAskPreference(feedback, id)?.ok).toBe(true);
  }
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended?.domain).toBe(
    'channel'
  );
  expect(recordSetupAskPreference('guide preference conversation: off')).toMatchObject({
    ok: true,
    learning_enabled: false,
  });
  expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
  const scope = { tier: 'personal' as const, owner_nhi: originalOwner };
  const before = loadExecutionFeedbackStore(scope).entries;
  expect(setupAskFeedbackActions('conversation', 'off-three')).toBeUndefined();
  expect(recordSetupAskPreference(feedback, 'off-one')).toMatchObject({
    ok: false,
    reason: 'guidance_learning_disabled',
  });
  expect(loadExecutionFeedbackStore(scope).entries).toEqual(before);
  expect(recordSetupAskPreference('guide preference conversation: clear')?.ok).toBe(true);
  expect(recordSetupAskPreference(feedback, 'off-two')).toMatchObject({
    ok: false,
    reason: 'guidance_attempt_before_reset',
  });
  expect(setupAskFeedbackActions('conversation', 'on-one')).toBeDefined();
  expect(recordSetupAskPreference(feedback, 'on-one')?.ok).toBe(true);
});

it('keeps an opt-out when unrelated history rolls past the store cap', () => {
  expect(recordSetupAskPreference('guide preference conversation: off')?.ok).toBe(true);
  const scope = { tier: 'personal' as const, owner_nhi: originalOwner };
  const store = loadExecutionFeedbackStore(scope);
  const [setting] = store.entries;
  expect(setting?.retention_key).toBe('reset');
  const history = Array.from({ length: 499 }, (_, index) => ({
    ...setting,
    intent_id: 'unrelated-feedback',
    scenario_id: 'unrelated-feedback',
    feedback_id: `test-history-${index}`,
    retention_key: undefined,
  }));
  safeWriteFile(
    resolveExecutionFeedbackPath(scope),
    JSON.stringify({ ...store, entries: [setting, ...history] })
  );
  expect(setupAskFeedbackActions('recovery', 'new-unrelated-attempt')).toBeDefined();
  expect(loadExecutionFeedbackStore(scope).entries).toHaveLength(500);
  expect(recordSetupAskPreference('guide status conversation')).toMatchObject({
    ok: true,
    learning_enabled: false,
  });
  expect(setupAskFeedbackActions('conversation', 'should-not-issue')).toBeUndefined();
});

it('leaves choices open when the current question negates the stored preference', async () => {
  expect(recordSetupAskPreference('guide preference conversation: channel')?.ok).toBe(true);
  const guidance = await resolveSetupAskGuidanceWithJudgment(
    'Kyberion を通してチーム内ではなく会話するには？',
    true
  );
  expect(guidance?.recommended).toBeUndefined();
  expect(guidance?.explanation?.decision).toBe('negated_request');
});
