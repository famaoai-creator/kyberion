import { describe, expect, it } from 'vitest';
import { BackchannelPolicy } from './backchannel-policy.js';
import { languagePackFromSource } from './language-pack.js';

const ja = languagePackFromSource('ja', { agent_backchannels: ['うん', 'はい', 'なるほど'] });

function policyAt(now: { t: number }, options = {}) {
  return new BackchannelPolicy({ enabled: true, now: () => now.t, ...options });
}

describe('BackchannelPolicy', () => {
  it('emits only after sustained remote speech', () => {
    const now = { t: 0 };
    const policy = policyAt(now, { minSpeechMs: 1000 });
    policy.observeRemoteSpeechStart(0);
    now.t = 999;
    expect(policy.shouldEmit()).toBe(false);
    now.t = 1000;
    expect(policy.shouldEmit()).toBe(true);
  });

  it('spaces emissions by the minimum interval and caps per utterance', () => {
    const now = { t: 0 };
    const policy = policyAt(now, { minSpeechMs: 100, minIntervalMs: 1000, maxPerUtterance: 2 });
    policy.observeRemoteSpeechStart(0);
    now.t = 100;
    expect(policy.shouldEmit()).toBe(true);
    policy.markEmitted();
    now.t = 500;
    expect(policy.shouldEmit()).toBe(false);
    now.t = 1100;
    expect(policy.shouldEmit()).toBe(true);
    policy.markEmitted();
    now.t = 2100;
    expect(policy.shouldEmit()).toBe(false); // capped at 2
  });

  it('suppresses emission over corrections and hold requests', () => {
    const now = { t: 2000 };
    const policy = policyAt(now, { minSpeechMs: 100 });
    policy.observeRemoteSpeechStart(0);
    expect(policy.shouldEmit('correcting')).toBe(false);
    expect(policy.shouldEmit('holding')).toBe(false);
    expect(policy.shouldEmit('substantive')).toBe(true);
  });

  it('is disabled unless enabled', () => {
    const now = { t: 99999 };
    const policy = new BackchannelPolicy({ now: () => now.t });
    policy.observeRemoteSpeechStart(0);
    expect(policy.shouldEmit()).toBe(false);
  });

  it('rotates agent backchannel phrases', () => {
    const policy = policyAt({ t: 0 }, { enabled: true });
    expect(policy.pickPhrase(ja)).toBe('うん');
    expect(policy.pickPhrase(ja)).toBe('はい');
    expect(policy.pickPhrase(ja)).toBe('なるほど');
    expect(policy.pickPhrase(ja)).toBe('うん');
  });
});
