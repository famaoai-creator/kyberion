import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./shell-claude-cli-backend.js', () => ({
  runClaudeCliQuery: vi.fn(async ({ schema }: any, _prompt: any) => {
    const voiceCandidate = {
      turns: [
        { speaker: 'sovereign', text: 'hello' },
        { speaker: 'counterparty', text: 'hi' },
      ],
      transcript: [
        { speaker: 'sovereign', text: 'hello' },
        { speaker: 'counterparty', text: 'hi' },
      ],
      stance: 'neutral',
      conditions: [],
      dissent_signals: [],
    };
    if (schema.safeParse(voiceCandidate).success) return schema.parse(voiceCandidate);
    return schema.parse({
      goal: 'ship a safer fallback',
      constraints: ['must stay deterministic'],
      deliverables: ['review notes'],
      excluded: [],
      stakeholders: ['ops'],
    });
  }),
}));

vi.mock('./gemini-cli-backend.js', () => ({
  runGeminiCliQuery: vi.fn(async ({ schema }: any) => {
    const voiceCandidate = {
      turns: [
        { speaker: 'sovereign', text: 'hello' },
        { speaker: 'counterparty', text: 'hi' },
      ],
      transcript: [
        { speaker: 'sovereign', text: 'hello' },
        { speaker: 'counterparty', text: 'hi' },
      ],
      stance: 'neutral',
      conditions: [],
      dissent_signals: [],
    };
    if (schema.safeParse(voiceCandidate).success) return schema.parse(voiceCandidate);
    return schema.parse({
      goal: 'refine the model selection',
      constraints: [],
      deliverables: ['decision'],
      excluded: ['noise'],
      stakeholders: ['platform'],
    });
  }),
}));

import { ClaudeCliIntentExtractor } from './claude-cli-intent-extractor.js';
import { ClaudeCliVoiceBridge } from './claude-cli-voice-bridge.js';
import { GeminiCliIntentExtractor } from './gemini-cli-intent-extractor.js';
import { GeminiCliVoiceBridge } from './gemini-cli-voice-bridge.js';

describe('CLI backend bridges', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('extracts intent through shell claude cli', async () => {
    const extractor = new ClaudeCliIntentExtractor();
    const body = await extractor.extract({ text: 'please ship this' });
    expect(body.goal).toBe('ship a safer fallback');
    expect(body.constraints).toEqual(['must stay deterministic']);
  });

  it('extracts intent through gemini cli', async () => {
    const extractor = new GeminiCliIntentExtractor();
    const body = await extractor.extract({ text: 'please ship this' });
    expect(body.goal).toBe('refine the model selection');
    expect(body.deliverables).toEqual(['decision']);
  });

  it('produces voice transcripts through shell claude cli', async () => {
    const bridge = new ClaudeCliVoiceBridge();
    const result = await bridge.runRoleplaySession({
      objective: 'rehearse',
      timeBudgetMinutes: 10,
      personaSpec: {},
      outputPath: 'tmp/roleplay.json',
    });
    expect(result.turns).toHaveLength(2);
    expect(result.written_to).toBe('tmp/roleplay.json');
  });

  it('produces voice transcripts through gemini cli', async () => {
    const bridge = new GeminiCliVoiceBridge();
    const result = await bridge.runOneOnOneSession({
      counterpartyRef: 'people/alice.json',
      proposalDraftRef: 'drafts/proposal.md',
      structure: ['open', 'probe', 'close'],
      outputPath: 'tmp/one-on-one.json',
    });
    expect(result.person_slug).toBe('alice');
    expect(result.stance).toBe('neutral');
    expect(result.written_to).toBe('tmp/one-on-one.json');
  });
});
