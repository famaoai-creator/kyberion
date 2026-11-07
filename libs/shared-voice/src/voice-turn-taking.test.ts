import { describe, expect, it } from 'vitest';
import { VoiceTurnTakingMachine, type TurnTakingInput } from './voice-turn-taking.js';

function run(machine: VoiceTurnTakingMachine, inputs: TurnTakingInput[]) {
  return inputs.flatMap((input) =>
    machine.step(input).map((action) => ({ at: input.at_ms, action }))
  );
}

describe('VoiceTurnTakingMachine', () => {
  it('commits a complete turn on the STT final', () => {
    const machine = new VoiceTurnTakingMachine();
    const actions = run(machine, [
      { type: 'vad_start', at_ms: 0 },
      { type: 'vad_silence', at_ms: 800 },
      { type: 'stt_final', at_ms: 900, text: '会議室を予約してください' },
    ]);
    expect(actions).toEqual([
      { at: 900, action: { type: 'commit', text: '会議室を予約してください' } },
    ]);
  });

  it('holds a trailing continuation and force-commits after the max hold', () => {
    const machine = new VoiceTurnTakingMachine({ eot: { maxHoldMs: 1_000 } });
    run(machine, [
      { type: 'vad_start', at_ms: 0 },
      { type: 'vad_silence', at_ms: 500 },
    ]);
    expect(machine.step({ type: 'stt_final', at_ms: 600, text: '明日の会議で' })).toEqual([
      { type: 'hold', text: '明日の会議で' },
    ]);
    expect(machine.step({ type: 'tick', at_ms: 1_500 })).toEqual([]);
    expect(machine.step({ type: 'tick', at_ms: 1_600 })).toEqual([
      { type: 'commit', text: '明日の会議で' },
    ]);
  });

  it('does not force-commit held text while the user is still speaking', () => {
    const machine = new VoiceTurnTakingMachine({ eot: { maxHoldMs: 500 } });
    const held = run(machine, [
      { type: 'vad_silence', at_ms: 0 },
      { type: 'stt_final', at_ms: 100, text: '資料が' },
      { type: 'vad_start', at_ms: 300 },
    ]);
    expect(held).toEqual([{ at: 100, action: { type: 'hold', text: '資料が' } }]);
    expect(machine.step({ type: 'tick', at_ms: 2_000 })).toEqual([]);
    machine.step({ type: 'vad_silence', at_ms: 2_100 });
    expect(machine.step({ type: 'tick', at_ms: 2_200 })).toEqual([]);
    expect(
      machine.step({ type: 'stt_final', at_ms: 2_300, text: '共有フォルダにあります。' })
    ).toEqual([{ type: 'commit', text: '資料が共有フォルダにあります。' }]);
  });

  it('pauses, then hard-stops playback on a worded interruption', () => {
    const machine = new VoiceTurnTakingMachine();
    machine.step({ type: 'tts_start', at_ms: 0, text: '本日の予定をお伝えします。' });
    expect(machine.step({ type: 'vad_start', at_ms: 500, rms: 4_000 })).toEqual([
      { type: 'pause_tts' },
    ]);
    expect(machine.step({ type: 'stt_partial', at_ms: 700, text: '止めて' })).toEqual([
      { type: 'hard_stop', words: '止めて' },
    ]);
    expect(machine.speaking).toBe(false);
  });

  it('ignores quiet VAD onsets during playback and resumes word-less pauses', () => {
    const machine = new VoiceTurnTakingMachine();
    machine.step({ type: 'tts_start', at_ms: 0, text: '説明を続けます。' });
    expect(machine.step({ type: 'vad_start', at_ms: 100, rms: 500 })).toEqual([]);
    expect(machine.step({ type: 'vad_start', at_ms: 200, rms: 4_000 })).toEqual([
      { type: 'pause_tts' },
    ]);
    expect(machine.step({ type: 'tick', at_ms: 800 })).toEqual([
      { type: 'resume_tts', reason: 'no_words' },
    ]);
  });

  it('starts speculation after tentative silence and keeps it when the final matches', () => {
    const machine = new VoiceTurnTakingMachine({ speculative: { enabled: true } });
    run(machine, [
      { type: 'vad_start', at_ms: 0 },
      { type: 'stt_partial', at_ms: 400, text: '今日の予定は' },
      { type: 'vad_silence', at_ms: 500 },
    ]);
    expect(machine.step({ type: 'tick', at_ms: 700 })).toEqual([]);
    expect(machine.step({ type: 'tick', at_ms: 750 })).toEqual([
      { type: 'start_speculative', partial: '今日の予定は' },
    ]);
    expect(machine.step({ type: 'stt_final', at_ms: 800, text: '今日の予定は？' })).toEqual([
      { type: 'commit', text: '今日の予定は？' },
    ]);
  });

  it('aborts speculation as eot_revoked when the user resumes or the final diverges', () => {
    const machine = new VoiceTurnTakingMachine({ speculative: { enabled: true } });
    run(machine, [
      { type: 'stt_partial', at_ms: 0, text: '今日の予定は' },
      { type: 'vad_silence', at_ms: 100 },
      { type: 'tick', at_ms: 350 },
    ]);
    expect(machine.step({ type: 'vad_start', at_ms: 400 })).toEqual([
      { type: 'abort_speculative', reason: 'eot_revoked' },
    ]);

    const diverging = new VoiceTurnTakingMachine({ speculative: { enabled: true } });
    run(diverging, [
      { type: 'stt_partial', at_ms: 0, text: '今日の予定は' },
      { type: 'vad_silence', at_ms: 100 },
      { type: 'tick', at_ms: 350 },
    ]);
    expect(
      diverging.step({ type: 'stt_final', at_ms: 400, text: '今日の天気は晴れですか' })
    ).toEqual([
      { type: 'abort_speculative', reason: 'eot_revoked' },
      { type: 'commit', text: '今日の天気は晴れですか' },
    ]);
  });

  it('never speculates when the policy is disabled', () => {
    const machine = new VoiceTurnTakingMachine();
    const actions = run(machine, [
      { type: 'stt_partial', at_ms: 0, text: '今日の予定は' },
      { type: 'vad_silence', at_ms: 100 },
      { type: 'tick', at_ms: 1_000 },
    ]);
    expect(actions).toEqual([]);
  });
});
