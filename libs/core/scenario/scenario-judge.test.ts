import { describe, expect, it, vi } from 'vitest';
import {
  assertJudgeIndependent,
  evaluateJudgeCheck,
  evaluateJudgeIndependence,
  JudgeIndependenceError,
  observedActorBackends,
  parseJudgeResponse,
  runJudge,
  type JudgeBackend,
} from './scenario-judge.js';
import {
  appendScenarioReasoning,
  createScenarioSideEffectLog,
} from './scenario-side-effect-log.js';

function judge(
  name: string,
  ...responses: string[]
): JudgeBackend & { prompt: ReturnType<typeof vi.fn> } {
  const prompt = vi.fn(async () => responses.shift() ?? 'no json');
  return { name, prompt };
}

describe('scenario judge independence (ES-06)', () => {
  it('rejects a judge that also served the actor, case-insensitively', () => {
    expect(
      evaluateJudgeIndependence({ actorBackends: ['Claude-CLI'], judgeBackend: 'claude-cli' })
        .status
    ).toBe('self_graded');
    expect(() =>
      assertJudgeIndependent({ actorBackends: ['claude-cli'], judgeBackend: 'claude-cli' })
    ).toThrow(JudgeIndependenceError);
  });

  it('is unavailable (and asserting throws) when nothing was observed', () => {
    expect(evaluateJudgeIndependence({ actorBackends: [], judgeBackend: 'grok-cli' }).status).toBe(
      'unavailable'
    );
    expect(
      evaluateJudgeIndependence({ actorBackends: undefined, judgeBackend: 'grok-cli' }).status
    ).toBe('unavailable');
    expect(evaluateJudgeIndependence({ actorBackends: ['a'], judgeBackend: '' }).status).toBe(
      'unavailable'
    );
    expect(() => assertJudgeIndependent({ actorBackends: [], judgeBackend: 'grok-cli' })).toThrow(
      '[SCENARIO_JUDGE_NOT_INDEPENDENT] unavailable'
    );
  });

  it('accepts a distinct judge', () => {
    expect(
      assertJudgeIndependent({ actorBackends: ['claude-cli'], judgeBackend: 'grok-cli' }).status
    ).toBe('independent');
  });

  it('collects observed actor names from the reasoning log and served modes', () => {
    const log = createScenarioSideEffectLog();
    appendScenarioReasoning(log, {
      method: 'prompt',
      backend: 'scenario-fixtures',
      prompt_hash: 'h',
      prompt_length: 1,
      outcome: 'fixture',
    });
    expect(
      observedActorBackends(log, [null, { mode: 'Codex-CLI', failover: true }, undefined])
    ).toEqual(['codex-cli', 'scenario-fixtures']);
  });
});

describe('runJudge (ES-06)', () => {
  it('parses the score, retries unparseable answers, and applies minScore', async () => {
    const backend = judge('grok-cli', 'not json', 'noise {"score": 0.8, "reason": "ok"} tail');
    const result = await runJudge(
      { rubric: 'be helpful', transcript: 'did the thing', minScore: 0.7 },
      { judgeBackend: backend }
    );
    expect(result).toEqual({ score: 0.8, reason: 'ok', pass: true, attempts: 2 });
    expect(backend.prompt.mock.calls[0]?.[0]).toContain('RUBRIC:\nbe helpful');
  });

  it('fails after bounded attempts without inventing a score', async () => {
    await expect(
      runJudge(
        { rubric: 'r', transcript: 't', minScore: 0.5 },
        { judgeBackend: judge('grok-cli', '{"score": 2}', '{}', 'x') }
      )
    ).rejects.toThrow('[SCENARIO_JUDGE_UNPARSEABLE]');
    expect(parseJudgeResponse('{"score": -0.1}')).toBeNull();
  });

  it('never calls a judge that is not independent', async () => {
    const backend = judge('claude-cli', '{"score": 1}');
    const selfGraded = await evaluateJudgeCheck(
      { rubric: 'r', minScore: 0.5 },
      't',
      ['claude-cli'],
      backend
    );
    expect(selfGraded).toMatchObject({ type: 'judge', pass: false });
    expect(selfGraded.detail).toContain('self_graded');
    const unavailable = await evaluateJudgeCheck({ rubric: 'r', minScore: 0.5 }, 't', [], backend);
    expect(unavailable.detail).toContain('unavailable');
    expect(backend.prompt).not.toHaveBeenCalled();

    const independent = await evaluateJudgeCheck(
      { rubric: 'r', minScore: 0.9 },
      't',
      ['codex-cli'],
      judge('grok-cli', '{"score": 0.5, "reason": "weak"}')
    );
    expect(independent).toMatchObject({ pass: false, detail: 'score 0.5 (min 0.9) by grok-cli' });
  });
});
