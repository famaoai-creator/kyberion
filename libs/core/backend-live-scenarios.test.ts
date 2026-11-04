import { describe, expect, it } from 'vitest';
import {
  formatBackendLiveScenarioTable,
  runBackendLiveScenarios,
  type BackendLiveScenarioRecord,
  type LiveScenarioName,
  type LiveScenarioWorkspace,
} from './backend-live-scenarios.js';
import { buildBackendCapabilityHonestyReport } from './backend-capability-honesty.js';
import { BACKEND_CAPABILITY_PROFILES } from './backend-capability-profile.js';
import { stubReasoningBackend } from './reasoning/reasoning-backend.js';
import type { ReasoningBackend } from './reasoning/reasoning-backend-contracts.js';
import type { DelegatedTaskRecord, DelegationHandle } from './delegated-task-observability.js';

const NONCE = 'n0nce';
const RECALL = /first message/u;

interface StubBehaviour {
  /** Answer the session-recall question with the first word. */
  remembers?: boolean;
  /** Echo the whole transcript at the end of every answer (stale replay). */
  echoesTranscript?: boolean;
  /** Answer that ignores the requested word. */
  refuses?: boolean;
  /** Return an empty answer to every prompt. */
  silent?: boolean;
  /** Fail the follow-up N times before behaving. */
  followUpFailuresBeforePass?: number;
  resetSession?: boolean;
  /** Provide delegateTaskHandle whose cancel reaches `cancelled`. */
  abortable?: boolean | 'ignores-cancel';
  /** Write the requested artifact. */
  writesArtifact?: boolean;
}

/** Deterministic, in-memory session backend — never a real model. */
function stubSessionBackend(behaviour: StubBehaviour, files: Map<string, string>) {
  let history: string[] = [];
  let followUpFailures = behaviour.followUpFailuresBeforePass ?? 0;
  const prompts: string[] = [];
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
    async prompt(prompt: string) {
      prompts.push(prompt);
      if (behaviour.silent) return '';
      if (behaviour.refuses) return 'I will not echo arbitrary strings.';
      let answer: string;
      if (RECALL.test(prompt)) {
        answer = behaviour.remembers ? (history[0] ?? 'nothing') : 'I do not know.';
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
    async delegateTask(instruction: string) {
      const match = /absolute path (\S+) containing exactly the text (\S+)/u.exec(instruction);
      if (behaviour.writesArtifact && match) files.set(match[1]!, match[2]!);
      return 'DONE';
    },
  };
  if (behaviour.resetSession) {
    backend.resetSession = () => {
      history = [];
    };
  }
  if (behaviour.abortable) {
    backend.delegateTaskHandle = (): DelegationHandle => {
      let status: DelegatedTaskRecord['status'] = 'started';
      let cancelled = false;
      return {
        delegation_id: 'stub-delegation',
        status: () => ({ delegation_id: 'stub-delegation', status }) as DelegatedTaskRecord,
        join: () =>
          new Promise<string>((_, reject) => {
            const poll = setInterval(() => {
              if (cancelled) {
                clearInterval(poll);
                reject(new Error('[DELEGATION_CANCELLED]'));
              }
            }, 1);
          }),
        cancel: async () => {
          if (behaviour.abortable === 'ignores-cancel') return;
          cancelled = true;
          status = 'cancelled';
        },
      };
    };
  }
  return { backend, prompts };
}

function harness(behaviour: StubBehaviour) {
  const files = new Map<string, string>();
  const { backend, prompts } = stubSessionBackend(behaviour, files);
  const workspace = (): LiveScenarioWorkspace => ({ path: '/scratch/ws-1', release: () => {} });
  const run = () =>
    runBackendLiveScenarios(backend, {
      mode: 'claude-cli',
      nonce: NONCE,
      runId: 'run-1',
      now: () => '2026-11-05T00:00:00.000Z',
      turnTimeoutMs: 1_000,
      abortTimeoutMs: 100,
      abortStartDelayMs: 1,
      createWorkspace: workspace,
      readFile: (file) => files.get(file),
    });
  return { run, prompts };
}

function outcome(record: BackendLiveScenarioRecord, name: LiveScenarioName) {
  return record.scenarios.find((scenario) => scenario.scenario === name)!;
}

describe('backend live scenarios (MSN-HARNESS-ADOPT R1)', () => {
  it('passes every scenario on a backend that keeps its session, resets, aborts and writes', async () => {
    const record = await harness({
      remembers: true,
      resetSession: true,
      abortable: true,
      writesArtifact: true,
    }).run();
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
    const record = await harness({ remembers: true, echoesTranscript: true }).run();
    const followUp = outcome(record, 'follow_up');
    expect(followUp.outcome).toBe('fail');
    expect(followUp.detail).toMatch(/repeats the first turn/u);
    expect(followUp.answer_excerpt).toContain(`M2-${NONCE}`);
  });

  it('judges from the answer, not the prompt: a refusal fails first and cascades not_run', async () => {
    const { run, prompts } = harness({ refuses: true });
    const record = await run();
    // The prompt carries the word; the answer does not — that must be a fail.
    expect(prompts[0]).toContain(`M1-${NONCE}`);
    expect(outcome(record, 'first').outcome).toBe('fail');
    for (const name of ['follow_up', 'reset_continue', 'abort', 'artifact'] as const) {
      expect(outcome(record, name)).toMatchObject({ outcome: 'not_run', attempts: 0 });
    }
  });

  it('reports an empty answer as unreported, never as a pass, and cascades', async () => {
    const record = await harness({ silent: true }).run();
    expect(outcome(record, 'first').outcome).toBe('unreported');
    expect(outcome(record, 'first').attempts).toBe(1);
    expect(outcome(record, 'follow_up').outcome).toBe('not_run');
  });

  it('retries a failing scenario once and keeps first_try', async () => {
    const record = await harness({ remembers: true, followUpFailuresBeforePass: 1 }).run();
    expect(outcome(record, 'follow_up')).toMatchObject({
      outcome: 'pass',
      first_try: 'fail',
      attempts: 2,
    });
  });

  it('marks session continuity failed when the backend forgets the first word', async () => {
    const record = await harness({}).run();
    expect(outcome(record, 'follow_up')).toMatchObject({ outcome: 'fail', attempts: 2 });
    expect(outcome(record, 'follow_up').first_try).toBe('fail');
  });

  it('records not_run for reset and abort when the backend lacks the surface', async () => {
    const record = await harness({ remembers: true }).run();
    expect(outcome(record, 'reset_continue')).toMatchObject({ outcome: 'not_run' });
    expect(outcome(record, 'abort')).toMatchObject({ outcome: 'not_run' });
    expect(outcome(record, 'artifact').outcome).toBe('fail');
  });

  it('fails abort when cancel() never reaches a cancelled terminal state', async () => {
    const record = await harness({ remembers: true, abortable: 'ignores-cancel' }).run();
    expect(outcome(record, 'abort').outcome).toBe('fail');
    expect(outcome(record, 'abort').detail).toMatch(/status=started/u);
  });

  it('records the served model only when evidence is supplied', async () => {
    const files = new Map<string, string>();
    const { backend } = stubSessionBackend({ remembers: true }, files);
    const record = await runBackendLiveScenarios(backend, {
      mode: 'claude-cli',
      nonce: NONCE,
      turnTimeoutMs: 1_000,
      createWorkspace: () => ({ path: '/scratch/ws-2', release: () => {} }),
      readFile: () => undefined,
      servedModel: () => 'claude-opus-5-5',
      servedMode: () => 'codex-cli',
    });
    expect(record.served_model).toBe('claude-opus-5-5');
    expect(formatBackendLiveScenarioTable([record])).toContain('served by codex-cli');
  });

  it('renders a Markdown table with the first try visible', async () => {
    const record = await harness({ remembers: true, followUpFailuresBeforePass: 1 }).run();
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
    outcomes: Partial<Record<LiveScenarioName, 'pass' | 'fail' | 'not_run' | 'unreported'>>,
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
      })),
      ...extra,
    };
  }

  function claim(
    report: ReturnType<typeof buildBackendCapabilityHonestyReport>,
    capability: string,
    forMode = mode
  ) {
    return report.capability_claims.find(
      (entry) => entry.mode === forMode && entry.capability === capability
    )!;
  }

  it('has modes to exercise both declared and undeclared capabilities', () => {
    expect(mode).toBeDefined();
    expect(sessionlessMode).toBeDefined();
  });

  it('keeps declarations unproven when nothing was measured', () => {
    const report = buildBackendCapabilityHonestyReport({ liveScenarioRecords: [] });
    expect(claim(report, 'session_continuity').verdict).toBe('unproven');
    expect(report.violations.filter((v) => v.kind === 'contradicted_capability')).toEqual([]);
  });

  it('confirms a declared capability a run passed', () => {
    const report = buildBackendCapabilityHonestyReport({
      liveScenarioRecords: [record({ first: 'pass', follow_up: 'pass', abort: 'pass' })],
    });
    expect(claim(report, 'abort').verdict).toBe('confirmed');
    expect(claim(report, 'session_continuity')).toMatchObject({
      verdict: 'confirmed',
      evidence_scenario: 'follow_up',
      evidence_models: ['model-a'],
    });
  });

  it('flags a declared capability measured false as a violation', () => {
    const report = buildBackendCapabilityHonestyReport({
      liveScenarioRecords: [record({ first: 'pass', follow_up: 'fail' })],
    });
    expect(claim(report, 'session_continuity').verdict).toBe('contradicted');
    expect(report.violations).toContainEqual(
      expect.objectContaining({ kind: 'contradicted_capability', mode })
    );
  });

  it('never counts not_run or unreported as evidence', () => {
    const report = buildBackendCapabilityHonestyReport({
      liveScenarioRecords: [
        record({ first: 'unreported', follow_up: 'not_run', abort: 'unreported' }),
      ],
    });
    expect(claim(report, 'session_continuity').verdict).toBe('unproven');
    expect(claim(report, 'abort').verdict).toBe('unproven');
  });

  it('reports an under-claimed capability without a violation', () => {
    const report = buildBackendCapabilityHonestyReport({
      liveScenarioRecords: [
        record({ first: 'pass', follow_up: 'pass' }, { mode: sessionlessMode! }),
      ],
    });
    expect(claim(report, 'session_continuity', sessionlessMode)).toMatchObject({
      declared: false,
      verdict: 'contradicted',
    });
    expect(report.violations.filter((v) => v.kind === 'contradicted_capability')).toEqual([]);
  });

  it('ignores a run another mode served (failover substitution)', () => {
    const report = buildBackendCapabilityHonestyReport({
      liveScenarioRecords: [
        record({ first: 'pass', follow_up: 'fail' }, { served_mode: 'some-other-mode' }),
      ],
    });
    expect(claim(report, 'session_continuity').verdict).toBe('unproven');
  });
});
