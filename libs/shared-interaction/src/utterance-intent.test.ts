import { describe, expect, it } from 'vitest';
import { classifyUtteranceIntent } from './utterance-intent.js';
import { languagePackFromSource } from './language-pack.js';

const ja = languagePackFromSource('ja', {
  uses_word_spaces: false,
  question_endings: ['ますか', 'ですか', 'かな', 'かい', 'か'],
  continuation_particles: ['けど', 'て', 'が'],
  eot_fillers: ['えーと', 'うーん'],
  commit_endings: ['です', 'ます', 'か'],
  respond_gate_fillers: ['えーと', 'あの'],
  barge_in_backchannels: ['うん', 'うんうん', 'ええ'],
  correction_markers: ['いや', '違う', 'ちがう'],
  hold_markers: ['ちょっと待って', '待って'],
  agent_backchannels: ['うん', 'はい'],
});

const en = languagePackFromSource('en', {
  uses_word_spaces: true,
  continuation_particles: ['and', 'but'],
  eot_fillers: ['um', 'uh'],
  commit_endings: [],
  respond_gate_fillers: ['um', 'uh'],
  barge_in_backchannels: ['yeah', 'uh-huh', 'mhm'],
  correction_markers: ['wrong', 'actually', 'wait no'],
  hold_markers: ['wait', 'hold on', 'one sec'],
  agent_backchannels: ['yeah', 'I see'],
});

describe('classifyUtteranceIntent (ja)', () => {
  it('classifies a pure user backchannel', () => {
    expect(classifyUtteranceIntent('うん', ja)).toEqual({
      intent: 'backchannel',
      pure: true,
      matched: 'うん',
    });
    expect(classifyUtteranceIntent('うんうん', ja).intent).toBe('backchannel');
  });

  it('classifies corrections, marking pure marker-only utterances', () => {
    expect(classifyUtteranceIntent('いや、違う違う', ja)).toEqual({
      intent: 'correcting',
      pure: true,
      matched: 'いや',
    });
    expect(classifyUtteranceIntent('いや、そこは違うよ', ja)).toEqual({
      intent: 'correcting',
      pure: false,
      matched: 'いや',
    });
    expect(classifyUtteranceIntent('いやいや', ja).intent).toBe('correcting');
  });

  it('classifies a pure hold request', () => {
    expect(classifyUtteranceIntent('ちょっと待って', ja)).toEqual({
      intent: 'holding',
      pure: true,
      matched: 'ちょっと待って',
    });
  });

  it('classifies questions and thinking-aloud', () => {
    expect(classifyUtteranceIntent('明日の予定は？', ja).intent).toBe('questioning');
    expect(classifyUtteranceIntent('それはどうなるんですか', ja).intent).toBe('questioning');
    expect(classifyUtteranceIntent('えーと', ja).intent).toBe('backchannel');
    expect(classifyUtteranceIntent('それはなんだけど', ja).intent).toBe('thinking_aloud');
  });

  it('defaults to substantive', () => {
    expect(classifyUtteranceIntent('会議室を予約してください', ja)).toEqual({
      intent: 'substantive',
      pure: false,
    });
  });
});

describe('classifyUtteranceIntent (en)', () => {
  it('classifies pure backchannels, corrections and holds', () => {
    expect(classifyUtteranceIntent('yeah', en)).toEqual({
      intent: 'backchannel',
      pure: true,
      matched: 'yeah',
    });
    expect(classifyUtteranceIntent("that's wrong", en).intent).toBe('correcting');
    expect(classifyUtteranceIntent('hold on', en)).toEqual({
      intent: 'holding',
      pure: true,
      matched: 'hold on',
    });
  });

  it('does not treat a mid-sentence wait as a pure hold', () => {
    const result = classifyUtteranceIntent('wait I have a question', en);
    expect(result.intent).not.toBe('holding');
  });
});
