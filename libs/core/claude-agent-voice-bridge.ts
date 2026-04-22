/**
 * Claude Agent Voice Bridge — text-based roleplay / 1-on-1 via sub-agent.
 */

import { z } from 'zod';
import { runClaudeAgentQuery } from './claude-agent-query.js';
import type {
  OneOnOneSessionInput,
  OneOnOneSessionResult,
  RoleplaySessionInput,
  RoleplaySessionResult,
  VoiceBridge,
} from './voice-bridge.js';

const SYSTEM_PROMPT = `You generate text-based rehearsal and 1-on-1 session transcripts for a CEO work-automation platform.

Rules:
- Produce realistic back-and-forth dialogue between the Sovereign (CEO) and a
  counterparty derived from the supplied persona. Alternate speakers.
- Respect communication_style (honne/tatemae tendency, tempo, disliked topics).
- 15 minutes ≈ 10-14 turns at normal tempo.
- For 1-on-1 sessions, end with a concise summary of stance/conditions/dissent_signals.
  stance ∈ {support, conditional, neutral, oppose}.
- Never invent facts about named people. Use persona placeholders verbatim.
- Output JSON only, matching the json_schema.`;

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

export interface ClaudeAgentVoiceBridgeOptions {
  model?: string;
}

export class ClaudeAgentVoiceBridge implements VoiceBridge {
  readonly name = 'claude-agent-text';
  private readonly model: string;

  constructor(options: ClaudeAgentVoiceBridgeOptions = {}) {
    this.model = options.model ?? 'opus';
  }

  async runRoleplaySession(input: RoleplaySessionInput): Promise<RoleplaySessionResult> {
    const userPrompt = [
      `TASK: Generate a rehearsal roleplay transcript.`,
      `OBJECTIVE: ${input.objective}`,
      `TIME BUDGET: ${input.timeBudgetMinutes} minutes`,
      `PERSONA SPEC:`,
      JSON.stringify(input.personaSpec, null, 2),
    ].join('\n');

    const result = await runClaudeAgentQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      model: this.model,
      schema: RoleplayResultSchema,
    });
    return {
      written_to: input.outputPath,
      turns: result.parsed.turns,
    };
  }

  async runOneOnOneSession(input: OneOnOneSessionInput): Promise<OneOnOneSessionResult> {
    const userPrompt = [
      `TASK: Run a 1-on-1 session simulation. The Sovereign wants to surface dissent`,
      `before a formal ask. Structure the session according to STRUCTURE hints.`,
      `At the end, extract stance + conditions + dissent_signals.`,
      ``,
      `COUNTERPARTY REF: ${input.counterpartyRef}`,
      `PROPOSAL DRAFT REF: ${input.proposalDraftRef}`,
      `STRUCTURE: ${JSON.stringify(input.structure)}`,
    ].join('\n');

    const result = await runClaudeAgentQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      model: this.model,
      schema: OneOnOneResultSchema,
    });

    const parsed = result.parsed;
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
