// FD-03: `viewFromIntentResolution` (presence-studio ask page's pure
// contract -> { shape, next_actions } mapping). Pure, no I/O.
import { describe, expect, it } from 'vitest';
import type { IntentResolutionContract } from '@agent/core/intent-resolution-contract-parser';
import { parseAskVoiceHubReply, viewFromIntentResolution } from './ask-view.js';

function baseContract(overrides: Partial<IntentResolutionContract> = {}): IntentResolutionContract {
  return {
    request_id: 'ir_test',
    normalized_intent: 'Draft the board deck for next week',
    missing_inputs: [],
    resolution_shape: 'task_session',
    outcome_kind: 'artifact',
    authority_level: 'autonomous',
    next_action: { kind: 'continue', label: 'Continue', consequence: 'Work proceeds.' },
    rationale: 'test rationale',
    ...overrides,
  };
}

describe('viewFromIntentResolution', () => {
  it('maps human_clarification_required to clarification with a more_detail next action', () => {
    const contract = baseContract({
      authority_level: 'human_clarification_required',
      next_action: {
        kind: 'provide_input',
        label: 'Which meeting?',
        consequence: 'Cannot draft minutes without a meeting.',
      },
    });

    const view = viewFromIntentResolution(contract);

    expect(view).toEqual({
      shape: 'clarification',
      nextActions: [{ id: 'more_detail', label: 'Which meeting?' }],
    });
  });

  it('maps approval_required to execution_preview with a proceed next action', () => {
    const contract = baseContract({
      authority_level: 'approval_required',
      next_action: {
        kind: 'request_approval',
        label: 'Approve sending the email',
        consequence: 'The email is sent to the recipient.',
      },
    });

    const view = viewFromIntentResolution(contract);

    expect(view).toEqual({
      shape: 'execution_preview',
      nextActions: [{ id: 'proceed', label: 'Approve sending the email' }],
    });
  });

  it('maps autonomous to a plain reply with no next actions', () => {
    const contract = baseContract({ authority_level: 'autonomous' });

    const view = viewFromIntentResolution(contract);

    expect(view).toEqual({ shape: 'reply' });
  });

  it('never invents next actions the contract did not carry', () => {
    const contract = baseContract({ authority_level: 'autonomous' });

    const view = viewFromIntentResolution(contract);

    expect(view.nextActions).toBeUndefined();
  });
});

describe('parseAskVoiceHubReply', () => {
  it('accepts a plain {reply} body', () => {
    expect(parseAskVoiceHubReply({ reply: 'Got it.' })).toEqual({ reply: 'Got it.' });
  });

  it('accepts the replyText/text/response field aliases voice-hub may send', () => {
    expect(parseAskVoiceHubReply({ replyText: 'Sure.' })).toEqual({ reply: 'Sure.' });
    expect(parseAskVoiceHubReply({ text: 'Sure.' })).toEqual({ reply: 'Sure.' });
    expect(parseAskVoiceHubReply({ response: 'Sure.' })).toEqual({ reply: 'Sure.' });
  });

  it('accepts and re-parses a valid embedded intentResolution contract', () => {
    const contract = baseContract();
    const parsed = parseAskVoiceHubReply({ reply: 'Working on it.', intentResolution: contract });
    expect(parsed?.reply).toBe('Working on it.');
    expect(parsed?.intentResolution).toEqual(contract);
  });

  it('rejects a non-object body', () => {
    expect(parseAskVoiceHubReply('not an object')).toBeUndefined();
    expect(parseAskVoiceHubReply(null)).toBeUndefined();
    expect(parseAskVoiceHubReply([1, 2, 3])).toBeUndefined();
  });

  it('rejects a body with no non-empty reply field', () => {
    expect(parseAskVoiceHubReply({})).toBeUndefined();
    expect(parseAskVoiceHubReply({ reply: '   ' })).toBeUndefined();
  });

  it('rejects a body whose reply field is not a string', () => {
    expect(parseAskVoiceHubReply({ reply: 42 })).toBeUndefined();
  });

  it('rejects a body carrying an invalid embedded intentResolution contract', () => {
    expect(
      parseAskVoiceHubReply({ reply: 'Working on it.', intentResolution: { bogus: true } })
    ).toBeUndefined();
  });

  it('rejects a body with a prototype-pollution-shaped key', () => {
    const malicious = JSON.parse('{"reply":"hi","__proto__":{"polluted":true}}');
    expect(parseAskVoiceHubReply(malicious)).toBeUndefined();
  });
});
