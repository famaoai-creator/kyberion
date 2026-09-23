import { describe, expect, it } from 'vitest';
import { pathResolver } from '../libs/core/path-resolver.js';
import {
  loadVoiceWorkbenchScenarios,
  runVoiceWorkbenchScenario,
  type VoiceWorkbenchScenario,
} from '../libs/core/voice-workbench.js';

const FIXTURE_DIR = pathResolver.rootResolve('tests/fixtures/voice-workbench');

const EXPECTED_STATUS: Record<string, 'pass' | 'skipped'> = {
  'echo-does-not-stop': 'pass',
  'ja-continuation-held': 'pass',
  'real-interruption-hard-stop': 'pass',
  'speculative-revoked': 'pass',
  'filler-only-dropped': 'pass',
  'no-stt-fallback-hard-stop': 'pass',
  'requires-real-tts-skipped': 'skipped',
  'en-trailing-and-held': 'pass',
  'backchannel-resumes': 'pass',
};

describe('voice workbench fixtures', () => {
  const scenarios = loadVoiceWorkbenchScenarios(FIXTURE_DIR);

  it('loads every fixture exactly once', () => {
    expect(scenarios.map((scenario) => scenario.id).sort()).toEqual(
      Object.keys(EXPECTED_STATUS).sort()
    );
  });

  for (const scenario of scenarios) {
    it(`${scenario.id} -> ${EXPECTED_STATUS[scenario.id]}`, () => {
      const result = runVoiceWorkbenchScenario(scenario);
      expect(result.failures).toEqual([]);
      expect(result.status).toBe(EXPECTED_STATUS[scenario.id]);
    });
  }

  it('never counts a skipped scenario as a pass', () => {
    const results = scenarios.map((scenario) => runVoiceWorkbenchScenario(scenario));
    const skipped = results.filter((result) => result.status === 'skipped');
    expect(skipped.map((result) => result.id)).toEqual(['requires-real-tts-skipped']);
    for (const result of skipped) {
      expect(result.skip_reason).toMatch(/real_tts/);
      expect(result.metrics).toEqual({ eot_latency_ms: null, false_barge_ins: 0, ttfa_ms: null });
    }
    const passed = results.filter((result) => result.status === 'pass').map((result) => result.id);
    expect(passed).not.toContain('requires-real-tts-skipped');
  });

  it('runs a gated scenario once its requirement is available', () => {
    const gated = scenarios.find((scenario) => scenario.id === 'requires-real-tts-skipped')!;
    expect(runVoiceWorkbenchScenario(gated, { available: new Set(['real_tts']) }).status).toBe(
      'pass'
    );
  });

  it('reports turn-taking metrics', () => {
    const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    const interruption = runVoiceWorkbenchScenario(byId.get('real-interruption-hard-stop')!);
    expect(interruption.metrics).toEqual({ eot_latency_ms: 100, false_barge_ins: 0, ttfa_ms: 300 });
    const echo = runVoiceWorkbenchScenario(byId.get('echo-does-not-stop')!);
    expect(echo.metrics.false_barge_ins).toBe(1);
  });
});

describe('runVoiceWorkbenchScenario', () => {
  it('fails when the observed behaviour diverges from the expectation', () => {
    const scenario: VoiceWorkbenchScenario = {
      id: 'wrong-expectation',
      timeline: [
        { at_ms: 0, event: { type: 'vad_start' } },
        { at_ms: 500, event: { type: 'vad_silence' } },
        { at_ms: 600, event: { type: 'stt_final', text: '会議室を予約してください' } },
      ],
      expect: { commits: ['別の文'], hard_stops: 1, max_eot_latency_ms: 50 },
    };
    const result = runVoiceWorkbenchScenario(scenario);
    expect(result.status).toBe('fail');
    expect(result.failures).toHaveLength(3);
  });
});
