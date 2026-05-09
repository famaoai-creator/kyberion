import { z } from 'zod';
import { runClaudeCliQuery, type ClaudeCliBackendOptions } from './claude-cli-backend.js';
import type {
  OneOnOneSessionInput,
  OneOnOneSessionResult,
  RoleplaySessionInput,
  RoleplaySessionResult,
  VoiceBridge,
} from './voice-bridge.js';

const SYSTEM_PROMPT = `You generate text-based rehearsal and 1-on-1 transcripts for a CEO work-automation platform.

Rules:
- Produce realistic alternating dialogue between sovereign and counterparty.
- Respect persona style hints and ng_topics.
- For 1-on-1 sessions, also return stance, conditions, and dissent signals.
- Output JSON only.`;

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

export interface ClaudeCliVoiceBridgeOptions extends ClaudeCliBackendOptions {}

export class ClaudeCliVoiceBridge implements VoiceBridge {
  readonly name = 'claude-cli-text';
  private readonly options: ClaudeCliBackendOptions;

  constructor(options: ClaudeCliVoiceBridgeOptions = {}) {
    this.options = options;
  }

  async runRoleplaySession(input: RoleplaySessionInput): Promise<RoleplaySessionResult> {
    const result = (await runClaudeCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Generate a rehearsal roleplay transcript.',
        `Objective: ${input.objective}`,
        `Time budget: ${input.timeBudgetMinutes} minutes`,
        `Persona spec: ${JSON.stringify(input.personaSpec, null, 2)}`,
      ].join('\n'),
      schema: RoleplayResultSchema,
      options: this.options,
    })) as z.infer<typeof RoleplayResultSchema>;
    return {
      written_to: input.outputPath,
      turns: result.turns,
    };
  }

  async runOneOnOneSession(input: OneOnOneSessionInput): Promise<OneOnOneSessionResult> {
    const result = (await runClaudeCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Run a 1-on-1 session simulation.',
        `Counterparty ref: ${input.counterpartyRef}`,
        `Proposal draft ref: ${input.proposalDraftRef}`,
        `Structure: ${JSON.stringify(input.structure)}`,
      ].join('\n'),
      schema: OneOnOneResultSchema,
      options: this.options,
    })) as z.infer<typeof OneOnOneResultSchema>;
    const slugMatch = input.counterpartyRef.match(/([^/\\]+?)(?:\.json)?$/u);
    const personSlug = slugMatch ? slugMatch[1] : input.counterpartyRef;
    return {
      written_to: input.outputPath,
      person_slug: personSlug,
      visited_at: new Date().toISOString(),
      transcript: result.transcript,
      stance: result.stance,
      conditions: result.conditions,
      dissent_signals: result.dissent_signals,
    };
  }
}
