/**
 * Intent Extractor — pulls a structured IntentBody (goal, constraints,
 * deliverables, stakeholders) from a user utterance or mission brief.
 *
 * Implements the missing "utterance → intent body" step that lets the
 * intent-drift gate actually see drift. Same register/get/reset pattern
 * as ReasoningBackend and VoiceBridge.
 */

import { logger } from './core.js';
import type { IntentBody } from './intent-delta.js';
import {
  listDemotedProviders,
  reportProviderHealthy,
  getProviderHealthDemotionTtlMs,
  reportProviderTemporarilyUnhealthy,
} from './provider-health-registry.js';

export interface ExtractIntentInput {
  text: string;
  /** Optional conversation / mission context that precedes this utterance. */
  context?: Record<string, unknown>;
}

export interface IntentExtractor {
  name: string;
  extract(input: ExtractIntentInput): Promise<IntentBody>;
}

export interface IntentExtractorCandidate {
  extractor: IntentExtractor;
  provider?: string;
  label?: string;
}

function normalizeProviderName(value?: string): string | null {
  const provider = String(value || '').trim().toLowerCase();
  return provider || null;
}

function candidateLabel(candidate: IntentExtractorCandidate): string {
  return candidate.label || candidate.extractor.name || candidate.provider || 'unknown';
}

export class FailoverIntentExtractor implements IntentExtractor {
  readonly name: string;
  private readonly candidates: IntentExtractorCandidate[];

  constructor(candidates: IntentExtractorCandidate[]) {
    this.candidates = candidates.filter((candidate) => Boolean(candidate.extractor));
    this.name = this.candidates[0]?.extractor.name || 'failover';
  }

  async extract(input: ExtractIntentInput): Promise<IntentBody> {
    const skippedProviders = new Set(listDemotedProviders());
    const errors: string[] = [];
    for (const candidate of this.candidates) {
      const provider = normalizeProviderName(candidate.provider);
      if (provider && skippedProviders.has(provider)) continue;
      try {
        const result = await candidate.extractor.extract(input);
        if (provider) reportProviderHealthy(provider);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message || error.name : String(error);
        errors.push(`${candidateLabel(candidate)}: ${message}`);
        logger.warn(
          `[intent-extractor:failover] extract failed on ${candidateLabel(candidate)}${provider ? ` (${provider})` : ''}; demoting for ${getProviderHealthDemotionTtlMs()}ms: ${message}`
        );
        if (provider) {
          reportProviderTemporarilyUnhealthy(provider, {
            reason: `intent-extract:${message}`,
          });
        }
      }
    }
    throw new Error(
      `[intent-extractor:failover] extract failed across ${errors.length} candidate(s): ${errors.join(' | ')}`
    );
  }
}

export function buildFailoverIntentExtractor(
  candidates: IntentExtractorCandidate[]
): IntentExtractor {
  return new FailoverIntentExtractor(candidates);
}

let registered: IntentExtractor | null = null;

export function registerIntentExtractor(extractor: IntentExtractor): void {
  registered = extractor;
}

export function getIntentExtractor(): IntentExtractor {
  return registered ?? stubIntentExtractor;
}

export function resetIntentExtractor(): void {
  registered = null;
}

function summarizeGoal(text: string): string {
  const firstLine = text
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean)[0] ?? text.trim();
  if (firstLine.length <= 200) return firstLine;
  return `${firstLine.slice(0, 197)}...`;
}

/**
 * Deterministic fallback extractor. Uses the first non-empty line as the
 * goal and harvests simple stakeholder @-mentions. No LLM needed; good
 * enough for "something changed" drift detection.
 */
export const stubIntentExtractor: IntentExtractor = {
  name: 'stub',

  async extract(input) {
    if (!input.text || input.text.trim() === '') {
      logger.warn('[intent-extractor:stub] empty text — returning placeholder goal');
      return { goal: '(no utterance)' };
    }
    const stakeholders = Array.from(
      new Set(
        (input.text.match(/@[A-Za-z0-9_\-.]+/gu) ?? []).map((m) => m.slice(1)),
      ),
    );
    const body: IntentBody = { goal: summarizeGoal(input.text) };
    if (stakeholders.length > 0) body.stakeholders = stakeholders;
    return body;
  },
};
