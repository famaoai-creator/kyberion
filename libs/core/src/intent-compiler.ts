/**
 * Intent Compiler
 * Compiles natural language intent into pipeline steps.
 * Uses knowledge hints + standard intents as context for LLM generation.
 */
import { logger } from '../core.js';
import { safeReadFile, safeExistsSync } from '../secure-io.js';
import * as path from 'node:path';

export interface CompiledIntent {
  intentId: string;
  confidence: number;          // 0-1
  source: 'template' | 'llm' | 'hint';
  steps: any[];
  explanation: string;
  warnings?: string[];
}

/**
 * Attempt to compile a natural language intent into pipeline steps.
 *
 * Resolution order:
 * 1. Exact match in standard-intents.json → confidence 1.0
 * 2. Keyword match in standard-intents.json → confidence 0.8
 * 3. Knowledge hint match → returns hints as context, confidence 0.6
 * 4. Returns null if no match (caller should use LLM with the returned context)
 */
export function compileIntent(
  intent: string,
  options?: { knowledgeHints?: any[]; standardIntents?: any[] }
): CompiledIntent | null {
  const intentsPath = path.resolve(process.cwd(), 'knowledge/public/governance/standard-intents.json');
  let standardIntents: any[] = options?.standardIntents || [];

  if (standardIntents.length === 0 && safeExistsSync(intentsPath)) {
    try {
      const raw = safeReadFile(intentsPath, { encoding: 'utf8' }) as string;
      const parsed = JSON.parse(raw);
      standardIntents = Array.isArray(parsed) ? parsed : (parsed.intents || []);
    } catch { /* ignore */ }
  }

  const intentLower = intent.toLowerCase();

  // 1. Exact ID match
  const exactMatch = standardIntents.find(si => si.id === intent || si.id === intentLower);
  if (exactMatch && exactMatch.pipeline) {
    logger.info(`[INTENT_COMPILER] Exact match: ${exactMatch.id}`);
    return {
      intentId: exactMatch.id,
      confidence: 1.0,
      source: 'template',
      steps: exactMatch.pipeline.steps || exactMatch.pipeline,
      explanation: `Exact match: ${exactMatch.id}`,
    };
  }

  // 2. Keyword match
  for (const si of standardIntents) {
    const triggers: string[] = si.triggers || si.trigger_keywords || si.keywords || [];
    const matched = triggers.some((t: string) => intentLower.includes(t.toLowerCase()));
    if (matched && si.pipeline) {
      logger.info(`[INTENT_COMPILER] Keyword match: ${si.id}`);
      return {
        intentId: si.id,
        confidence: 0.8,
        source: 'template',
        steps: si.pipeline.steps || si.pipeline,
        explanation: `Keyword match: ${si.id} (trigger: ${triggers.join(', ')})`,
      };
    }
  }

  // 3. Knowledge hint match
  const hints = options?.knowledgeHints || [];
  const matchedHints = hints.filter((h: any) => {
    const words = intentLower.split(/\s+/);
    return words.some(w => (h.topic || '').toLowerCase().includes(w) ||
                          (h.tags || []).some((t: string) => t.toLowerCase().includes(w)));
  });

  if (matchedHints.length > 0) {
    logger.info(`[INTENT_COMPILER] Found ${matchedHints.length} knowledge hints`);
    return {
      intentId: `hint-${Date.now()}`,
      confidence: 0.6,
      source: 'hint',
      steps: [],   // No steps generated - caller should use LLM with these hints
      explanation: `Found ${matchedHints.length} knowledge hints. Use LLM to generate pipeline steps.`,
      warnings: ['No pre-defined pipeline. Hints available for LLM-based generation.'],
    };
  }

  // 4. No match
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
