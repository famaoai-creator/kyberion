/**
 * Anthropic Voice Bridge — text-based roleplay / 1-on-1 transcript
 * generation via Claude. Produces real persona-driven dialogue (no audio),
 * closing the "rehearsal produces meaningful transcripts" gap without
 * requiring a voice engine to be wired up. An audio-capable bridge can be
 * layered on top later (voice-generation-runtime → synthesize turns →
 * assemble audio), but the conversational content is by far the more
 * valuable half.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type {
  OneOnOneSessionInput,
  OneOnOneSessionResult,
  RoleplaySessionInput,
  RoleplaySessionResult,
  VoiceBridge,
} from './voice-bridge.js';

const DEFAULT_MODEL = 'claude-opus-4-7' as const;
const DEFAULT_MAX_TOKENS = 8000;

const SYSTEM_PROMPT = `You generate text-based rehearsal and 1-on-1 session transcripts for a CEO work-automation platform.

Rules:
- Produce a realistic back-and-forth dialogue between the Sovereign (CEO) and a
  counterparty derived from the supplied persona. Alternate speakers.
- Respect the persona's communication_style (honne/tatemae tendency, tempo,
  disliked topics) and stay within ng_topics boundaries.
- Length: pace turns to the time budget. 15 minutes ≈ 10-14 turns at normal tempo.
- For 1-on-1 sessions, end with a concise summary of stance/conditions/dissent
  signals extracted from the transcript. Stance must be one of:
  support | conditional | neutral | oppose.
- Never invent facts about specific named people or companies. Use the persona's
  placeholders verbatim.
- Output JSON matching the schema. No prose outside.`;

const RoleplayTurnSchema = z.object({
  speaker: z.enum(['sovereign', 'counterparty']),
  text: z.string(),
});

const RoleplayResultSchema = z.object({
  turns: z.array(RoleplayTurnSchema).min(2),
});

const OneOnOneResultSchema = z.object({
  transcript: z.array(RoleplayTurnSchema).min(2),
  stance: z.enum(['support', 'conditional', 'neutral', 'oppose']),
  conditions: z.array(z.string()).default([]),
  dissent_signals: z.array(z.string()).default([]),
});

export interface AnthropicVoiceBridgeOptions {
  client?: Anthropic;
  model?: string;
  maxTokens?: number;
}

export class AnthropicVoiceBridge implements VoiceBridge {
  readonly name = 'anthropic-text';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicVoiceBridgeOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async runRoleplaySession(input: RoleplaySessionInput): Promise<RoleplaySessionResult> {
    const userPrompt = [
      `TASK: Generate a rehearsal roleplay transcript.`,
      `OBJECTIVE: ${input.objective}`,
      `TIME BUDGET: ${input.timeBudgetMinutes} minutes`,
      `PERSONA SPEC:`,
      JSON.stringify(input.personaSpec, null, 2),
      ``,
      `Produce turns with speaker in {sovereign, counterparty}.`,
    ].join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(RoleplayResultSchema) },
    });

    return {
      written_to: input.outputPath,
      turns: result.parsed_output!.turns,
      // engine_id stays unset — we only synthesized text, not audio
    };
  }

  async runOneOnOneSession(input: OneOnOneSessionInput): Promise<OneOnOneSessionResult> {
    const userPrompt = [
      `TASK: Run a 1-on-1 session simulation with the counterparty referenced below.`,
      `The Sovereign wants to test the proposal draft and surface dissent before a formal ask.`,
      `Structure the session according to the STRUCTURE hints (time or phase labels).`,
      `At the end, extract stance + conditions + dissent_signals from the transcript.`,
      ``,
      `COUNTERPARTY REF: ${input.counterpartyRef}`,
      `PROPOSAL DRAFT REF: ${input.proposalDraftRef}`,
      `STRUCTURE: ${JSON.stringify(input.structure)}`,
      ``,
      `Return OneOnOneSessionResult with transcript, stance, conditions, dissent_signals.`,
    ].join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(OneOnOneResultSchema) },
    });

    const parsed = result.parsed_output!;
    const slugMatch = input.counterpartyRef.match(/([^/\\]+?)(?:\.json)?$/u);
    const personSlug = slugMatch ? slugMatch[1] : input.counterpartyRef;

    return {
      written_to: input.outputPath,
      person_slug: personSlug,
      visited_at: new Date().toISOString(),
      transcript: parsed.transcript,
      stance: parsed.stance,
      conditions: parsed.conditions,
      dissent_signals: parsed.dissent_signals,
    };
  }
}
