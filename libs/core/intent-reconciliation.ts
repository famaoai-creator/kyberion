import { getReasoningBackend } from './reasoning-backend.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import {
  buildCompletionNextAction,
  type CompletionGoal,
  type CompletionReconciliation,
} from './next-action.js';

export interface IntentReconciliationInput {
  goal: CompletionGoal;
  evidenceRefs?: string[];
  artifactRefs?: string[];
  requestedResult?: string;
}

function normalizeText(value: string): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeForMatch(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function splitGoalSegments(successCondition: string): string[] {
  return normalizeText(successCondition)
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
    normalizeText(text)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length >= 2 && !stopwords.has(token)) || []
  );
}

function segmentMatchesEvidence(segment: string, evidenceText: string): boolean {
  if (!segment || !evidenceText) return false;
  if (evidenceText.includes(segment)) return true;
  if (normalizeForMatch(evidenceText).includes(normalizeForMatch(segment))) return true;
  const segmentTokens = tokenize(segment);
  if (segmentTokens.length === 0) return false;
  const evidenceTokens = new Set(tokenize(evidenceText));
  return segmentTokens.some((token) => evidenceTokens.has(token));
}

function readEvidenceText(ref: string): string {
  const normalizedRef = String(ref || '').trim();
  if (!normalizedRef || !safeExistsSync(normalizedRef)) return '';
  try {
    return normalizeText(String(safeReadFile(normalizedRef, { encoding: 'utf8' }) || ''));
  } catch {
    return '';
  }
}

function collectEvidenceBundle(
  input: IntentReconciliationInput
): Array<{ ref: string; text: string }> {
  const refs = Array.from(
    new Set(
      [...(input.evidenceRefs || []), ...(input.artifactRefs || [])]
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
    )
  );
  return refs.map((ref) => ({ ref, text: readEvidenceText(ref) || normalizeText(ref) }));
}

function structuralReconcile(input: IntentReconciliationInput): CompletionReconciliation {
  const evidenceBundle = collectEvidenceBundle(input);
  const evidenceText = evidenceBundle.map((entry) => entry.text).join('\n');
  const goalSummary = normalizeText(input.goal.summary);
  const successCondition = normalizeText(input.goal.success_condition || input.goal.summary);
  const segments = splitGoalSegments(successCondition || goalSummary);

  const delivered = new Set<string>();
  const gaps: string[] = [];

  if (goalSummary && evidenceText.includes(goalSummary)) {
    delivered.add(goalSummary);
  }

  for (const segment of segments) {
    const matched = evidenceBundle.find((entry) => {
      if (entry.ref.includes(segment)) return true;
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

export function reconcileCompletionStructurally(
  input: IntentReconciliationInput
): CompletionReconciliation {
  return structuralReconcile(input);
}

export async function reconcileCompletion(
  input: IntentReconciliationInput
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
    const raw = await backend.prompt(prompt);
    const parsed = JSON.parse(raw) as Partial<CompletionReconciliation>;
    const delivered = Array.isArray(parsed.delivered)
      ? parsed.delivered.map((entry) => String(entry).trim()).filter(Boolean)
      : structural.delivered;
    const gaps = Array.isArray(parsed.gaps)
      ? parsed.gaps.map((entry) => String(entry).trim()).filter(Boolean)
      : structural.gaps;
    const confidence =
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : structural.confidence;
    return {
      satisfied: typeof parsed.satisfied === 'boolean' ? parsed.satisfied : structural.satisfied,
      delivered,
      gaps,
      confidence,
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
