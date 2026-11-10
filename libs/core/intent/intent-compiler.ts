/**
 * Intent Compiler
 * Compiles natural language intent into pipeline steps.
 * Uses knowledge hints + standard intents as context for LLM generation.
 */
import { logger } from '../core.js';
import type { RoutingDecision } from '../contracts/routing-decision.js';
import { loadStandardIntentCatalog, type IntentResolutionPacket } from './intent-resolution.js';
import { resolveRoutingPacket } from './intent-resolver-entry.js';
import { segmentKeywordTerms } from '../foundation/locale-normalize.js';

/**
 * Whether a knowledge hint's topic or tags contain any intent keyword.
 * Locale-aware: a spaceless Japanese intent is segmented into content words
 * (particles dropped) instead of being one sentence-long "word" that no
 * topic or tag can ever contain.
 */
function hintMatchesIntent(
  hint: { topic?: string; tags?: string[] },
  intentLower: string
): boolean {
  const words = segmentKeywordTerms(intentLower);
  return words.some(
    (w) =>
      (hint.topic || '').toLowerCase().includes(w) ||
      (hint.tags || []).some((t: string) => t.toLowerCase().includes(w))
  );
}

export interface CompiledIntent {
  intentId: string;
  confidence: number; // 0-1
  source: 'template' | 'llm' | 'hint';
  steps: any[];
  explanation: string;
  warnings?: string[];
}

function synthesizeDeterministicSteps(intentDef: any): any[] {
  const pipeline = intentDef?.pipeline;
  if (Array.isArray(pipeline) && pipeline.length > 0) return pipeline;
  return [];
}

/**
 * Attempt to compile a natural language intent into pipeline steps.
 *
 * Resolution order:
 * 1. The request's resolved intent (carried RoutingDecision, else the resolver
 *    entry) has a pipeline in standard-intents.json → template
 * 2. Knowledge hint match → returns hints as context, confidence 0.6
 * 3. Returns null if no match (caller should use LLM with the returned context)
 *
 * The keyword fallback over a caller-supplied catalog was removed in R3 of the
 * intent resolver unification plan: intent selection belongs to the resolver.
 */
export function compileIntent(
  intent: string,
  options?: {
    knowledgeHints?: any[];
    /**
     * The request's carried RoutingDecision (D7). When present the compiler
     * acts on it instead of re-resolving `intent`; the caller guarantees it
     * belongs to this request.
     */
    routingDecision?: RoutingDecision;
  }
): CompiledIntent | null {
  // Catalog entries may carry the legacy `{ pipeline: { steps } }` form.
  const standardIntents: any[] = loadStandardIntentCatalog();
  const carried = options?.routingDecision;
  const resolutionPacket: Pick<
    IntentResolutionPacket,
    'selected_intent_id' | 'selected_confidence'
  > = carried
    ? { selected_intent_id: carried.intent_id, selected_confidence: carried.confidence }
    : resolveRoutingPacket(intent);

  const intentLower = intent.toLowerCase();

  // 1. The resolved intent's catalog pipeline.
  const exactMatch = resolutionPacket.selected_intent_id
    ? standardIntents.find((si) => si.id === resolutionPacket.selected_intent_id)
    : undefined;
  if (exactMatch) {
    const steps = exactMatch.pipeline
      ? exactMatch.pipeline.steps || exactMatch.pipeline
      : synthesizeDeterministicSteps(exactMatch);
    if (!steps.length) return null;
    logger.info(`[INTENT_COMPILER] Exact match: ${exactMatch.id}`);
    return {
      intentId: exactMatch.id,
      confidence: resolutionPacket.selected_confidence ?? 1.0,
      source: 'template',
      steps,
      explanation: `Exact match: ${exactMatch.id}`,
    };
  }

  // 2. Knowledge hint match.
  const hints = options?.knowledgeHints || [];
  const matchedHints = hints.filter((h: any) => hintMatchesIntent(h, intentLower));
  if (matchedHints.length > 0) {
    logger.info(`[INTENT_COMPILER] Found ${matchedHints.length} knowledge hints`);
    return {
      intentId: `hint-${Date.now()}`,
      confidence: 0.6,
      source: 'hint',
      steps: [], // No steps generated - caller should use LLM with these hints
      explanation: `Found ${matchedHints.length} knowledge hints. Use LLM to generate pipeline steps.`,
      warnings: ['No pre-defined pipeline. Hints available for LLM-based generation.'],
    };
  }

  // 3. No match
  return null;
}

/**
 * Resolve an intent to pipeline steps directly.
 * Wraps compileIntent() but returns steps array, throwing if no match found.
 * This provides backward compatibility with resolver.ts behavior.
 */
export function resolveIntentToSteps(intent: string, knowledgeHints?: any[]): any[] {
  const result = compileIntent(intent, { knowledgeHints });
  if (!result || result.steps.length === 0) {
    throw new Error(`Intent not resolved: ${intent}`);
  }
  return result.steps;
}

/**
 * Build a prompt for LLM-based pipeline generation
 * Returns a structured prompt that can be sent to Claude/other LLM
 */
export function buildPipelineGenerationPrompt(
  intent: string,
  hints: any[],
  availableActuators?: string[]
): string {
  let prompt = `Generate a Kyberion pipeline ADF (JSON) for the following intent:\n\n"${intent}"\n\n`;

  if (hints.length > 0) {
    prompt += `## Relevant Knowledge Hints\n\n`;
    for (const h of hints) {
      prompt += `- **${h.topic}**: ${h.hint}\n`;
      if (h.tags) prompt += `  Tags: ${h.tags.join(', ')}\n`;
    }
    prompt += '\n';
  }

  if (availableActuators) {
    prompt += `## Available Actuators\n${availableActuators.join(', ')}\n\n`;
  }

  prompt += `## Output Format
Return a valid JSON object with:
- "action": "pipeline"
- "steps": array of { "id": string, "type": "capture"|"transform"|"apply"|"control", "op": string, "params": {} }

Use "ref" op to reference existing sub-pipelines in pipelines/fragments/ when available.
Include "on_error" with "strategy": "skip" for non-critical steps.`;

  return prompt;
}
