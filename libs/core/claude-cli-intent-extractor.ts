import { z } from 'zod';
import { runClaudeCliQuery, type ClaudeCliBackendOptions } from './claude-cli-backend.js';
import type { IntentBody } from './intent-delta.js';
import type { ExtractIntentInput, IntentExtractor } from './intent-extractor.js';

const SYSTEM_PROMPT = `You extract structured intent from a user utterance in a CEO work-automation platform.

Given a natural-language request, produce an IntentBody:
- goal: one short sentence stating the desired outcome.
- constraints: hard conditions when mentioned.
- deliverables: concrete artifacts or decisions the user expects.
- excluded: things the user explicitly does not want.
- stakeholders: handles or people explicitly referenced.

Rules:
- Never invent facts.
- Preserve the original language.
- goal must always be populated.`;

const IntentBodySchema = z.object({
  goal: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  deliverables: z.array(z.string()).default([]),
  excluded: z.array(z.string()).default([]),
  stakeholders: z.array(z.string()).default([]),
});

export interface ClaudeCliIntentExtractorOptions extends ClaudeCliBackendOptions {}

export class ClaudeCliIntentExtractor implements IntentExtractor {
  readonly name = 'claude-cli';
  private readonly options: ClaudeCliBackendOptions;

  constructor(options: ClaudeCliIntentExtractorOptions = {}) {
    this.options = options;
  }

  async extract(input: ExtractIntentInput): Promise<IntentBody> {
    const text = input.text?.trim() ?? '';
    if (!text) return { goal: '(no utterance)' };

    const parsed = (await runClaudeCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Extract an IntentBody from the utterance.',
        'Utterance:',
        text,
        input.context ? `Context: ${JSON.stringify(input.context)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      schema: IntentBodySchema,
      options: this.options,
    })) as z.infer<typeof IntentBodySchema>;

    const body: IntentBody = { goal: parsed.goal };
    if (parsed.constraints.length) body.constraints = parsed.constraints;
    if (parsed.deliverables.length) body.deliverables = parsed.deliverables;
    if (parsed.excluded.length) body.excluded = parsed.excluded;
    if (parsed.stakeholders.length) body.stakeholders = parsed.stakeholders;
    return body;
  }
}
