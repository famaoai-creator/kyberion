import { describe, expect, it, vi } from 'vitest';

// CD-09 review: a needs-driven retry quotes the first reply back to the
// worker, and that prompt is recorded as mission-visible (public by
// default). The quoted excerpt must not carry customer_decisions, and a retry
// that omits them keeps the first attempt's.
const mocks = vi.hoisted(() => ({ route: vi.fn() }));
vi.mock('../mesh/a2a-bridge.js', () => ({ a2aBridge: { route: mocks.route } }));
import {
  obtainTaskResultResponse,
  type MissionVisiblePromptInput,
  type TaskResultResponseDeps,
} from './mission-orchestration-task-response.js';
import { buildTaskResultRetryPrompt } from './mission-orchestration-worker-part-context.js';
import {
  extractTaskResultBlocks,
  redactCustomerDecisionsForPrompt,
} from '../task/task-result-contract.js';

const DECISION = {
  question: 'Which secret colour theme?',
  item: 'UX',
  key: 'ui.theme',
  proposed_value: 'secret-dark',
  requires_customer: false,
};
const block = (value: Record<string, unknown>) =>
  ['```task_result', JSON.stringify(value), '```'].join('\n');
const result = (overrides: Record<string, unknown> = {}) => ({
  summary: 'done',
  artifacts: [],
  verification_done: ['checked'],
  gaps: [],
  needs: [],
  ...overrides,
});

function deps(recorded: MissionVisiblePromptInput[]): TaskResultResponseDeps {
  return {
    recordMissionVisiblePrompt: (input) => recorded.push(input),
    resolveTaskDispatchTimeoutMs: () => 1000,
    parseTaskResultResponse: (text) => {
      const parsed = extractTaskResultBlocks(text);
      return {
        taskResult: parsed.taskResults[0],
        parseErrors: parsed.taskResultErrors,
        surfaceParseErrors: [],
      };
    },
    buildNeedsKnowledgeReinforcementLines: async () => [],
    buildTaskResultRetryPrompt,
    stampTaskResultProvenance: () => undefined,
  };
}

const input = {
  missionId: 'MSN-CD09-RETRY',
  task: { task_id: 'T1', description: 'build the widget' } as never,
  teamRole: 'implementer',
  agentId: 'agent-1',
  prompt: 'do the work',
};

describe('task result retry and customer decisions (CD-09)', () => {
  it('records a retry prompt without the question or value, and keeps the first decisions', async () => {
    mocks.route
      .mockResolvedValueOnce({
        payload: {
          text: `Notes.\n${block(result({ needs: ['api_key'], customer_decisions: [DECISION] }))}`,
        },
      })
      .mockResolvedValueOnce({ payload: { text: block(result()) } });
    const recorded: MissionVisiblePromptInput[] = [];
    const response = await obtainTaskResultResponse(deps(recorded), input);
    expect(response.retried).toBe(true);
    const retry = recorded.find((entry) => entry.form === 'task_result_retry');
    expect(retry?.content).toContain('customer decisions omitted from this excerpt: 1');
    expect(retry?.content).not.toMatch(/secret|ui\.theme|"UX"/u);
    const sent = JSON.stringify(mocks.route.mock.calls[1]);
    expect(sent).not.toMatch(/secret|ui\.theme/u);
    expect(response.taskResult?.customer_decisions).toEqual([DECISION]);
  });

  it('redacts unparseable blocks and refuses to quote stray mentions', () => {
    expect(
      redactCustomerDecisionsForPrompt('```task_result\n{"customer_decisions": [ broken\n```')
    ).not.toMatch(/broken/u);
    expect(redactCustomerDecisionsForPrompt('{"customer_decisions":[{"question":"q"}]}')).toBe('');
    const plain = block(result());
    expect(redactCustomerDecisionsForPrompt(plain)).toBe(plain);
    // Idempotent: a second pass (two redaction points on one path) keeps the text.
    const once = redactCustomerDecisionsForPrompt(
      block(result({ customer_decisions: [{ question: 'secret q' }] }))
    );
    expect(once).toContain('"summary":"done"');
    expect(redactCustomerDecisionsForPrompt(once)).toBe(once);
    // An escaped key is still the field: parsed first, then redacted.
    const escaped = [
      '```task_result',
      '{"summary":"done","artifacts":[],"verification_done":["c"],"gaps":[],"needs":[],"\\u0063ustomer_decisions":[{"question":"secret q"}]}',
      '```',
    ].join('\n');
    const redacted = redactCustomerDecisionsForPrompt(escaped);
    expect(redacted).not.toMatch(/secret|u0063/u);
    expect(redacted).toContain('"summary":"done"');
    // Unparseable with an escape: not quoted.
    expect(
      redactCustomerDecisionsForPrompt(
        '```task_result\n{"\\u0063ustomer_decisions": [ "secret"\n```'
      )
    ).not.toMatch(/secret/u);
  });
});
