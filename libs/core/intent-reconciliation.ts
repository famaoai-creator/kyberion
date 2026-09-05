import {
  getReasoningBackend,
  getStubServedOps,
  stubExplicitlyRequested,
} from './reasoning-backend.js';
import { logger } from './core.js';
import { recordReasoningTierDeclaration } from './reasoning-tier-declaration.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { clamp, readTextFile } from './foundation/text.js';
import {
  buildCompletionNextAction,
  type CompletionGoal,
  type CompletionReconciliation,
} from './next-action.js';

export interface IntentReconciliationInput {
  goal: CompletionGoal;
  evidenceRefs?: string[];
  artifactRefs?: string[];
  evidenceTexts?: string[];
  requestedResult?: string;
}

export interface IntentReconciliationOptions {
  /**
   * SO-05: declared model tier for the LLM tightening pass below (mirrors
   * `LlmCompileOptions.model_tier` in intent-contract.ts). Completion
   * reconciliation is an orchestrator-judgment call, not a conversation-front
   * call, so callers that own that judgment (mission-lifecycle.ts's finish
   * path, the mission-steering finish verb) should pass `'deep'`. Omitted for
   * backward compatibility: existing callers that don't pass this see no
   * behavior change (no `model_tier` is threaded into the backend call at
   * all, exactly as before this option existed).
   */
  model_tier?: 'fast' | 'standard' | 'deep';
}

function normalizeReconciliationText(value: string): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeForMatch(value: string): string {
  return normalizeReconciliationText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function splitGoalSegments(successCondition: string): string[] {
  return normalizeReconciliationText(successCondition)
    .split(/(?:\n|;|、|・)+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function tokenize(text: string): string[] {
  const stopwords = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'to',
    'of',
    'and',
    'or',
    'for',
    'with',
    'in',
    'on',
    'at',
    'by',
    'from',
    'this',
    'that',
    'it',
    'as',
    'into',
    'about',
    'saved',
    'save',
    'saved',
    'complete',
    'completed',
    'completion',
    'note',
    'result',
  ]);
  return (
    normalizeReconciliationText(text)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length >= 2 && !stopwords.has(token)) || []
  );
}

function normalizeTokens(text: string): Set<string> {
  return new Set(tokenize(text));
}

const BINARY_EVIDENCE_EXTENSIONS = new Set([
  '.docx',
  '.xlsx',
  '.pptx',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.zip',
  '.gz',
  '.tar',
  '.mp3',
  '.wav',
  '.mp4',
  '.mov',
]);

function segmentMatchesEvidence(segment: string, evidenceText: string): boolean {
  if (!segment || !evidenceText) return false;
  if (evidenceText.includes(segment)) return true;
  if (normalizeForMatch(evidenceText).includes(normalizeForMatch(segment))) return true;
  const segmentTokens = tokenize(segment);
  if (segmentTokens.length === 0) return false;
  const evidenceTokens = normalizeTokens(evidenceText);
  if (segmentTokens.length === 1) {
    return evidenceTokens.has(segmentTokens[0]);
  }
  return segmentTokens.every((token) => evidenceTokens.has(token));
}

function readEvidenceText(ref: string): string {
  const normalizedRef = String(ref || '').trim();
  if (!normalizedRef) return '';
  let safeRef: string;
  try {
    safeRef = assertSafeRepositoryPath(normalizedRef, { allowMissingLeaf: true });
  } catch {
    return '';
  }
  if (!safeExistsSync(safeRef)) return '';
  if (!safeLstat(safeRef).isFile()) return '';
  const dotIndex = normalizedRef.lastIndexOf('.');
  if (dotIndex >= 0) {
    const ext = normalizedRef.slice(dotIndex).toLowerCase();
    if (BINARY_EVIDENCE_EXTENSIONS.has(ext)) return '';
  }
  try {
    return normalizeReconciliationText(readTextFile(safeRef));
  } catch {
    return '';
  }
}

function collectEvidenceBundle(
  input: IntentReconciliationInput
): Array<{ ref: string; text: string }> {
  const pathRefs = Array.from(
    new Set(
      [...(input.evidenceRefs || []), ...(input.artifactRefs || [])]
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
    )
  );
  const previewRefs = (input.evidenceTexts || [])
    .map((entry) => normalizeReconciliationText(entry))
    .filter(Boolean)
    .map((text) => ({ ref: 'preview_text', text }));
  const bundle = [
    ...pathRefs.map((ref) => ({
      ref,
      text: readEvidenceText(ref),
    })),
    ...previewRefs,
  ];
  return Array.from(new Map(bundle.map((entry) => [`${entry.ref}:${entry.text}`, entry])).values());
}

function structuralReconcile(input: IntentReconciliationInput): CompletionReconciliation {
  const evidenceBundle = collectEvidenceBundle(input);
  const evidenceText = [...evidenceBundle.map((entry) => entry.text)].join('\n');
  const goalSummary = normalizeReconciliationText(input.goal.summary);
  const successCondition = normalizeReconciliationText(
    input.goal.success_condition || input.goal.summary
  );
  const segments = splitGoalSegments(successCondition || goalSummary);

  const delivered = new Set<string>();
  const gaps: string[] = [];

  if (goalSummary && evidenceText.includes(goalSummary)) {
    delivered.add(goalSummary);
  }

  for (const segment of segments) {
    const matched = evidenceBundle.find((entry) => {
      return segmentMatchesEvidence(segment, entry.text);
    });
    if (matched) {
      delivered.add(matched.ref);
      continue;
    }
    if (segment) gaps.push(segment);
  }

  const satisfied = segments.length > 0 ? gaps.length === 0 : delivered.size > 0;
  const confidence = satisfied
    ? 0.92
    : delivered.size > 0
      ? 0.62
      : segments.length > 0
        ? 0.28
        : 0.15;

  return {
    satisfied,
    delivered: Array.from(delivered),
    gaps: Array.from(new Set(gaps)),
    confidence,
    evidence_refs: evidenceBundle.map((entry) => entry.ref),
  };
}

/**
 * LC-07 (LOOP_CLOSURE_PLAN): completion may not be declared on judgments a
 * fabricated stub brain produced. When any reasoning op in this process was
 * answered by the unconfigured stub backend, force satisfied=false with an
 * explicit gap so the goal loop (IL-04) surfaces it instead of shipping a
 * false success. Explicit stub mode (deterministic tests) is exempt.
 */
function applyStubTaintGate(reconciliation: CompletionReconciliation): CompletionReconciliation {
  if (stubExplicitlyRequested()) return reconciliation;
  const served = getStubServedOps();
  if (served.length === 0) return reconciliation;
  const ops = Array.from(new Set(served.map((entry) => entry.op)))
    .slice(0, 6)
    .join(', ');
  const gap = `reasoning_stub_served: ${served.length} reasoning op(s) [${ops}] were answered by the unconfigured stub backend — run \`pnpm reasoning:setup\` and re-run`;
  logger.warn(`[intent-reconciliation] completion blocked by stub taint (${served.length} op(s))`);
  return {
    ...reconciliation,
    satisfied: false,
    gaps: reconciliation.gaps.includes(gap) ? reconciliation.gaps : [...reconciliation.gaps, gap],
    confidence: Math.min(reconciliation.confidence, 0.2),
  };
}

export function reconcileCompletionStructurally(
  input: IntentReconciliationInput
): CompletionReconciliation {
  return applyStubTaintGate(structuralReconcile(input));
}

export async function reconcileCompletion(
  input: IntentReconciliationInput,
  options?: IntentReconciliationOptions
): Promise<CompletionReconciliation> {
  const structural = reconcileCompletionStructurally(input);
  if (structural.satisfied || getReasoningBackend().name === 'stub') {
    return structural;
  }

  try {
    const backend = getReasoningBackend();
    const prompt = [
      'You are validating whether a completed mission truly satisfies the goal.',
      'Return strict JSON with keys satisfied, delivered, gaps, confidence.',
      `Goal summary: ${input.goal.summary}`,
      `Success condition: ${input.goal.success_condition}`,
      `Requested result: ${input.requestedResult || input.goal.summary}`,
      `Evidence refs: ${JSON.stringify(structural.evidence_refs)}`,
      `Delivered evidence: ${JSON.stringify(structural.delivered)}`,
      `Current gaps: ${JSON.stringify(structural.gaps)}`,
      'If the evidence is insufficient, keep satisfied=false and keep the gaps concise.',
    ].join('\n');
    if (options?.model_tier) {
      recordReasoningTierDeclaration({
        callSite: 'intent_reconciliation_llm_tighten',
        declaredTier: options.model_tier,
      });
    }
    const raw = await backend.prompt(
      prompt,
      options?.model_tier ? { model_tier: options.model_tier } : undefined
    );
    const parsed = parseSafeJsonInput(
      raw,
      'completion reconciliation response'
    ) as Partial<CompletionReconciliation>;
    const confidence =
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? clamp(parsed.confidence, 0, 1)
        : structural.confidence;
    return {
      satisfied: structural.satisfied,
      delivered: structural.delivered,
      gaps: structural.gaps,
      confidence: Math.min(structural.confidence, confidence),
      evidence_refs: structural.evidence_refs,
    };
  } catch {
    return structural;
  }
}

export function buildCompletionSummary(input: IntentReconciliationInput): Promise<{
  reconciliation: CompletionReconciliation;
  next_action: ReturnType<typeof buildCompletionNextAction>;
}> {
  return reconcileCompletion(input).then((reconciliation) => ({
    reconciliation,
    next_action: buildCompletionNextAction({
      goal: input.goal,
      reconciliation,
    }),
  }));
}
