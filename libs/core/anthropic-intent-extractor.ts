/**
 * Anthropic Intent Extractor — structured utterance → IntentBody extraction
 * via Claude. Companion to AnthropicReasoningBackend; same model / thinking /
 * caching defaults.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { IntentBody } from './intent-delta.js';
import type { ExtractIntentInput, IntentExtractor } from './intent-extractor.js';

const DEFAULT_MODEL = 'claude-opus-4-7' as const;
const DEFAULT_MAX_TOKENS = 2000;

const SYSTEM_PROMPT = `You extract structured intent from a user utterance in a CEO work-automation platform.

Given a natural-language request (Japanese or English), produce an IntentBody:
- goal: one short sentence (<=200 chars) stating the desired outcome.
- constraints: hard conditions (deadlines, budget, scope exclusions) if mentioned. Empty array when none.
- deliverables: concrete artifacts or decisions the user expects. Empty array when not stated.
- excluded: things the user explicitly does NOT want.
- stakeholders: person slugs or @handles if referenced. Empty array when none.

Rules:
- Never invent facts. If a field isn't in the utterance, leave it empty.
- Preserve the user's original language for goal and constraints (Japanese stays Japanese).
- goal MUST always be populated, even if terse.
- Output JSON matching the schema. No prose.`;

const IntentBodySchema = z.object({
  goal: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  deliverables: z.array(z.string()).default([]),
  excluded: z.array(z.string()).default([]),
  stakeholders: z.array(z.string()).default([]),
});

export interface AnthropicIntentExtractorOptions {
  client?: Anthropic;
  model?: string;
  maxTokens?: number;
}

export class AnthropicIntentExtractor implements IntentExtractor {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicIntentExtractorOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async extract(input: ExtractIntentInput): Promise<IntentBody> {
    const text = input.text?.trim() ?? '';
    if (!text) {
      return { goal: '(no utterance)' };
    }

    const userPrompt = [
      `UTTERANCE:`,
      text,
      input.context ? `\nCONTEXT: ${JSON.stringify(input.context)}` : '',
      ``,
      `Return an IntentBody.`,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(IntentBodySchema) },
    });

    const parsed = result.parsed_output!;
    // Drop empty arrays so IntentBody stays clean (matches the stub extractor shape).
    const body: IntentBody = { goal: parsed.goal };
    if (parsed.constraints.length) body.constraints = parsed.constraints;
    if (parsed.deliverables.length) body.deliverables = parsed.deliverables;
    if (parsed.excluded.length) body.excluded = parsed.excluded;
    if (parsed.stakeholders.length) body.stakeholders = parsed.stakeholders;
    return body;
  }
}
