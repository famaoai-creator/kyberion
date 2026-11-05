import { describe, expect, it } from 'vitest';
import {
  ConversationEngine,
  type ConversationEngineOptions,
  type EndOfTurnHold,
  type InteractionEvent,
  type InterruptionArbiter,
} from './conversation-engine.js';
import { languagePackFromSource } from './language-pack.js';

const ja = languagePackFromSource('ja', {
  uses_word_spaces: false,
  continuation_particles: ['けど', 'て', 'が'],
  eot_fillers: ['えーと'],
  commit_endings: ['です', 'ます', 'か'],
  respond_gate_fillers: ['えーと', 'あの'],
  barge_in_backchannels: ['うん', 'うんうん'],
  correction_markers: ['いや', '違う'],
  hold_markers: ['ちょっと待って', '待って'],
  agent_backchannels: ['うん', 'はい', 'なるほど'],
});

function makeEngine(options: Partial<ConversationEngineOptions> = {}): ConversationEngine {
  return new ConversationEngine({ packs: [ja], intent: true, ...options });
}

function run(engine: ConversationEngine, inputs: InteractionEvent[]) {
  return inputs.flatMap((input) =>
    engine.step(input).map((action) => ({ at: input.at_ms, action }))
  );
}

describe('ConversationEngine', () => {
  it('exposes the single interaction state (CE-01)', () => {
    const engine = makeEngine();
    expect(engine.state).toBe('listening');
    engine.step({ type: 'output_started', at_ms: 0, text: '説明します。' });
    expect(engine.state).toBe('speaking');
    engine.step({ type: 'output_ended', at_ms: 1000 });
    expect(engine.state).toBe('listening');
  });

  it('maps a held unfinished turn to holding', () => {
    const eot: EndOfTurnHold = {
      pending: 'それはなんだけど',
      offer: (text) => ({ commit: false, text }),
      tick: () => null,
      reset: () => undefined,
    };
    const engine = makeEngine({ eot });
    run(engine, [
      { type: 'speech_onset', at_ms: 0 },
      { type: 'transcript_final', at_ms: 400, text: 'それはなんだけど' },
    ]);
    expect(engine.state).toBe('holding');
  });

  it('attaches utterance intent to commits when enabled (CE-04)', () => {
    const engine = makeEngine();
    const actions = engine.step({ type: 'transcript_final', at_ms: 0, text: 'ちょっと待って' });
    expect(actions).toEqual([
      { type: 'commit', text: 'ちょっと待って', intent: 'holding', pure: true },
    ]);
  });

  it('omits intent metadata when intent is disabled', () => {
    const engine = new ConversationEngine({ packs: [ja], intent: false });
    const actions = engine.step({ type: 'transcript_final', at_ms: 0, text: 'ちょっと待って' });
    expect(actions).toEqual([{ type: 'commit', text: 'ちょっと待って' }]);
  });

  it('emits agent backchannels while the remote party holds the floor (CE-05)', () => {
    const engine = makeEngine({
      backchannel: { enabled: true, minSpeechMs: 1000, minIntervalMs: 3000, maxPerUtterance: 2 },
    });
    const actions = run(engine, [
      { type: 'speech_onset', at_ms: 0 },
      { type: 'tick', at_ms: 500 },
      { type: 'transcript_partial', at_ms: 600, text: 'それでですね' },
      { type: 'tick', at_ms: 1000 },
      { type: 'tick', at_ms: 2000 },
      { type: 'tick', at_ms: 4000 },
      { type: 'tick', at_ms: 6000 },
    ]);
    const emitted = actions.filter((a) => a.action.type === 'emit_backchannel');
    expect(emitted).toEqual([
      { at: 1000, action: { type: 'emit_backchannel', text: 'うん' } },
      { at: 4000, action: { type: 'emit_backchannel', text: 'はい' } },
    ]);
    // While the remote speaks without interruption, the floor stays theirs.
    expect(engine.state).toBe('listening');
  });

  it('reports continuous signals (CE-03)', () => {
    const engine = makeEngine();
    engine.step({ type: 'transcript_final', at_ms: 0, text: '明日の予定を教えて。' });
    const signals = engine.signals;
    for (const value of Object.values(signals)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(signals.end_of_turn_probability).toBeGreaterThan(0.5);
  });

  it('tracks state as backchannel while emitting a reaction', () => {
    const engine = makeEngine({ backchannel: { enabled: true, minSpeechMs: 100 } });
    run(engine, [
      { type: 'speech_onset', at_ms: 0 },
      { type: 'tick', at_ms: 200 },
    ]);
    engine.step({ type: 'reaction_started', at_ms: 250, text: 'うん' });
    expect(engine.state).toBe('backchannel');
    engine.step({ type: 'reaction_ended', at_ms: 600 });
    expect(engine.state).toBe('listening');
  });

  it('exposes rhythm adjustments once enough utterances are sampled (CE-07)', () => {
    const engine = makeEngine({ rhythm: { minSamples: 2 } });
    expect(engine.rhythmAdjustments()).toBeNull();
    run(engine, [
      { type: 'speech_onset', at_ms: 0 },
      { type: 'speech_offset', at_ms: 1000 },
      { type: 'speech_onset', at_ms: 5000 },
      { type: 'speech_offset', at_ms: 6000 },
    ]);
    const adjustments = engine.rhythmAdjustments();
    expect(adjustments).not.toBeNull();
    expect(adjustments!.maxHoldMs).toBeGreaterThanOrEqual(750);
  });

  it('accepts the legacy voice event names', () => {
    const engine = makeEngine();
    const actions = engine.step({ type: 'stt_final', at_ms: 0, text: '予定を教えて' });
    expect(actions.map((a) => a.type)).toEqual(['commit']);
  });
});

describe('ConversationEngine with injected arbiter', () => {
  it('drives an injected interruption arbiter during output', () => {
    const calls: string[] = [];
    const arbiter: InterruptionArbiter = {
      state: 'listening',
      observeVadStart() {
        calls.push('vad_start');
        this.state = 'paused';
        return [{ type: 'pause_tts' }];
      },
      observeVadEnd() {
        return [];
      },
      observePartial() {
        calls.push('partial');
        this.state = 'stopped';
        return [{ type: 'hard_stop', words: 'いや、違う' }];
      },
      tick() {
        return [];
      },
      reset() {
        this.state = 'listening';
      },
    };
    const engine = makeEngine({ interruption: arbiter });
    engine.step({ type: 'output_started', at_ms: 0, text: '説明します。' });
    const pause = engine.step({ type: 'speech_onset', at_ms: 500, rms: 4000 });
    expect(pause).toEqual([{ type: 'pause_tts' }]);
    expect(engine.state).toBe('yielding');
    const stop = engine.step({ type: 'transcript_partial', at_ms: 700, text: 'いや、違う' });
    expect(stop).toEqual([{ type: 'hard_stop', words: 'いや、違う', intent: 'correcting' }]);
    expect(engine.speaking).toBe(false);
    expect(engine.signals.interruption_probability).toBeGreaterThan(0);
    expect(calls).toEqual(['vad_start', 'partial']);
  });
});
