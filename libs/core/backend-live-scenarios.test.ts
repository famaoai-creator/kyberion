import { describe, expect, it } from 'vitest';
import {
  formatBackendLiveScenarioTable,
  judgeWordAnswer,
  runBackendLiveScenarios,
  type BackendLiveScenarioRecord,
  type LiveScenarioName,
  type LiveScenarioOutcome,
  type LiveScenarioWorkspace,
  type RunBackendLiveScenariosOptions,
} from './backend-live-scenarios.js';
import { buildBackendCapabilityHonestyReport } from './backend-capability-honesty.js';
import { BACKEND_CAPABILITY_PROFILES } from './backend-capability-profile.js';
import { stubReasoningBackend } from './reasoning/reasoning-backend.js';
import type {
  ReasoningBackend,
  ReasoningCallOptions,
} from './reasoning/reasoning-backend-contracts.js';
import { createDelegationHandle } from './delegated-task-observability.js';
import { DelegationAbortedError } from './mission/delegation-concurrency.js';
import { bindReasoningRequestTimeout } from './reasoning/reasoning-fixed-binding.js';

const NONCE = 'n0nce';
const RECALL = /first message/u;

type AbortBehaviour =
  /** delegateTask rejects, after its child exited, when the signal fires (a CLI adapter). */
  | 'honours-signal'
  /** delegateTask rejects with a bare AbortError; no child exit is reported. */
  | 'rejects-without-exit'
  /** The adapter signalled its child, which survived SIGKILL. */
  | 'child-survives'
  /** delegateTask never looks at the signal and keeps running. */
  | 'ignores-signal'
  /** delegateTask settles before the abort can be sent. */
  | 'settles-early';

interface StubBehaviour {
  /** Answer the session-recall question with the first word. */
  remembers?: boolean | 'verbose';
  /** Echo the whole transcript at the end of every answer (stale replay). */
  echoesTranscript?: boolean;
  /** Return the prompt itself as the answer. */
  echoesPrompt?: boolean | 'after-reset';
  /** Answer that ignores the requested word. */
  refuses?: boolean;
  /** Return an empty answer to every prompt. */
  silent?: boolean;
  /** Throw from every prompt (rate limit, auth, network). */
  throws?: boolean;
  /** Never settle a prompt. */
  hangs?: boolean;
  /** Fail the follow-up N times before behaving. */
  followUpFailuresBeforePass?: number;
  resetSession?: boolean;
  /** Expose delegateTaskHandle (the real createDelegationHandle) with this delegateTask behaviour. */
  abort?: AbortBehaviour;
  /** Write the requested artifact. */
  writesArtifact?: boolean;
  /** The artifact delegation never settles. */
  artifactHangs?: boolean;
}

interface StubObservations {
  prompts: string[];
  signals: AbortSignal[];
  lastPrompt: string;
  events: string[];
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** Deterministic, in-memory session backend — never a real model. */
function stubSessionBackend(behaviour: StubBehaviour, files: Map<string, string>) {
  let history: string[] = [];
  let wasReset = false;
  let followUpFailures = behaviour.followUpFailuresBeforePass ?? 0;
  const seen: StubObservations = { prompts: [], signals: [], lastPrompt: '', events: [] };
  // The shared stub ships delegateTaskHandle/resetSession surfaces of its own;
  // drop them so each behaviour opts in explicitly.
  const {
    delegateTaskHandle: _inheritedHandle,
    resetSession: _inheritedReset,
    ...baseStub
  } = stubReasoningBackend;
  const backend: ReasoningBackend = {
    ...baseStub,
    name: 'live-stub',
    async prompt(prompt: string, options?: ReasoningCallOptions) {
      seen.prompts.push(prompt);
      seen.lastPrompt = prompt;
      if (options?.signal) seen.signals.push(options.signal);
      if (behaviour.hangs) return new Promise<string>(() => {});
      if (behaviour.throws) throw new Error('429 rate limited');
      if (behaviour.silent) return '';
      if (
        behaviour.echoesPrompt === true ||
        (behaviour.echoesPrompt === 'after-reset' && wasReset)
      ) {
        return prompt;
      }
      if (behaviour.refuses) return 'I will not echo arbitrary strings.';
      let answer: string;
      if (RECALL.test(prompt)) {
        answer =
          behaviour.remembers === 'verbose'
            ? `In your first message of this conversation you asked me to reply with ${history[0] ?? 'nothing'}.`
            : behaviour.remembers
              ? (history[0] ?? 'nothing')
              : 'I do not know.';
      } else {
        const word = /Reply with exactly: (\S+)/u.exec(prompt)?.[1] ?? '';
        if (word.startsWith('M2-') && followUpFailures > 0) {
          followUpFailures -= 1;
          answer = 'sorry, lost';
        } else {
          answer = word;
        }
        history.push(word);
      }
      return behaviour.echoesTranscript ? `${history.join(' ')} ${answer}` : answer;
    },
    async delegateTask(instruction: string, _context?: string, options?: ReasoningCallOptions) {
      const signal = options?.signal;
      if (signal) seen.signals.push(signal);
      const artifact = /absolute path (\S+) containing exactly the text (\S+)/u.exec(instruction);
      if (artifact) {
        if (behaviour.artifactHangs) {
          signal?.addEventListener('abort', () => seen.events.push('artifact-aborted'));
          return new Promise<string>(() => {});
        }
        if (behaviour.writesArtifact) files.set(artifact[1]!, artifact[2]!);
        return 'DONE';
      }
      // The long abort delegation.
      if (behaviour.abort === 'settles-early') return 'counted';
      if (behaviour.abort === 'ignores-signal') return new Promise<string>(() => {});
      const stopError = () =>
        behaviour.abort === 'rejects-without-exit'
          ? abortError()
          : new DelegationAbortedError(
              behaviour.abort === 'child-survives' ? 'not_exited' : 'exited',
              { signal: 'SIGTERM', graceMs: 5 }
            );
      return new Promise<string>((_, reject) => {
        if (signal?.aborted) reject(stopError());
        signal?.addEventListener('abort', () => reject(stopError()));
      });
    },
  };
  if (behaviour.resetSession) {
    backend.resetSession = () => {
      history = [];
      wasReset = true;
    };
  }
  if (behaviour.abort) {
    // The real handle: cancel() would report `cancelled` whatever the provider
    // does, which is exactly why the scenario must not judge from it.
    backend.delegateTaskHandle = (instruction, context, options) =>
      createDelegationHandle({
        instruction,
        backendName: 'live-stub',
        execute: (signal) =>
          backend.delegateTask(instruction, context, { ...options, ...(signal ? { signal } : {}) }),
      });
  }
  return { backend, seen };
}

function harness(
  behaviour: StubBehaviour,
  overrides: Partial<RunBackendLiveScenariosOptions> = {}
) {
  const files = new Map<string, string>();
  const { backend, seen } = stubSessionBackend(behaviour, files);
  const workspace = (): LiveScenarioWorkspace => ({
    path: '/fake-workspace/ws-1',
    release: () => seen.events.push('released'),
  });
  const run = () =>
    runBackendLiveScenarios(backend, {
      mode: 'claude-cli',
      nonce: NONCE,
      runId: 'run-1',
      now: () => '2026-11-05T00:00:00.000Z',
      turnTimeoutMs: 1_000,
      abortTimeoutMs: 50,
      abortStartDelayMs: 1,
      createWorkspace: workspace,
      readFile: (file) => files.get(file),
      ...overrides,
    });
  return { run, seen };
}

function outcome(record: BackendLiveScenarioRecord, name: LiveScenarioName) {
  return record.scenarios.find((scenario) => scenario.scenario === name)!;
}

const HEALTHY: StubBehaviour = {
  remembers: true,
  resetSession: true,
  abort: 'honours-signal',
  writesArtifact: true,
};

describe('judgeWordAnswer', () => {
  it('accepts the bare word, a quoted word, or a short answer carrying it', () => {
    expect(judgeWordAnswer('M1-x', 'M1-x')).toBe('word');
    expect(judgeWordAnswer('  "M1-x".\n', 'M1-x')).toBe('word');
    expect(judgeWordAnswer('Sure: M1-x', 'M1-x')).toBe('word');
  });

  it('rejects a prompt echo and a long answer that merely contains the word', () => {
    expect(judgeWordAnswer('Reply with exactly: M1-x', 'M1-x')).toBe('echo');
    expect(judgeWordAnswer(`${'blah '.repeat(30)}M1-x`, 'M1-x')).toBe('absent');
    expect(judgeWordAnswer('M2-x', 'M1-x')).toBe('absent');
  });

  it('strips decoration linearly on hostile whitespace runs', () => {
    expect(judgeWordAnswer('**M1-x**!', 'M1-x')).toBe('word');
    expect(judgeWordAnswer('\u3000"M1-x"\u3000', 'M1-x')).toBe('word');
    // CodeQL js/polynomial-redos input shape: a long tab run that is not at the end.
    const hostile = `M1-x${'\t'.repeat(200_000)}y`;
    expect(judgeWordAnswer(hostile, 'M1-x')).toBe('absent');
  });
});

describe('backend live scenarios (MSN-HARNESS-ADOPT R1)', () => {
  it('passes every scenario on a backend that keeps its session, resets, aborts and writes', async () => {
    const record = await harness(HEALTHY).run();
    expect(record.scenarios.map((scenario) => [scenario.scenario, scenario.outcome])).toEqual([
      ['first', 'pass'],
      ['follow_up', 'pass'],
      ['reset_continue', 'pass'],
      ['abort', 'pass'],
      ['artifact', 'pass'],
    ]);
    expect(outcome(record, 'reset_continue').continuity_after_reset).toBe('lost');
    expect(record.served_model).toBe('unreported');
    expect(outcome(record, 'first').first_try).toBeUndefined();
  });

  it('fails a follow-up that replays the first answer even though it contains M2', async () => {
    const record = await harness({ ...HEALTHY, echoesTranscript: true }).run();
    const followUp = outcome(record, 'follow_up');
    expect(followUp.outcome).toBe('fail');
    expect(followUp.detail).toMatch(/repeats the first turn/u);
    expect(followUp.answer_excerpt).toContain(`M2-${NONCE}`);
    // The recall turn was never asked, so this says nothing about continuity.
    expect(followUp.continuity).toBe('unreported');
  });

  it('records continuity only from the recall turn', async () => {
    const held = await harness(HEALTHY).run();
    expect(outcome(held, 'follow_up').continuity).toBe('held');
    const forgot = await harness({ ...HEALTHY, remembers: false }).run();
    expect(outcome(forgot, 'follow_up').continuity).toBe('absent');
    const ignoredM2 = await harness(
      { ...HEALTHY, followUpFailuresBeforePass: 5 },
      { retries: 0 }
    ).run();
    expect(outcome(ignoredM2, 'follow_up')).toMatchObject({
      outcome: 'fail',
      continuity: 'unreported',
    });
  });

  it('judges from the answer, not the prompt: a refusal fails first and cascades not_run', async () => {
    const { run, seen } = harness({ ...HEALTHY, refuses: true });
    const record = await run();
    // The prompt carries the word; the answer does not — that must be a fail.
    expect(seen.prompts[0]).toContain(`M1-${NONCE}`);
    expect(outcome(record, 'first').outcome).toBe('fail');
    for (const name of ['follow_up', 'reset_continue', 'abort', 'artifact'] as const) {
      expect(outcome(record, name)).toMatchObject({ outcome: 'not_run', attempts: 0 });
    }
  });

  it('fails first on a prompt-echo backend, so reset_continue and abort never pass', async () => {
    const record = await harness({ ...HEALTHY, echoesPrompt: true }).run();
    expect(outcome(record, 'first')).toMatchObject({ outcome: 'fail', attempts: 2 });
    expect(outcome(record, 'first').detail).toMatch(/repeats the prompt/u);
    expect(outcome(record, 'reset_continue').outcome).toBe('not_run');
    expect(outcome(record, 'abort').outcome).toBe('not_run');
  });

  it('does not pass reset_continue when the backend echoes prompts after the reset', async () => {
    const record = await harness({ ...HEALTHY, echoesPrompt: 'after-reset' }).run();
    expect(outcome(record, 'follow_up').outcome).toBe('pass');
    const reset = outcome(record, 'reset_continue');
    expect(reset.outcome).toBe('fail');
    expect(reset.detail).toMatch(/repeats the prompt/u);
    expect(reset.continuity_after_reset).toBe('unreported');
  });

  it('reports an empty answer as unreported, never as a pass, and cascades', async () => {
    const record = await harness({ silent: true }).run();
    expect(outcome(record, 'first')).toMatchObject({
      outcome: 'unreported',
      first_try: 'unreported',
      attempts: 2,
    });
    expect(outcome(record, 'follow_up').outcome).toBe('not_run');
  });

  it('scores a thrown turn error as unreported, not as a capability failure', async () => {
    const record = await harness({ throws: true }).run();
    expect(outcome(record, 'first')).toMatchObject({ outcome: 'unreported', attempts: 2 });
    expect(outcome(record, 'first').detail).toMatch(/errored, not judged: 429 rate limited/u);
  });

  it('scores a timed-out turn as unreported and aborts the turn it gave up on', async () => {
    const { run, seen } = harness({ hangs: true }, { turnTimeoutMs: 10, retries: 0 });
    const record = await run();
    expect(outcome(record, 'first')).toMatchObject({ outcome: 'unreported', attempts: 1 });
    expect(outcome(record, 'first').detail).toMatch(/timed out/u);
    expect(seen.signals[0]?.aborted).toBe(true);
  });

  it('passes a verbose but correct recall: the recall prompt cannot leak the word', async () => {
    const record = await harness({ ...HEALTHY, remembers: 'verbose' }).run();
    const followUp = outcome(record, 'follow_up');
    expect(followUp).toMatchObject({ outcome: 'pass', attempts: 1 });
    expect(followUp.answer_excerpt).toContain(`asked me to reply with M1-${NONCE}`);
    // After the reset the same verbose style no longer names M1: continuity lost.
    expect(outcome(record, 'reset_continue')).toMatchObject({
      outcome: 'pass',
      continuity_after_reset: 'lost',
    });
  });

  it('retries a failing scenario once and keeps first_try', async () => {
    const record = await harness({ ...HEALTHY, followUpFailuresBeforePass: 1 }).run();
    expect(outcome(record, 'follow_up')).toMatchObject({
      outcome: 'pass',
      first_try: 'fail',
      attempts: 2,
    });
  });

  it('fails session continuity when the backend forgets, and then skips reset_continue', async () => {
    const record = await harness({ ...HEALTHY, remembers: false }).run();
    expect(outcome(record, 'follow_up')).toMatchObject({
      outcome: 'fail',
      first_try: 'fail',
      attempts: 2,
    });
    expect(outcome(record, 'reset_continue')).toMatchObject({ outcome: 'not_run', attempts: 0 });
    expect(outcome(record, 'reset_continue').detail).toMatch(/follow_up did not pass/u);
  });

  it('records not_run for reset and abort when the backend lacks the surface', async () => {
    const record = await harness({ remembers: true }).run();
    expect(outcome(record, 'reset_continue')).toMatchObject({ outcome: 'not_run' });
    expect(outcome(record, 'abort')).toMatchObject({ outcome: 'not_run' });
    expect(outcome(record, 'artifact').outcome).toBe('fail');
  });

  it('never passes abort for a provider that ignores the signal behind a real delegation handle', async () => {
    const record = await harness({ ...HEALTHY, abort: 'ignores-signal' }).run();
    const abort = outcome(record, 'abort');
    expect(abort.outcome).not.toBe('pass');
    // Not retried: the first delegation is still running, a retry would start a second one.
    expect(abort).toMatchObject({ outcome: 'fail', attempts: 1 });
    expect(abort.first_try).toBeUndefined();
    expect(abort.detail).toMatch(/ignored the signal/u);
  });

  it('never passes abort through the request-timeout wrapper, which answers for the provider', async () => {
    // bindReasoningRequestTimeout rejects with the caller's reason the moment
    // the signal fires, whatever the provider does. Through it, a provider that
    // ignores the signal would look like one that stopped.
    const files = new Map<string, string>();
    const { backend } = stubSessionBackend({ ...HEALTHY, abort: 'ignores-signal' }, files);
    const wrapped = bindReasoningRequestTimeout(backend, 60_000);
    const record = await runBackendLiveScenarios(wrapped, {
      mode: 'claude-cli',
      nonce: NONCE,
      turnTimeoutMs: 1_000,
      abortTimeoutMs: 50,
      abortStartDelayMs: 1,
      createWorkspace: () => ({ path: '/fake-workspace/ws-3', release: () => {} }),
      readFile: (file) => files.get(file),
    });
    const abort = outcome(record, 'abort');
    expect(abort.outcome).toBe('unreported');
    expect(abort.detail).toMatch(/forwarded by a wrapper/u);
  });

  it('still passes abort when the provider itself rejects with its own cancellation error', async () => {
    const record = await harness(HEALTHY).run();
    expect(outcome(record, 'abort')).toMatchObject({ outcome: 'pass', attempts: 1 });
    expect(outcome(record, 'abort').detail).toMatch(/observed to exit/u);
  });

  it('does not pass abort on a rejection alone: the child exit must be observed', async () => {
    // A CLI adapter that rejected the moment it sent SIGTERM proved only that
    // it started stopping.
    const record = await harness({ ...HEALTHY, abort: 'rejects-without-exit' }).run();
    const abort = outcome(record, 'abort');
    expect(abort.outcome).toBe('unreported');
    expect(abort.detail).toMatch(/no observed child process exit/u);
  });

  it('fails abort when the child survived SIGKILL', async () => {
    const record = await harness({ ...HEALTHY, abort: 'child-survives' }).run();
    expect(outcome(record, 'abort')).toMatchObject({ outcome: 'fail', attempts: 1 });
    expect(outcome(record, 'abort').detail).toMatch(/still running after SIGKILL/u);
  });

  it('passes an abort error alone only for a backend with no child process', async () => {
    const record = await harness(
      { ...HEALTHY, abort: 'rejects-without-exit' },
      { mode: 'anthropic', requireChildExit: false }
    ).run();
    expect(outcome(record, 'abort')).toMatchObject({ outcome: 'pass', attempts: 1 });
  });

  it('scores abort unreported when the delegation settles before it can be aborted', async () => {
    const record = await harness({ ...HEALTHY, abort: 'settles-early' }).run();
    const abort = outcome(record, 'abort');
    expect(abort.outcome).toBe('unreported');
    expect(abort.detail).toMatch(/before it could be aborted/u);
  });

  it('aborts a timed-out artifact delegation before releasing its workspace', async () => {
    const { run, seen } = harness(
      { ...HEALTHY, artifactHangs: true },
      { turnTimeoutMs: 20, retries: 0 }
    );
    const record = await run();
    expect(outcome(record, 'artifact')).toMatchObject({ outcome: 'unreported' });
    expect(seen.events).toEqual(['artifact-aborted', 'released']);
  });

  it('scores a scenario unreported when another mode served one of its turns', async () => {
    const files = new Map<string, string>();
    const { backend, seen } = stubSessionBackend(HEALTHY, files);
    const record = await runBackendLiveScenarios(backend, {
      mode: 'claude-cli',
      nonce: NONCE,
      turnTimeoutMs: 1_000,
      abortTimeoutMs: 50,
      abortStartDelayMs: 1,
      retries: 0,
      createWorkspace: () => ({ path: '/fake-workspace/ws-2', release: () => {} }),
      readFile: (file) => files.get(file),
      // The chain fails over to codex-cli for the follow-up turn only.
      servedMode: () => (seen.lastPrompt.includes('M2-') ? 'codex-cli' : 'claude-cli'),
      servedModel: () => 'claude-opus-5-5',
    });
    expect(outcome(record, 'first')).toMatchObject({
      outcome: 'pass',
      served_modes: ['claude-cli'],
    });
    const followUp = outcome(record, 'follow_up');
    expect(followUp.outcome).toBe('unreported');
    expect(followUp.detail).toMatch(/served by codex-cli instead of claude-cli/u);
    expect(followUp.served_modes).toEqual(expect.arrayContaining(['codex-cli', 'claude-cli']));
    expect(record.served_model).toBe('claude-opus-5-5');
  });

  it('renders a Markdown table with the first try visible', async () => {
    const record = await harness({ ...HEALTHY, followUpFailuresBeforePass: 1 }).run();
    const table = formatBackendLiveScenarioTable([record]);
    expect(table.split('\n')[0]).toBe(
      '| mode | model | served_model | first | follow_up | reset_continue | abort | artifact |'
    );
    expect(table).toContain('pass (first try: fail)');
  });
});

describe('backend capability honesty — live scenario evidence', () => {
  const modes = Object.keys(BACKEND_CAPABILITY_PROFILES);
  // A mode that declares both capabilities, and one that declares no session continuity.
  const mode = modes.find(
    (candidate) =>
      BACKEND_CAPABILITY_PROFILES[candidate]!.capabilities.session_continuity &&
      BACKEND_CAPABILITY_PROFILES[candidate]!.capabilities.abort
  );
  const sessionlessMode = modes.find(
    (candidate) => !BACKEND_CAPABILITY_PROFILES[candidate]!.capabilities.session_continuity
  );

  function record(
    outcomes: Partial<Record<LiveScenarioName, LiveScenarioOutcome>>,
    extra: Partial<BackendLiveScenarioRecord> = {}
  ): BackendLiveScenarioRecord {
    return {
      version: '1.0.0',
      run_id: 'r',
      mode: mode!,
      backend_name: 'stub',
      model_requested: 'model-a',
      served_model: 'unreported',
      started_at: '2026-11-05T00:00:00.000Z',
      finished_at: '2026-11-05T00:00:01.000Z',
      scenarios: Object.entries(outcomes).map(([scenario, value]) => ({
        scenario: scenario as LiveScenarioName,
        outcome: value!,
        attempts: 1,
        detail: '',
        duration_ms: 0,
        // What the runner writes when the recall turn decided the follow_up.
        ...(scenario === 'follow_up' && value === 'pass' ? { continuity: 'held' as const } : {}),
        ...(scenario === 'follow_up' && value === 'fail' ? { continuity: 'absent' as const } : {}),
      })),
      ...extra,
    };
  }

  function report(records: BackendLiveScenarioRecord[]) {
    return buildBackendCapabilityHonestyReport({
      fitnessRecords: [],
      liveScenarioRecords: records,
    });
  }

  function claim(built: ReturnType<typeof report>, capability: string, forMode = mode) {
    return built.capability_claims.find(
      (entry) => entry.mode === forMode && entry.capability === capability
    )!;
  }

  function capabilityViolations(built: ReturnType<typeof report>) {
    return built.violations.filter((violation) => violation.kind === 'contradicted_capability');
  }

  it('has modes to exercise both declared and undeclared capabilities', () => {
    expect(mode).toBeDefined();
    expect(sessionlessMode).toBeDefined();
  });

  it('keeps declarations unproven when nothing was measured', () => {
    const built = report([]);
    expect(claim(built, 'session_continuity').verdict).toBe('unproven');
    expect(capabilityViolations(built)).toEqual([]);
  });

  it('confirms a declared capability a run passed', () => {
    const built = report([record({ first: 'pass', follow_up: 'pass', abort: 'pass' })]);
    expect(claim(built, 'abort').verdict).toBe('confirmed');
    expect(claim(built, 'session_continuity')).toMatchObject({
      verdict: 'confirmed',
      evidence_scenario: 'follow_up',
      evidence_models: ['model-a'],
    });
  });

  it('flags a declared capability measured false as a violation', () => {
    const built = report([record({ first: 'pass', follow_up: 'fail' })]);
    expect(claim(built, 'session_continuity').verdict).toBe('contradicted');
    expect(built.violations).toContainEqual(
      expect.objectContaining({ kind: 'contradicted_capability', mode })
    );
  });

  it('does not contradict continuity on a follow_up that failed before its recall turn', () => {
    const m2Failure = record({ first: 'pass', follow_up: 'fail' });
    m2Failure.scenarios[1]!.continuity = 'unreported';
    expect(claim(report([m2Failure]), 'session_continuity').verdict).toBe('unproven');
    // A record written before `continuity` existed cannot say which turn failed.
    const legacy = record({ first: 'pass', follow_up: 'fail' });
    delete legacy.scenarios[1]!.continuity;
    expect(claim(report([legacy]), 'session_continuity').verdict).toBe('unproven');
    expect(capabilityViolations(report([m2Failure, legacy]))).toEqual([]);
  });

  it('never counts not_run or unreported as evidence', () => {
    const built = report([
      record({ first: 'unreported', follow_up: 'not_run', abort: 'unreported' }),
    ]);
    expect(claim(built, 'session_continuity').verdict).toBe('unproven');
    expect(claim(built, 'abort').verdict).toBe('unproven');
  });

  it('lets a newer pass supersede an older fail for the same mode and model', () => {
    const built = report([
      record(
        { first: 'pass', follow_up: 'fail' },
        { run_id: 'old', finished_at: '2026-11-01T00:00:00.000Z' }
      ),
      record(
        { first: 'pass', follow_up: 'pass' },
        { run_id: 'new', finished_at: '2026-11-05T00:00:00.000Z' }
      ),
    ]);
    expect(claim(built, 'session_continuity').verdict).toBe('confirmed');
    expect(capabilityViolations(built)).toEqual([]);
  });

  it('lets a newer fail supersede an older pass for the same mode and model', () => {
    const built = report([
      record(
        { first: 'pass', follow_up: 'fail' },
        { run_id: 'new', finished_at: '2026-11-05T00:00:00.000Z' }
      ),
      record(
        { first: 'pass', follow_up: 'pass' },
        { run_id: 'old', finished_at: '2026-11-01T00:00:00.000Z' }
      ),
    ]);
    expect(claim(built, 'session_continuity').verdict).toBe('contradicted');
    expect(capabilityViolations(built)).toHaveLength(1);
  });

  it('attributes mixed outcomes on one mode to the model that failed', () => {
    const built = report([
      record({ first: 'pass', follow_up: 'pass' }, { model_requested: 'model-a' }),
      record({ first: 'pass', follow_up: 'fail' }, { model_requested: 'model-b' }),
    ]);
    expect(claim(built, 'session_continuity')).toMatchObject({
      verdict: 'contradicted',
      evidence_models: ['model-b'],
    });
  });

  it('reports an under-claimed capability without a violation', () => {
    const built = report([
      record({ first: 'pass', follow_up: 'pass' }, { mode: sessionlessMode! }),
    ]);
    expect(claim(built, 'session_continuity', sessionlessMode)).toMatchObject({
      declared: false,
      verdict: 'contradicted',
    });
    expect(capabilityViolations(built)).toEqual([]);
  });
});
