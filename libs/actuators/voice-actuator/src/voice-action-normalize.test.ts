import { describe, expect, it } from 'vitest';
import { normalizeVoiceActionInput, validateVoiceAction } from './voice-action-helpers.js';

/** The envelope the catalog-backed SDK adapter (pipelines / ADF) sends. */
function pipelineEnvelope(op: string, params: Record<string, unknown>) {
  return { action: 'pipeline', steps: [{ type: 'capture', op, params }], context: {} };
}

describe('voice-actuator pipeline step normalization', () => {
  it('wraps params-envelope actions so SDK-dispatched steps pass the voice-action schema', () => {
    for (const [op, params] of [
      ['health', {}],
      ['list_voices', {}],
      ['list_audio_routes', { bus: 'stub' }],
      ['speak_local', { text: 'hello' }],
    ] as const) {
      const normalized = normalizeVoiceActionInput(pipelineEnvelope(op, { ...params }));
      expect((normalized as { steps: unknown[] }).steps[0]).toEqual({ action: op, params });
      expect(() => validateVoiceAction(normalized)).not.toThrow();
    }
  });

  it('keeps flat contracts (generate_voice, sample recording) at the top level', () => {
    const normalized = normalizeVoiceActionInput(
      pipelineEnvelope('record_voice_sample', {
        request_id: 'request-1',
        sample_id: 'sample-1',
        duration_sec: 3,
        export_as: 'sample',
      })
    );
    expect((normalized as { steps: unknown[] }).steps[0]).toEqual({
      action: 'record_voice_sample',
      request_id: 'request-1',
      sample_id: 'sample-1',
      duration_sec: 3,
    });
    expect(() => validateVoiceAction(normalized)).not.toThrow();
  });
});
