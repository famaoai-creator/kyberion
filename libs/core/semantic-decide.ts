import { createLogger } from './logger.js';
import { tryRepairJson } from './json-repair.js';

// AR-07: in-loop semantic decision primitive. Deterministic ops distill an
// observation (DOM inventory, UI tree, log tail); this helper asks the
// reasoning backend for ONE decision about it. Selection is preferred over
// generation: when `options` are provided, any reply outside the list is
// rejected and the caller falls back deterministically. A null return must
// never fail a pipeline — callers keep their legacy path.

const logger = createLogger('semantic-decide');

export interface DecideFromObservationInput {
  /** What the caller needs decided, e.g. "pick the selector for the submit button". */
  goal: string;
  /** Distilled observation (already size-capped by the producing op). */
  observation: string;
  /** When present, the decision MUST be one of these values (selection mode). */
  options?: string[];
  /** Extra instruction appended to the prompt (output shape hints etc.). */
  guidance?: string;
  /** Injectable for tests / stub environments. */
  generate?: (prompt: string) => Promise<string>;
}

export interface SemanticDecision {
  decision: string;
  reason?: string;
}

const OBSERVATION_CAP = 12000;

export async function decideFromObservation(
  input: DecideFromObservationInput
): Promise<SemanticDecision | null> {
  const selection = Array.isArray(input.options) && input.options.length > 0;
  if (selection && input.options!.length === 1) {
    return { decision: input.options![0], reason: 'only candidate' };
  }
  const prompt = [
    'You are a precise automation assistant making ONE decision inside a running pipeline.',
    `Goal: ${input.goal}`,
    'Observation:',
    input.observation.slice(0, OBSERVATION_CAP),
    '',
    selection
      ? `Pick exactly one of these options (verbatim):\n${input.options!.map((option) => `- ${option}`).join('\n')}`
      : 'Answer concisely.',
    input.guidance ?? '',
    'Reply with ONLY a JSON object: { "decision": string, "reason": string }',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const generate =
      input.generate ??
      (async (p: string) => {
        const { getReasoningBackend } = await import('./reasoning-backend.js');
        return String(await getReasoningBackend().prompt(p));
      });
    const raw = await generate(prompt);
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = tryRepairJson(jsonText);
    }
    const decision = String(parsed?.decision ?? '').trim();
    if (!decision) return null;
    if (selection && !input.options!.includes(decision)) {
      logger.warn(
        `decision "${decision.slice(0, 80)}" is not among the offered options — rejected`
      );
      return null;
    }
    return {
      decision,
      ...(parsed?.reason ? { reason: String(parsed.reason).slice(0, 300) } : {}),
    };
  } catch (error: any) {
    logger.warn(`decideFromObservation failed (caller falls back): ${error?.message || error}`);
    return null;
  }
}
