// FD-03: `viewFromIntentResolution` (presence-studio ask page's pure
// contract -> { shape, next_actions } mapping). Pure, no I/O.
import { describe, expect, it } from 'vitest';
import {
  parseIntentResolutionContract,
  type IntentResolutionContract,
  type IntentResolutionShape,
} from '@agent/core/intent-resolution-contract-parser';
import {
  ASK_SHAPE_LABEL_KEY,
  humanizeSlug,
  parseAskVoiceHubReply,
  resolveIntentLabel,
  viewFromIntentResolution,
} from './ask-view.js';

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

describe('humanizeSlug', () => {
  it('turns a kebab-case slug into plain words', () => {
    expect(humanizeSlug('register-presentation-preference-profile')).toBe(
      'register presentation preference profile'
    );
  });

  it('turns a snake_case slug into plain words', () => {
    expect(humanizeSlug('task_session')).toBe('task session');
  });

  it('collapses runs of separators and trims the ends', () => {
    expect(humanizeSlug('--edge__case-')).toBe('edge case');
  });

  it('leaves an already-plain string untouched', () => {
    expect(humanizeSlug('already plain')).toBe('already plain');
  });
});

describe('resolveIntentLabel', () => {
  it('returns the catalog description with source "catalog" on a hit', () => {
    const catalog = new Map([
      [
        'register-presentation-preference-profile',
        'Register reusable presentation brief and theme preferences for future decks.',
      ],
    ]);

    expect(resolveIntentLabel('register-presentation-preference-profile', catalog)).toEqual({
      label: 'Register reusable presentation brief and theme preferences for future decks.',
      source: 'catalog',
    });
  });

  it('falls back to a humanized slug with source "slug" on a miss', () => {
    const catalog = new Map([['some-other-intent', 'Some other intent.']]);

    expect(resolveIntentLabel('register-presentation-preference-profile', catalog)).toEqual({
      label: 'register presentation preference profile',
      source: 'slug',
    });
  });

  it('falls back to a humanized slug when the catalog entry has an empty description', () => {
    const catalog = new Map([['blank-description-intent', '   ']]);

    expect(resolveIntentLabel('blank-description-intent', catalog)).toEqual({
      label: 'blank description intent',
      source: 'slug',
    });
  });
});

describe('ASK_SHAPE_LABEL_KEY', () => {
  // Every `resolution_shape` the parser accepts must have a label key here
  // (see `ASK_SHAPE_LABEL_KEY`'s module doc — the exhaustive `Record` type
  // already fails `tsc` on a new `IntentResolutionShape` member; this test
  // additionally probes the parser at runtime so a drift shows up in
  // `vitest` too). Keep this candidate list in sync with the parser's own
  // `resolutionShapes` array in `intent-resolution-contract-parser.ts`.
  const candidateShapes = [
    'direct_answer',
    'task_session',
    'mission',
    'project_bootstrap',
    'not_a_real_shape',
  ] as const;

  function isAcceptedShape(shape: string): shape is IntentResolutionShape {
    return Boolean(
      parseIntentResolutionContract(
        baseContract({ resolution_shape: shape as IntentResolutionShape })
      )
    );
  }

  const acceptedShapes = candidateShapes.filter(isAcceptedShape);

  it('has at least the four resolution shapes the parser currently accepts', () => {
    expect(acceptedShapes.sort()).toEqual(
      ['direct_answer', 'mission', 'project_bootstrap', 'task_session'].sort()
    );
  });

  it('has a label key for every resolution shape the parser accepts', () => {
    for (const shape of acceptedShapes) {
      expect(ASK_SHAPE_LABEL_KEY[shape]).toBeTruthy();
    }
    expect(Object.keys(ASK_SHAPE_LABEL_KEY).sort()).toEqual([...acceptedShapes].sort());
  });

  it('rejects a shape the parser does not know', () => {
    expect(isAcceptedShape('not_a_real_shape')).toBe(false);
  });
});

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
