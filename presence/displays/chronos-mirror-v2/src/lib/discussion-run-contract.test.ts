import { describe, expect, it } from 'vitest';
import {
  discussionRunConfig,
  readDiscussionExecutionConfig,
  discussionExecutionState,
} from './discussion-run-contract';
import type { DiscussionRoomState } from '@agent/core/discussion/discussion-types';

describe('bounded browser Discussion contract', () => {
  it('never increases an explicit zero real-provider budget into a paid invocation', () => {
    expect(() =>
      readDiscussionExecutionConfig({
        speaker: 'reasoning',
        provider: 'claude',
        max_provider_calls: 0,
      })
    ).toThrow(/zero provider-call budget/);
  });
  it('makes the brief one explicit isolated invocation without multi-agent claims', () => {
    expect(discussionRunConfig('brief', 'claude')).toEqual({
      mode: 'panel',
      single_pass: true,
      max_rounds: 1,
      max_provider_calls: 1,
      provider_timeout_ms: 60000,
      speaker: 'reasoning',
      provider: 'claude',
    });
  });
  it('keeps the multi-agent panel distinct and finite', () => {
    expect(discussionRunConfig('panel', 'codex')).toMatchObject({
      single_pass: false,
      max_rounds: 1,
      max_provider_calls: 9,
      provider: 'codex',
    });
  });
  it('never selects a provider for scripted output', () => {
    expect(discussionRunConfig('brief', 'scripted')).toMatchObject({
      speaker: 'scripted',
      max_provider_calls: 0,
    });
    expect(discussionRunConfig('brief', 'scripted')).not.toHaveProperty('provider');
  });
  it.each(['auto', 'reasoning'])(
    'rejects ambiguous %s execution before side effects',
    (speaker) => {
      expect(() => readDiscussionExecutionConfig({ speaker })).toThrow(/explicit provider/);
    }
  );
  it.each(['stub', 'unknown', 123])('rejects unsupported provider %s', (provider) => {
    expect(() => readDiscussionExecutionConfig({ speaker: 'reasoning', provider })).toThrow();
  });
  it('forces single-pass limits even when a client asks for more', () => {
    expect(
      readDiscussionExecutionConfig({
        speaker: 'reasoning',
        provider: 'claude',
        single_pass: true,
        max_provider_calls: 99,
        provider_timeout_ms: 999999,
      })
    ).toMatchObject({
      max_rounds: 1,
      max_provider_calls: 1,
      provider_timeout_ms: 60000,
    });
  });
  it('keeps dialogue and single-pass separate', () => {
    expect(() => readDiscussionExecutionConfig({ single_pass: true, mode: 'dialogue' })).toThrow();
  });
  it.each([NaN, 1.5, -1, '1'])('rejects malformed call budget %s', (max_provider_calls) => {
    expect(() => readDiscussionExecutionConfig({ max_provider_calls })).toThrow();
  });
  it('keeps scripted defaults explicit and bounded without provider', () => {
    expect(readDiscussionExecutionConfig({ provider: 'claude' })).toMatchObject({
      speaker: 'scripted',
      max_provider_calls: 0,
    });
    expect(readDiscussionExecutionConfig({ provider: 'claude' })).not.toHaveProperty('provider');
  });
  it('does not treat configuration as evidence of successful transport', () => {
    const room = (execution: unknown) => ({ execution }) as Pick<DiscussionRoomState, 'execution'>;
    expect(discussionExecutionState(room(null))).toBe('unknown');
    expect(discussionExecutionState(room({ actual_mode: 'reasoning', provider: null }))).toBe(
      'unconfirmed'
    );
    expect(discussionExecutionState(room({ actual_mode: 'reasoning', provider: 'claude' }))).toBe(
      'confirmed'
    );
    expect(discussionExecutionState(room({ actual_mode: 'scripted', provider: null }))).toBe(
      'scripted'
    );
  });
});
