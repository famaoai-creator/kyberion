/**
 * Voice Bridge — thin adapter that routes decision-support voice ops
 * (`a2a_roleplay`, `conduct_1on1`) through the governed voice stack
 * (voice-engine-registry → voice-generation-runtime → voice-runtime-policy).
 *
 * Implements the contract layer of CONCEPT_INTEGRATION_BACKLOG P2-2.
 * Call sites in wisdom-actuator's decision-ops should migrate from
 * writing synthetic stub transcripts to asking the bridge for a
 * governed voice session. This module keeps the abstraction thin so
 * the underlying voice stack stays replaceable per cli-harness model.
 */

import { logger } from './core.js';

export interface RoleplayTurn {
  speaker: 'sovereign' | 'counterparty';
  text: string;
  audio_ref?: string;
}

export interface RoleplaySessionInput {
  objective: string;
  timeBudgetMinutes: number;
  personaSpec: {
    identity?: Record<string, unknown>;
    style_hints?: Record<string, unknown>;
    ng_topics?: string[];
    [k: string]: unknown;
  };
  outputPath: string;
}

export interface RoleplaySessionResult {
  written_to: string;
  turns: RoleplayTurn[];
  engine_id?: string;
  _synthetic?: boolean;
}

export interface OneOnOneSessionInput {
  counterpartyRef: string;
  proposalDraftRef: string;
  structure: string[];
  outputPath: string;
}

export interface OneOnOneSessionResult {
  written_to: string;
  person_slug: string;
  visited_at: string;
  transcript: RoleplayTurn[];
  stance: 'support' | 'conditional' | 'neutral' | 'oppose';
  conditions: string[];
  dissent_signals: string[];
  engine_id?: string;
  _synthetic?: boolean;
}

export interface VoiceBridge {
  name: string;
  runRoleplaySession(input: RoleplaySessionInput): Promise<RoleplaySessionResult>;
  runOneOnOneSession(input: OneOnOneSessionInput): Promise<OneOnOneSessionResult>;
}

let registered: VoiceBridge | null = null;

export function registerVoiceBridge(bridge: VoiceBridge): void {
  registered = bridge;
}

export function getVoiceBridge(): VoiceBridge {
  return registered ?? stubVoiceBridge;
}

export function resetVoiceBridge(): void {
  registered = null;
}

function basename(p: string): string {
  const last = p.split(/[\/\\]/u).pop() ?? p;
  return last.replace(/\.json$/u, '');
}

/**
 * Default bridge: writes a synthetic transcript and flags `_synthetic: true`.
 * Real deployments register a bridge that drives voice-generation-runtime
 * and (for conduct_1on1) an STT/TTS loop plus a persona model.
 */
export const stubVoiceBridge: VoiceBridge = {
  name: 'stub',

  async runRoleplaySession(input) {
    logger.warn(
      '[voice-bridge:stub] runRoleplaySession — no governed voice bridge registered; producing synthetic transcript',
    );
    return {
      written_to: input.outputPath,
      _synthetic: true,
      turns: [
        { speaker: 'sovereign', text: `[SYNTH] Opening line for objective: ${input.objective}` },
        { speaker: 'counterparty', text: '[SYNTH] Placeholder reply shaped by persona style_hints' },
      ],
    };
  },

  async runOneOnOneSession(input) {
    logger.warn(
      '[voice-bridge:stub] runOneOnOneSession — no governed voice bridge registered; producing synthetic session',
    );
    return {
      written_to: input.outputPath,
      _synthetic: true,
      person_slug: basename(input.counterpartyRef),
      visited_at: new Date().toISOString(),
      transcript: [],
      stance: 'neutral',
      conditions: [],
      dissent_signals: [],
    };
  },
};
