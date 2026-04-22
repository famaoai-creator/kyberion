/**
 * Claude Agent Intent Extractor — IntentExtractor via sub-agent delegation.
 */

import { z } from 'zod';
import { runClaudeAgentQuery } from './claude-agent-query.js';
import type { IntentBody } from './intent-delta.js';
import type { ExtractIntentInput, IntentExtractor } from './intent-extractor.js';

const SYSTEM_PROMPT = `You extract structured intent from a user utterance in a CEO work-automation platform.

Given a natural-language request (Japanese or English), produce an IntentBody:
- goal: one short sentence (<=200 chars) stating the desired outcome.
- constraints: hard conditions if mentioned. Empty array when none.
- deliverables: concrete artifacts or decisions the user expects. Empty array when not stated.
- excluded: things the user explicitly does NOT want.
- stakeholders: person slugs or @handles if referenced. Empty array when none.

Rules:
- Never invent facts. Fields absent from the utterance stay empty.
- Preserve the user's original language for goal and constraints.
- goal MUST always be populated, even if terse.
- Output JSON only, matching the json_schema.`;

const IntentBodySchema = z.object({
  goal: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  deliverables: z.array(z.string()).default([]),
  excluded: z.array(z.string()).default([]),
  stakeholders: z.array(z.string()).default([]),
});

export interface ClaudeAgentIntentExtractorOptions {
  model?: string;
}

export class ClaudeAgentIntentExtractor implements IntentExtractor {
  readonly name = 'claude-agent';
  private readonly model: string;

  constructor(options: ClaudeAgentIntentExtractorOptions = {}) {
    this.model = options.model ?? 'haiku';
  }

  async extract(input: ExtractIntentInput): Promise<IntentBody> {
    const text = input.text?.trim() ?? '';
    if (!text) return { goal: '(no utterance)' };

    const userPrompt = [
      `UTTERANCE:`,
      text,
      input.context ? `\nCONTEXT: ${JSON.stringify(input.context)}` : '',
      ``,
      `Return an IntentBody.`,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await runClaudeAgentQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      model: this.model,
      schema: IntentBodySchema,
    });

    const parsed = result.parsed;
    const body: IntentBody = { goal: parsed.goal };
    if (parsed.constraints.length) body.constraints = parsed.constraints;
    if (parsed.deliverables.length) body.deliverables = parsed.deliverables;
    if (parsed.excluded.length) body.excluded = parsed.excluded;
    if (parsed.stakeholders.length) body.stakeholders = parsed.stakeholders;
    return body;
  }
}
